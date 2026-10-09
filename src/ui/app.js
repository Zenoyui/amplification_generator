// Page controller: state, sections, jobs

import { TEMPLATES, findTemplate, templateDefaults, buildModel, featureSpecs, availableFeatureKinds, ADDED_VOLUME_REFUSE } from '../geometry/model.js';
import { resolveParams, defaultsOf } from '../geometry/params.js';
import { MATERIALS, findMaterial, checkMaterial } from '../fea/materials.js';
import { QUALITY, DIRECTIONS, directionVector, estimateSolidVolume } from '../fea/analysis.js';
import { parseQuantity, DIM, STANDARD_GRAVITY_MPS2, SiError, Quantity } from '../si/units.js';
import { startJob } from '../workers/client.js';
import { summarize } from '../report/summary.js';
import { resultField } from '../report/fields.js';
import { el } from './dom.js';
import { TEXT } from './text.js';
import { inputRow, selectRow, checkRow, radioList } from './forms.js';
import { renderResult } from './results.js';
import { Viewport } from './viewport.js';
import { formatNumber } from './format.js';

const REBUILD_DELAY_MS = 150;
const DEFAULT_REQUIRED_SAFETY = 1.5;
const DEFAULT_MASS_TEXT = '50 кг';
const CUSTOM_PRESET = 'custom';

const parseDecimal = (text) => Number(String(text).trim().replace(',', '.'));

export function startApp(documentRoot, viewportRoot) {
  const app = new App(documentRoot, viewportRoot);
  app.start();
  return app;
}

class App {
  constructor(documentRoot, viewportRoot) {
    this.documentRoot = documentRoot;
    this.viewport = new Viewport(viewportRoot, (hit) => this.#picked(hit));
    const first = TEMPLATES[0];
    this.state = {
      templateId: first.id,
      baseRaw: templateDefaults(first.id),
      materialId: 's235',
      custom: { kind: 'ductile', youngs: '200', poisson: '0.3', density: '7850', yield: '250', tensile: '400', compressive: '250' },
      massText: DEFAULT_MASS_TEXT,
      presetId: null,
      picked: null,
      direction: 'inward',
      selfWeight: true,
      patchText: '0',
      requiredText: String(DEFAULT_REQUIRED_SAFETY).replace('.', ','),
      quality: 'standard',
      features: [],
      nextFeatureId: 1,
      model: null,
      baseline: null,
      current: null,
      stale: false,
      fieldMode: 'mises',
    };
    this.baseRows = {};
    this.featureRows = {};
    this.jobs = { display: null, analysis: null };
    this.fitNext = true;
  }

  start() {
    this.#buildSections();
    this.#rebuildNow();
  }


  #buildSections() {
    const section = (id, title) => {
      const node = el('section', { id }, el('h2', {}, title));
      this.documentRoot.append(node);
      return node;
    };
    this.productSection = section('section-product', TEXT.sections.product);
    this.loadSection = section('section-load', TEXT.sections.load);
    this.runSection = section('section-run', TEXT.sections.run);
    this.resultSection = section('section-result', TEXT.sections.result);
    this.reinforcementSection = section('section-reinforcement', TEXT.sections.reinforcement);
    this.documentsSection = section('section-documents', TEXT.sections.documents);
    this.productBody = el('div');
    this.loadBody = el('div');
    this.runBody = el('div');
    this.resultBody = el('div');
    this.reinforcementBody = el('div');
    this.documentsBody = el('div');
    this.productSection.append(this.productBody);
    this.loadSection.append(this.loadBody);
    this.runSection.append(this.runBody);
    this.resultSection.append(this.resultBody);
    this.reinforcementSection.append(this.reinforcementBody);
    this.documentsSection.append(this.documentsBody);
    this.#renderProduct();
    this.#renderLoad();
    this.#renderRun();
    this.#renderResult();
    this.#renderReinforcement();
    this.#renderDocuments();
  }

