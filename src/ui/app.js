// Page controller: state, sections, jobs

import { TEMPLATES, findTemplate, templateDefaults, buildModel, modelOfSpec, featureSpecs, availableFeatureKinds, ADDED_VOLUME_REFUSE } from '../geometry/model.js';
import { UNITS } from '../geometry/upload.js';
import { digestHex } from '../report/fingerprint.js';
import { resolveParams, defaultsOf } from '../geometry/params.js';
import { MATERIALS, findMaterial, checkMaterial } from '../fea/materials.js';
import { QUALITY, DIRECTIONS, directionVector, estimateAddedShare, convergenceOf } from '../fea/analysis.js';
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
const UPLOAD_ID = 'upload';
const NEXT_QUALITY = { draft: 'standard', standard: 'fine' };
const FACES = ['x-', 'x+', 'y-', 'y+', 'z-', 'z+'];
// Default radius of a picked support area as a share of the longest model side
const AREA_RADIUS_SHARE = 0.06;

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
      upload: null,
      pickTarget: 'load',
      nextFeatureId: 1,
      model: null,
      baseline: null,
      current: null,
      stale: false,
      inputVersion: 0,
      fieldMode: 'mises',
    };
    this.baseRows = {};
    this.featureRows = {};
    this.jobs = { display: null, analysis: null, check: null, upload: null };
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
        options: [...TEMPLATES.map((t) => ({ value: t.id, label: t.name })), ...(this.state.upload?.prepared ? [{ value: UPLOAD_ID, label: `${TEXT.upload.template}: ${this.state.upload.name}` }] : [])],
        selected: this.state.templateId,
        onChange: (id) => this.#changeTemplate(id),
      }),
      this.#fileChooser(),
    );
    this.baseRows = {};
    if (this.state.templateId === UPLOAD_ID) {
      body.append(el('h3', {}, TEXT.upload.title), this.#uploadPanel(), el('h3', {}, TEXT.product.material), this.#materialControls());
      return;
    }
    body.append(el('h3', {}, TEXT.product.sizes));
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

  #fileChooser() {
    const input = el('input', { type: 'file', accept: '.stl,.STL', hidden: true, 'aria-label': TEXT.upload.choose });
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      this.state.upload = { name: file.name, buffer: await file.arrayBuffer(), unitId: 'mm', up: 'z', prepared: null, hash: null, face: 'z-', supportMode: 'face', area: null, areaRadiusText: '', message: TEXT.upload.busy };
      this.#processUpload();
      this.#renderProduct();
    });
    const button = el('button', { type: 'button', onclick: () => input.click() }, this.state.upload ? TEXT.upload.replace : TEXT.upload.choose);
    return el('div', { class: 'upload-choice' }, el('div', { class: 'row' }, button, input), el('p', { class: 'hint' }, TEXT.upload.hint));
  }

  #processUpload() {
    const upload = this.state.upload;
    const unit = UNITS.find((u) => u.id === upload.unitId);
    upload.message = TEXT.upload.busy;
    this.jobs.upload?.cancel();
    const job = startJob('upload', { buffer: upload.buffer.slice(0), scale_m: unit.scale_m, up: upload.up });
    this.jobs.upload = job;
    job.promise
      .then(async (prepared) => {
        if (this.jobs.upload !== job) return;
        upload.prepared = prepared;
        upload.message = '';
        upload.hash = (await digestHex(new Uint8Array(prepared.mesh.positions.buffer.slice(0)))).hex;
        const longest_mm = Math.max(...prepared.bounds_m.max) * 1000;
        upload.areaRadiusText = String(Math.max(1, Math.round(AREA_RADIUS_SHARE * longest_mm)));
        upload.area = null;
        if (this.state.templateId !== UPLOAD_ID) this.#changeTemplate(UPLOAD_ID);
        else this.#afterUploadChange();
      })
      .catch((error) => {
        if (this.jobs.upload !== job) return;
        upload.prepared = null;
        upload.message = this.#uploadMessage(error);
        this.#renderProduct();
      });
  }

  #uploadMessage(error) {
    const code = /^([a-z]+):/.exec(error.message)?.[1];
    const text = TEXT.upload.errors[code];
    return text ? `${text} (${error.message})` : error.message;
  }

  #afterUploadChange() {
    this.state.baseline = null;
    this.state.presetId = null;
    this.#renderProduct();
    this.#renderLoad();
    this.#rebuildNow();
    this.#renderReinforcement();
    this.fitNext = true;
  }

  #uploadPanel() {
    const upload = this.state.upload;
    const box = el('div');
    box.append(
      selectRow({
        label: TEXT.upload.unit,
        options: UNITS.map((u) => ({ value: u.id, label: u.label })),
        selected: upload.unitId,
        onChange: (choice) => {
          upload.unitId = choice;
          this.#processUpload();
          this.#markStale();
        },
      }).row,
      selectRow({
        label: TEXT.upload.up,
        options: [{ value: 'z', label: 'Z' }, { value: 'y', label: 'Y' }],
        selected: upload.up,
        onChange: (choice) => {
          upload.up = choice;
          this.#processUpload();
          this.#markStale();
        },
      }).row,
    );
    if (upload.message) box.append(el('p', { class: upload.prepared ? 'hint' : 'status fail' }, upload.message));
    if (upload.prepared) {
      const { report, thickness_m } = upload.prepared;
      const rows = [
        [TEXT.upload.size, `${report.size_m.map((v) => formatNumber(v * 1000, 4)).join(' x ')} мм`],
        [TEXT.upload.volume, `${formatNumber(report.volume_m3 * 1e6, 4)} см3`],
        [TEXT.upload.triangles, String(report.triangles)],
        [TEXT.upload.thickness, !Number.isFinite(thickness_m) ? 'нет данных' : `${formatNumber(thickness_m * 1000, 3)} мм`],
      ];
      box.append(el('table', {}, el('tbody', {}, rows.map(([name, text]) => el('tr', {}, el('th', {}, name), el('td', {}, text))))));
    }
    return box;
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
            this.#renderProduct();
          },
        }).row,
      );
      const unused = custom.kind === 'ductile' ? ['tensile', 'compressive'] : ['yield'];
      for (const [key, [label, unit]] of Object.entries(TEXT.product.customFields)) {
        if (unused.includes(key)) continue;
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
    this.pickButton = el('button', { type: 'button', onclick: () => this.#togglePick('load') }, TEXT.load.pickPoint);
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
    if (this.state.templateId === UPLOAD_ID && this.state.upload?.prepared) body.append(this.#supportControls());
    this.#updateSupportLine();
  }

  #supportControls() {
    const upload = this.state.upload;
    const size_m = upload.prepared.bounds_m.max;
    const faceLabel = (id) => `${id[0]} = ${formatNumber((id[1] === '-' ? 0 : size_m['xyz'.indexOf(id[0])]) * 1000, 4)} мм`;
    const options = [...FACES.map((id) => ({ value: id, label: `Плоскость ${faceLabel(id)}` })), ...(upload.area ? [{ value: 'area', label: TEXT.load.supportArea }] : [])];
    const box = el('div');
    box.append(
      selectRow({
        label: TEXT.load.supportFace,
        options,
        selected: upload.supportMode === 'area' && upload.area ? 'area' : upload.face,
        onChange: (choice) => {
          if (choice === 'area') upload.supportMode = 'area';
          else {
            upload.supportMode = 'face';
            upload.face = choice;
          }
          this.#rebuildNow();
          this.#renderLoad();
        },
      }).row,
      el('div', { class: 'row' }, el('button', { type: 'button', onclick: () => this.#togglePick('support') }, TEXT.load.pickSupport)),
      inputRow({ label: TEXT.load.supportRadius, unit: 'мм', text: upload.areaRadiusText, hint: TEXT.load.supportRadiusHint, onInput: (text) => { upload.areaRadiusText = text; this.#scheduleRebuild(); } }).row,
    );
    return box;
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
    const baseline = this.#validBaseline();
    const comparison = baseline ? { before: baseline.summary, after: current.summary } : null;
    renderResult(container, current.summary, comparison);
    const finer = NEXT_QUALITY[this.state.quality];
    if (current.summary.needsFinerMesh && finer && !stale) {
      container.append(el('button', { type: 'button', onclick: () => this.#runFiner(finer) }, `${TEXT.run.repeatWith} "${QUALITY[finer].label}"`));
    }
    if (current.features.length > 0 && !baseline) body.append(el('p', { class: 'hint' }, TEXT.result.noBaseline));
  }

  #renderReinforcement() {
    const body = this.reinforcementBody;
    body.replaceChildren();
    if (this.state.templateId === UPLOAD_ID) {
      body.append(el('p', { class: 'hint' }, TEXT.upload.noReinforcement));
      return;
    }
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
    if (this.state.templateId === UPLOAD_ID) return {};
    const { parameters, errors } = resolveParams(findTemplate(this.state.templateId).params, this.state.baseRaw);
    return errors.length === 0 ? parameters : null;
  }

  // Supports of an uploaded part from the state: a bounding box plane or a ball around a picked point
  #uploadSupports() {
    const upload = this.state.upload;
    const size_m = upload.prepared.bounds_m.max;
    if (upload.supportMode === 'area' && upload.area) {
      const radius_mm = parseDecimal(upload.areaRadiusText);
      const radius_m = Number.isFinite(radius_mm) && radius_mm > 0 ? radius_mm / 1000 : size_m[0] * AREA_RADIUS_SHARE;
      const point = upload.area.map((v) => formatNumber(v * 1000, 4)).join('; ');
      return [{ id: 'area', label: `Область радиусом ${formatNumber(radius_m * 1000, 3)} мм около точки (${point}) мм`, spec: { kind: 'sphere', center_m: upload.area, radius_m } }];
    }
    const axis = 'xyz'.indexOf(upload.face[0]);
    const coord_m = upload.face[1] === '-' ? 0 : size_m[axis];
    return [{ id: upload.face, label: `Плоскость ${upload.face[0]} = ${formatNumber(coord_m * 1000, 4)} мм`, spec: { kind: 'plane', axis, coord_m } }];
  }

  #uploadSpec() {
    const { name, prepared, hash } = this.state.upload;
    return { title: `${TEXT.upload.template} ${name}`, mesh: prepared.mesh, bounds_m: prepared.bounds_m, report: prepared.report, thickness_m: prepared.thickness_m, supports: this.#uploadSupports(), hash };
  }

  #featureInputs() {
    return this.state.features.map((f) => ({ id: f.id, kind: f.kind, raw: f.raw }));
  }

  #spec() {
    if (this.state.templateId === UPLOAD_ID) return { templateId: UPLOAD_ID, base: {}, features: [], upload: this.#uploadSpec() };
    return { templateId: this.state.templateId, base: { ...this.state.baseRaw }, features: this.#featureInputs() };
  }

  #scheduleRebuild() {
    clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => this.#rebuildNow(), REBUILD_DELAY_MS);
  }

  #rebuildNow() {
    const { model, errors } = modelOfSpec(this.#spec());
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
      this.state.presetId = model.loadPresets[0]?.id ?? (this.state.picked ? CUSTOM_PRESET : null);
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
    if (this.jobs.analysis) this.#cancelAnalysis();
    this.state.templateId = id;
    this.state.baseRaw = id === UPLOAD_ID ? {} : templateDefaults(id);
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
    this.state.inputVersion++;
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
    return preset ? { point_m: preset.point_m, outwardNormal: preset.outwardNormal } : null;
  }

  #updateLoadMarker() {
    const load = this.#currentLoadPoint();
    if (!load) return;
    this.viewport.setLoadMarker({ point_m: load.point_m, direction: directionVector(this.state.direction, load.outwardNormal) });
  }

  #togglePick(target) {
    const active = !this.viewport.pickMode || this.state.pickTarget !== target;
    this.state.pickTarget = target;
    this.viewport.setPickMode(active);
    this.pickButton.classList.toggle('active', active && target === 'load');
    this.pickStatus.hidden = !active;
  }

  #picked(hit) {
    if (this.state.pickTarget === 'support') {
      this.state.pickTarget = 'load';
      this.viewport.setPickMode(false);
      this.state.upload.area = hit.point_m;
      this.state.upload.supportMode = 'area';
      this.#renderLoad();
      this.#rebuildNow();
      return;
    }
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
    return estimateAddedShare(model, baseModel);
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
    else {
      material.tensile_pa = material.yield_pa;
      material.compressive_pa = material.yield_pa;
    }
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
    if (!point) throw new Error('load: point required');
    return {
      presetId: this.state.presetId === CUSTOM_PRESET ? null : this.state.presetId,
      point_m: this.state.presetId === CUSTOM_PRESET ? point.point_m : undefined,
      outwardNormal: this.state.presetId === CUSTOM_PRESET ? point.outwardNormal : undefined,
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
        load: this.#loadSetup(),
      };
      this.setupSnapshot = { required, material, setup };
    } catch (error) {
      this.#setStatus(this.#explain(error), true);
      return;
    }
    const spec = this.#spec();
    const version = this.state.inputVersion;
    this.runButton.disabled = true;
    this.cancelButton.hidden = false;
    const started = performance.now();
    this.#setStatus('Сетка', false);
    const job = startJob('analyze', { spec, setup }, (info) => this.#setStatus(this.#progressText(info), false));
    // the coarse solve of the convergence check runs in a second worker next to the main solve
    const checkJob = setup.quality === 'draft' ? null : startJob('check', { spec, setup });
    this.jobs.analysis = job;
    this.jobs.check = checkJob;
    job.promise
      .then(async (analysis) => {
        if (this.jobs.analysis !== job) return;
        if (checkJob) {
          this.#setStatus(TEXT.run.stages.check, false);
          const check = await checkJob.promise.catch(() => null);
          if (this.jobs.analysis !== job) return;
          analysis.convergence = convergenceOf(analysis.solve, check);
        }
        this.#analysisDone(analysis, spec, started, version);
      })
      .catch((error) => {
        checkJob?.cancel();
        this.#fail(error);
      })
      .finally(() => {
        if (this.jobs.analysis !== job) return;
        this.jobs.analysis = null;
        this.jobs.check = null;
        this.runButton.disabled = false;
        this.cancelButton.hidden = true;
      });
  }

  #runFiner(quality) {
    this.state.quality = quality;
    this.#renderRun();
    this.#runAnalysis();
  }

  #progressText(info) {
    const name = TEXT.run.stages[info.stage] ?? info.stage;
    if (info.iteration) return `${name}: итерация ${info.iteration}, невязка ${info.residual.toExponential(1).replace('.', ',')}`;
    return name;
  }

  #cancelAnalysis() {
    this.jobs.analysis?.cancel();
    this.jobs.check?.cancel();
    this.jobs.analysis = null;
    this.jobs.check = null;
    this.runButton.disabled = false;
    this.cancelButton.hidden = true;
    this.#setStatus('Расчет прерван', false);
  }

  // Result of the part without reinforcements, only when its inputs equal those of the current result
  #validBaseline() {
    const { baseline, current } = this.state;
    if (!baseline || !current || baseline === current || this.state.features.length === 0) return null;
    return baseline.key === current.key ? baseline : null;
  }

  #analysisDone(analysis, spec, started, version) {
    const { required, material } = this.setupSnapshot;
    const summary = summarize(analysis, material, required);
    const setup = this.setupSnapshot.setup;
    const key = JSON.stringify({ templateId: spec.templateId, base: spec.base, setup, upload: spec.upload ? { hash: spec.upload.hash, supports: spec.upload.supports } : null });
    const record = { analysis, summary, material, required, spec, features: this.state.features.map((f) => ({ ...f, raw: { ...f.raw } })), setup, key };
    this.state.current = record;
    if (this.state.features.length === 0) this.state.baseline = record;
    this.state.stale = version !== this.state.inputVersion;
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
        this.docStatus.textContent = `STL: ${out.triangleCount} треугольников, ${out.cell_m > 0 ? `ячейка ${formatNumber(out.cell_m * 1000, 3)} мм, ` : ''}объем ${formatNumber(out.volume_m3 * 1e9, 4)} мм3${open > 0 ? `, ребер без пары: ${open}` : ''}`;
      })
      .catch((error) => this.#fail(error, 'documents'));
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
        record,
        baseline: this.#validBaseline(),
        withDrawings: this.drawingsCheck.input.checked,
        viewport: this.viewport,
        onStatus: (text) => {
          this.docStatus.textContent = text;
        },
      });
      saveBlob(new Blob([bytes], { type: 'application/pdf' }), `raschet-${this.state.templateId}.pdf`);
      this.docStatus.textContent = `PDF: ${Math.round(bytes.length / 1024)} КБ`;
    } catch (error) {
      this.#fail(error, 'documents');
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
      if (/not finite/.test(text)) return 'Поле массы: значение вне допустимого диапазона.';
    }
    if (/^material:/.test(text)) return `Материал: ${text.slice(10)}`;
    if (/^required safety/.test(text)) return 'Требуемый запас: число больше нуля.';
    if (/^patch radius/.test(text)) return 'Радиус площадки: число не меньше нуля.';
    if (/^load: point/.test(text)) return 'Точка нагрузки не задана: указать точку на модели.';
    if (/^load:/.test(text)) return 'Нагрузка: значение больше нуля.';
    if (/^reinforcement:/.test(text)) return 'Усиление добавляет более половины объема изделия. Уменьшить размеры усиления.';
    return text;
  }

  // target: 'run' for the status under the run button, 'documents' for the documents section
  #fail(error, target = 'run') {
    const text = error.message;
    let message = text;
    if (/support: too few nodes/.test(text)) message = 'Закрепление не содержит узлов: уменьшить ячейку или изменить размеры.';
    else if (/thin feature/.test(text)) message = 'Элемент тоньше одной ячейки: выбрать качество выше или увеличить толщину.';
    else if (/load patch: too few surface nodes/.test(text)) message = 'Точка нагрузки не лежит на поверхности: указать точку на модели заново.';
    else if (/^model: invalid/.test(text)) message = 'Размеры вне допустимых границ: исправить поля с ошибкой.';
    if (target === 'documents') {
      this.docStatus.textContent = message;
      return;
    }
    this.#setStatus(message, true);
    if (this.docStatus) this.docStatus.textContent = '';
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