  #renderProduct() {
    const body = this.productBody;
    body.replaceChildren();
    body.append(
      el('h3', {}, TEXT.product.kind),
      radioList({
        name: 'template',
        options: TEMPLATES.map((t) => ({ value: t.id, label: t.name })),
        selected: this.state.templateId,
        onChange: (id) => this.#changeTemplate(id),
      }),
      el('h3', {}, TEXT.product.sizes),
    );
    this.baseRows = {};
    for (const spec of findTemplate(this.state.templateId).params) {
      const row = inputRow({
        label: spec.label,
        unit: spec.unit,
        text: String(this.state.baseRaw[spec.key]).replace('.', ','),
        onInput: (text) => {
          this.state.baseRaw[spec.key] = parseDecimal(text);
          this.#scheduleRebuild();
        },
      });
      this.baseRows[spec.key] = row;
      body.append(row.row);
    }
    body.append(el('h3', {}, TEXT.product.material), this.#materialControls());
  }

  #materialControls() {
    const box = el('div');
    const options = [...MATERIALS.map((m) => ({ value: m.id, label: m.name })), { value: 'custom', label: TEXT.product.custom }];
    const select = selectRow({
      label: TEXT.product.material,
      options,
      selected: this.state.materialId,
      onChange: (choice) => {
        this.state.materialId = choice;
        this.#renderProduct();
        this.#markStale();
      },
    });
    box.append(select.row);
    if (this.state.materialId === 'custom') {
      const custom = this.state.custom;
      box.append(
        selectRow({
          label: TEXT.product.kindDuctile,
          options: [{ value: 'ductile', label: TEXT.product.ductile }, { value: 'brittle', label: TEXT.product.brittle }],
          selected: custom.kind,
          onChange: (choice) => {
            custom.kind = choice;
            this.#markStale();
          },
        }).row,
      );
      for (const [key, [label, unit]] of Object.entries(TEXT.product.customFields)) {
        box.append(inputRow({ label, unit, text: custom[key], onInput: (text) => { custom[key] = text; this.#markStale(); } }).row);
      }
    } else {
      const material = findMaterial(this.state.materialId);
      box.append(el('p', { class: 'hint' }, `${TEXT.product.source}: ${material.strengthSource}. ${material.elasticSource}.${material.estimates.length ? ` Оценочные значения: ${material.estimates.join(', ')}.` : ''}`));
    }
    return box;
  }

  #renderLoad() {
    const body = this.loadBody;
    body.replaceChildren();
    const model = this.state.model;
    body.append(
      inputRow({ label: TEXT.load.mass, unit: '', text: this.state.massText, wide: true, inputMode: 'text', hint: TEXT.load.massHint, onInput: (text) => { this.state.massText = text; this.#markStale(); } }).row,
    );
    const presets = model ? model.loadPresets.map((p) => ({ value: p.id, label: p.label })) : [];
    if (this.state.picked) presets.push({ value: CUSTOM_PRESET, label: TEXT.load.pickedPoint });
    this.pointSelect = selectRow({
      label: TEXT.load.point,
      options: presets,
      selected: this.state.presetId,
      onChange: (id) => {
        this.state.presetId = id;
        this.#updateLoadMarker();
        this.#markStale();
      },
    });
    this.pickButton = el('button', { type: 'button', onclick: () => this.#togglePick() }, TEXT.load.pickPoint);
    body.append(this.pointSelect.row, el('div', { class: 'row' }, this.pickButton));
    this.pickStatus = el('p', { class: 'hint', hidden: true }, TEXT.load.picking);
    body.append(this.pickStatus);
    body.append(
      selectRow({
        label: TEXT.load.direction,
        options: DIRECTIONS.map((d) => ({ value: d.id, label: d.label })),
        selected: this.state.direction,
        onChange: (choice) => {
          this.state.direction = choice;
          this.#updateLoadMarker();
          this.#markStale();
        },
      }).row,
      checkRow({ label: TEXT.load.selfWeight, checked: this.state.selfWeight, onChange: (v) => { this.state.selfWeight = v; this.#markStale(); } }).row,
      inputRow({ label: TEXT.load.patchRadius, unit: 'мм', text: this.state.patchText, hint: TEXT.load.patchHint, onInput: (text) => { this.state.patchText = text; this.#markStale(); } }).row,
      inputRow({ label: TEXT.load.required, unit: '', text: this.state.requiredText, onInput: (text) => { this.state.requiredText = text; this.#markStale(); } }).row,
    );
    this.supportLine = el('p', {}, '');
    body.append(el('h3', {}, TEXT.load.support), this.supportLine);
    this.#updateSupportLine();
  }

  #updateSupportLine() {
    if (!this.supportLine) return;
    const model = this.state.model;
    this.supportLine.textContent = model ? model.supports.map((s) => s.label).join('; ') : 'нет данных';
  }

  #renderRun() {
    const body = this.runBody;
    body.replaceChildren();
    body.append(
      selectRow({
        label: TEXT.run.quality,
        options: Object.entries(QUALITY).map(([id, q]) => ({ value: id, label: q.label })),
        selected: this.state.quality,
        onChange: (choice) => {
          this.state.quality = choice;
          this.#markStale();
        },
      }).row,
    );
    this.runButton = el('button', { type: 'button', class: 'primary', onclick: () => this.#runAnalysis() }, TEXT.run.start);
    this.cancelButton = el('button', { type: 'button', hidden: true, onclick: () => this.#cancelAnalysis() }, TEXT.run.cancel);
    this.statusLine = el('p', { class: 'status', 'aria-live': 'polite' });
    body.append(el('div', { class: 'row' }, this.runButton, this.cancelButton), this.statusLine);
  }

  #renderResult() {
    const body = this.resultBody;
    body.replaceChildren();
    const { current, stale } = this.state;
    if (!current) {
      body.append(el('p', { class: 'hint' }, TEXT.result.empty));
      this.resultSection.setAttribute('aria-disabled', 'true');
      this.reinforcementSection.setAttribute('aria-disabled', 'true');
      this.documentsSection.setAttribute('aria-disabled', 'true');
      return;
    }
    this.resultSection.removeAttribute('aria-disabled');
    this.reinforcementSection.removeAttribute('aria-disabled');
    this.documentsSection.removeAttribute('aria-disabled');
    if (stale) body.append(el('p', { class: 'verdict warn' }, TEXT.result.stale));
    body.append(
      el('h3', {}, TEXT.result.view),
      radioList({
        name: 'field',
        options: Object.entries(TEXT.result.modes).map(([id, label]) => ({ value: id, label })),
        selected: this.state.fieldMode,
        onChange: (mode) => {
          this.state.fieldMode = mode;
          this.#showField();
        },
      }),
    );
    const container = el('div');
    body.append(container);
    const baseline = this.state.baseline;
    const comparison = baseline && this.state.features.length > 0 && baseline !== current ? { before: baseline.summary, after: current.summary } : null;
    renderResult(container, current.summary, comparison);
  }

  #renderReinforcement() {
    const body = this.reinforcementBody;
    body.replaceChildren();
    const template = findTemplate(this.state.templateId);
    const kinds = availableFeatureKinds(this.state.templateId, this.state.features);
    const select = el('select', { 'aria-label': TEXT.reinforcement.choose }, kinds.map((k) => el('option', { value: k.kind }, k.name)));
    const addButton = el('button', { type: 'button', disabled: kinds.length === 0, onclick: () => this.#addFeature(select.value) }, TEXT.reinforcement.add);
    body.append(el('div', { class: 'row' }, select, addButton));
    this.featureRows = {};
    if (this.state.features.length === 0) body.append(el('p', { class: 'hint' }, TEXT.reinforcement.none));
    for (const feature of this.state.features) body.append(this.#featureCard(template, feature));
    this.addedLine = el('p', { class: 'hint' });
    body.append(this.addedLine);
    this.#updateAddedVolume();
  }

  #featureCard(template, feature) {
    const def = template.features[feature.kind];
    const card = el('div', { class: 'feature' });
    card.append(el('header', {}, el('span', {}, def.name), el('button', { type: 'button', onclick: () => this.#removeFeature(feature.id) }, TEXT.reinforcement.remove)));
    this.featureRows[feature.id] = { fields: {}, card, note: el('p', { class: 'field-error', hidden: true }) };
    const base = this.#resolvedBase();
    if (!base) return card;
    for (const spec of def.specs(base)) {
      if (spec.type === 'enum') {
        const row = selectRow({
          label: spec.label,
          options: spec.options,
          selected: feature.raw[spec.key],
          onChange: (choice) => {
            feature.raw[spec.key] = choice;
            this.#scheduleRebuild();
          },
        });
        card.append(row.row);
        continue;
      }
      const row = inputRow({
        label: spec.label,
        unit: spec.unit,
        text: String(feature.raw[spec.key]).replace('.', ','),
        onInput: (text) => {
          feature.raw[spec.key] = parseDecimal(text);
          this.#scheduleRebuild();
        },
      });
      this.featureRows[feature.id].fields[spec.key] = row;
      card.append(row.row);
    }
    card.append(this.featureRows[feature.id].note);
    return card;
  }

  #renderDocuments() {
    const body = this.documentsBody;
    body.replaceChildren();
    this.drawingsCheck = checkRow({ label: TEXT.documents.drawings, checked: true, onChange: () => {} });
    this.stlButton = el('button', { type: 'button', onclick: () => this.#downloadStl() }, TEXT.documents.stl);
    this.pdfButton = el('button', { type: 'button', class: 'primary', onclick: () => this.#downloadPdf() }, TEXT.documents.pdf);
    this.docStatus = el('p', { class: 'status', 'aria-live': 'polite' });
    body.append(el('div', { class: 'row' }, this.stlButton), this.drawingsCheck.row, el('div', { class: 'row' }, this.pdfButton), this.docStatus);
  }


  #resolvedBase() {
    const { parameters, errors } = resolveParams(findTemplate(this.state.templateId).params, this.state.baseRaw);
    return errors.length === 0 ? parameters : null;
  }

  #featureInputs() {
    return this.state.features.map((f) => ({ id: f.id, kind: f.kind, raw: f.raw }));
  }

  #spec() {
    return { templateId: this.state.templateId, base: { ...this.state.baseRaw }, features: this.#featureInputs() };
  }

  #scheduleRebuild() {
    clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => this.#rebuildNow(), REBUILD_DELAY_MS);
  }

  #rebuildNow() {
    const { model, errors } = buildModel(this.state.templateId, this.state.baseRaw, this.#featureInputs());
    for (const row of Object.values(this.baseRows)) row.setError('');
    for (const entry of Object.values(this.featureRows)) {
      entry.note.hidden = true;
      for (const row of Object.values(entry.fields)) row.setError('');
    }
    for (const error of errors) {
      if (error.scope === 'base' && this.baseRows[error.key]) this.baseRows[error.key].setError(error.message);
      else if (error.scope === 'base') this.#baseNote(`${error.label}: ${error.message}`);
      else if (this.featureRows[error.scope]) {
        const entry = this.featureRows[error.scope];
        if (entry.fields[error.key]) entry.fields[error.key].setError(error.message);
        else {
          entry.note.hidden = false;
          entry.note.textContent = `${error.label}: ${error.message}`;
        }
      }
    }
    this.runButton.disabled = !model;
    if (!model) return;
    this.state.model = model;
    this.viewport.setModel(model);
    if (!this.state.presetId || (this.state.presetId !== CUSTOM_PRESET && !model.loadPresets.some((p) => p.id === this.state.presetId))) {
      this.state.presetId = model.loadPresets[0].id;
      this.#renderLoad();
    }
    this.#updateSupportLine();
    this.#requestDisplay();
    this.#updateAddedVolume();
    this.#markStale();
  }

  #baseNote(text) {
    this.statusLine.textContent = text;
    this.statusLine.className = 'status fail';
  }

  #requestDisplay() {
    this.jobs.display?.cancel();
    const keepCamera = !this.fitNext;
    this.fitNext = false;
    const job = startJob('display', this.#spec());
    this.jobs.display = job;
    job.promise
      .then((display) => {
        if (this.jobs.display !== job) return;
        this.viewport.setDisplay(display, keepCamera);
        this.#updateLoadMarker();
        if (this.state.current && !this.state.stale) this.#showField();
      })
      .catch((error) => this.#fail(error));
  }

  #changeTemplate(id) {
    this.state.templateId = id;
    this.state.baseRaw = templateDefaults(id);
    this.state.features = [];
    this.state.presetId = null;
    this.state.picked = null;
    this.state.baseline = null;
    this.state.current = null;
    this.state.stale = false;
    this.fitNext = true;
    this.#renderProduct();
    this.#renderReinforcement();
    this.#rebuildNow();
    this.#renderLoad();
    this.#renderResult();
    this.viewport.clearField();
  }

  #markStale() {
    if (!this.state.current || this.state.stale) return;
    this.state.stale = true;
    this.viewport.clearField();
    this.#renderResult();
  }


  #currentLoadPoint() {
    const model = this.state.model;
    if (!model) return null;
    if (this.state.presetId === CUSTOM_PRESET && this.state.picked) return this.state.picked;
    const preset = model.loadPresets.find((p) => p.id === this.state.presetId) ?? model.loadPresets[0];
    return { point_m: preset.point_m, outwardNormal: preset.outwardNormal };
  }

  #updateLoadMarker() {
    const load = this.#currentLoadPoint();
    if (!load) return;
    this.viewport.setLoadMarker({ point_m: load.point_m, direction: directionVector(this.state.direction, load.outwardNormal) });
  }

  #togglePick() {
    const active = !this.viewport.pickMode;
    this.viewport.setPickMode(active);
    this.pickButton.classList.toggle('active', active);
    this.pickStatus.hidden = !active;
  }

  #picked(hit) {
    this.state.picked = hit;
    this.state.presetId = CUSTOM_PRESET;
    this.viewport.setPickMode(false);
    this.#renderLoad();
    this.#updateLoadMarker();
    this.#markStale();
  }


  #addFeature(kind) {
    const base = this.#resolvedBase();
    if (!base) return;
    const specs = featureSpecs(this.state.templateId, kind, base);
    this.state.features.push({ id: `f${this.state.nextFeatureId++}`, kind, raw: defaultsOf(specs) });
    this.#renderReinforcement();
    this.#rebuildNow();
  }

  #removeFeature(id) {
    this.state.features = this.state.features.filter((f) => f.id !== id);
    this.#renderReinforcement();
    this.#rebuildNow();
  }

  // Added volume share, estimated by sampling; refuses above ADDED_VOLUME_REFUSE
  #addedShare() {
    const model = this.state.model;
    if (!model || this.state.features.length === 0) return 0;
    const baseModel = buildModel(this.state.templateId, this.state.baseRaw, []).model;
    const withFeatures = estimateSolidVolume(model);
    const without = estimateSolidVolume(baseModel);
    return without > 0 ? withFeatures / without - 1 : 0;
  }

  #updateAddedVolume() {
    if (!this.addedLine) return;
    const share = this.#addedShare();
    this.addedLine.textContent = this.state.features.length ? `${TEXT.reinforcement.added}: ${formatNumber(share * 100, 3)} % (оценка по выборке точек)` : '';
    this.addedFraction = share;
  }


  #material() {
    if (this.state.materialId !== 'custom') return findMaterial(this.state.materialId);
    const c = this.state.custom;
    const material = {
      id: 'custom',
      name: TEXT.product.custom,
      kind: c.kind,
      youngs_pa: parseDecimal(c.youngs) * 1e9,
      poisson: parseDecimal(c.poisson),
      density_kgpm3: parseDecimal(c.density),
      yield_pa: parseDecimal(c.yield) * 1e6,
      tensile_pa: parseDecimal(c.tensile) * 1e6,
      compressive_pa: parseDecimal(c.compressive) * 1e6,
      strengthBasis: 'estimate',
      strengthSource: 'значения заданы вручную',
      elasticSource: 'значения заданы вручную',
      estimates: [],
    };
    if (material.kind === 'brittle') material.yield_pa = 0;
    const problems = checkMaterial(material);
    if (problems.length) throw new Error(`material: ${problems.join('; ')}`);
    return material;
  }

  #loadSetup() {
    const quantity = parseQuantity(this.state.massText, 'kg');
    let magnitude_n;
    let massKg = null;
    if (quantity.dim.equals(DIM.MASS)) {
      massKg = quantity.in('kg');
      magnitude_n = massKg * STANDARD_GRAVITY_MPS2;
    } else if (quantity.dim.equals(DIM.FORCE)) {
      magnitude_n = quantity.in('N');
    } else {
      throw new SiError(`unit mismatch (want=mass or force, got=${quantity.dim})`);
    }
    if (!(magnitude_n > 0)) throw new Error('load: value must be above zero');
    const radius = parseDecimal(this.state.patchText);
    if (!Number.isFinite(radius) || radius < 0) throw new Error('patch radius: number not below zero required');
    const point = this.#currentLoadPoint();
    return {
      presetId: this.state.presetId === CUSTOM_PRESET ? null : this.state.presetId,
      point_m: this.state.presetId === CUSTOM_PRESET ? point.point_m : undefined,
      direction: this.state.direction,
      magnitude_n,
      massKg,
      radius_m: radius > 0 ? Quantity.of(radius, 'mm').in('m') : null,
    };
  }

  #runAnalysis() {
    let setup;
    try {
      const material = this.#material();
      const required = parseDecimal(this.state.requiredText);
      if (!(required > 0)) throw new Error('required safety: number above zero required');
      if (this.addedFraction > ADDED_VOLUME_REFUSE) throw new Error(`reinforcement: added volume ${formatNumber(this.addedFraction * 100, 3)} % above the limit ${ADDED_VOLUME_REFUSE * 100} %`);
      setup = {
        material,
        selfWeight: this.state.selfWeight,
        requiredSafety: required,
        quality: this.state.quality,
        convergenceCheck: true,
        load: this.#loadSetup(),
      };
      this.setupSnapshot = { required, material, setup };
    } catch (error) {
      this.#setStatus(this.#explain(error), true);
      return;
    }
    const spec = this.#spec();
    this.runButton.disabled = true;
    this.cancelButton.hidden = false;
    const started = performance.now();
    this.#setStatus('Сетка', false);
    const job = startJob('analyze', { spec, setup }, (info) => this.#setStatus(this.#progressText(info), false));
    this.jobs.analysis = job;
    job.promise
      .then((analysis) => {
        if (this.jobs.analysis !== job) return;
        this.#analysisDone(analysis, spec, started);
      })
      .catch((error) => this.#fail(error))
      .finally(() => {
        if (this.jobs.analysis === job) this.jobs.analysis = null;
        this.runButton.disabled = false;
        this.cancelButton.hidden = true;
      });
  }

  #progressText(info) {
    const name = TEXT.run.stages[info.stage] ?? info.stage;
    if (info.iteration) return `${name}: итерация ${info.iteration}, невязка ${info.residual.toExponential(1).replace('.', ',')}`;
    return name;
  }

  #cancelAnalysis() {
    this.jobs.analysis?.cancel();
    this.jobs.analysis = null;
    this.runButton.disabled = false;
    this.cancelButton.hidden = true;
    this.#setStatus('Расчет прерван', false);
  }

  #analysisDone(analysis, spec, started) {
    const { required, material } = this.setupSnapshot;
    const summary = summarize(analysis, material, required);
    const record = { analysis, summary, material, required, spec, features: this.state.features.map((f) => ({ ...f, raw: { ...f.raw } })), setup: this.setupSnapshot.setup };
    this.state.current = record;
    if (this.state.features.length === 0) this.state.baseline = record;
    this.state.stale = false;
    this.#setStatus(`Расчет: ${formatNumber((performance.now() - started) / 1000, 3)} с, итераций ${analysis.solve.status.iterations}`, false);
    this.#renderResult();
    this.#showField();
    this.#updateLoadMarker();
    document.getElementById('section-result').scrollIntoView({ block: 'start' });
  }

  #showField() {
    const record = this.state.current;
    if (!record || this.state.stale) return;
    const field = resultField(record, this.state.fieldMode);
    this.viewport.showField(field.nodal, field.range, field.reversed, field.title, field.unit);
  }


  #downloadStl() {
    if (!this.state.model) return;
    this.docStatus.textContent = TEXT.documents.preparing;
    startJob('stl', this.#spec()).promise
      .then((out) => {
        saveBlob(new Blob([out.bytes], { type: 'model/stl' }), `${this.state.templateId}-${this.state.features.length ? 'reinforced' : 'base'}.stl`);
        const open = out.edges.open + out.edges.overshared;
        this.docStatus.textContent = `STL: ${out.triangleCount} треугольников, ячейка ${formatNumber(out.cell_m * 1000, 3)} мм, объем ${formatNumber(out.volume_m3 * 1e9, 4)} мм3${open > 0 ? `, ребер без пары: ${open}` : ''}`;
      })
      .catch((error) => this.#fail(error));
  }

  async #downloadPdf() {
    const record = this.state.current;
    if (!record || this.state.stale) {
      this.docStatus.textContent = TEXT.result.stale;
      return;
    }
    this.docStatus.textContent = TEXT.documents.preparing;
    try {
      const { buildReport } = await import('../report/document.js');
      const bytes = await buildReport({
        state: this.state,
        record,
        baseline: this.state.baseline,
        withDrawings: this.drawingsCheck.input.checked,
        viewport: this.viewport,
        onStatus: (text) => {
          this.docStatus.textContent = text;
        },
      });
      saveBlob(new Blob([bytes], { type: 'application/pdf' }), `raschet-${this.state.templateId}.pdf`);
      this.docStatus.textContent = `PDF: ${Math.round(bytes.length / 1024)} КБ`;
    } catch (error) {
      this.#fail(error);
    }
  }


  #setStatus(text, isError) {
    this.statusLine.textContent = text;
    this.statusLine.className = isError ? 'status fail' : 'status';
  }

  #explain(error) {
    const text = error.message;
    if (error.name === 'SiError') {
      if (/number expected/.test(text)) return 'Поле массы: требуется число и единица, например "50 кг".';
      if (/unit unknown/.test(text)) return 'Поле массы: единица не распознана. Допустимы кг, г, Н, кН, кгс.';
      if (/unit mismatch/.test(text)) return 'Поле массы: требуется масса или сила.';
    }
    if (/^material:/.test(text)) return `Материал: ${text.slice(10)}`;
    if (/^required safety/.test(text)) return 'Требуемый запас: число больше нуля.';
    if (/^patch radius/.test(text)) return 'Радиус площадки: число не меньше нуля.';
    if (/^load:/.test(text)) return 'Нагрузка: значение больше нуля.';
    if (/^reinforcement:/.test(text)) return 'Усиление добавляет более половины объема изделия. Уменьшить размеры усиления.';
    return text;
  }

  #fail(error) {
    const text = error.message;
    let message = text;
    if (/support: too few nodes/.test(text)) message = 'Закрепление не содержит узлов: уменьшить ячейку или изменить размеры.';
    else if (/thin feature/.test(text)) message = 'Элемент тоньше одной ячейки: выбрать качество выше или увеличить толщину.';
    else if (/load patch: too few surface nodes/.test(text)) message = 'Точка нагрузки не лежит на поверхности: указать точку на модели заново.';
    this.#setStatus(message, true);
    this.docStatus && (this.docStatus.textContent = '');
  }
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
