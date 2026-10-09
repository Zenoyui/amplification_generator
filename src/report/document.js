// Assembly of the PDF calculation document

import { PdfDocument } from './pdf.js';
import { Typesetter } from './layout.js';
import { drawCover, drawPreface, drawContents } from './cover.js';
import { renderFigures } from './figures.js';
import { digestHex } from './fingerprint.js';
import { buildModel } from '../geometry/model.js';
import { toDisplay } from '../geometry/params.js';
import { formatNumber, unitLabel } from '../ui/format.js';
import { TEXT } from '../ui/text.js';
import {
  writeScope, writeReferences, writeTerms, writeInput, writeModel, writeCriteria, writeResults, writeComparison, writeReliability,
  writeLimitations, writeBibliography, legendOverlay,
} from './sections.js';

const FONT_FILES = { regular: 'LiberationSans-Regular.ttf', bold: 'LiberationSans-Bold.ttf', italic: 'LiberationSans-Italic.ttf' };
const FIGURE_WIDTH_MM = 140;
const FIGURE_HEIGHT_MAX_MM = 105;
const FRONT_PAGES = 2;
const FIGURE_MODES = [
  ['mises', 'Эквивалентное напряжение по теории IV, МПа'],
  ['displacement', 'Перемещения, мм'],
  ['safety', 'Запас прочности'],
];

async function loadFonts() {
  const fonts = {};
  for (const [key, file] of Object.entries(FONT_FILES)) {
    const response = await fetch(new URL(`../../assets/fonts/${file}`, import.meta.url));
    if (!response.ok) throw new Error(`font: load failed (file=${file}, status=${response.status})`);
    fonts[key] = new Uint8Array(await response.arrayBuffer());
  }
  return fonts;
}

function describeFeature(feature) {
  const parts = feature.specs.map((spec) => {
    if (spec.type === 'enum') return `${spec.label.toLowerCase()}: ${spec.options.find((o) => o.value === feature.parameters[spec.key]).label}`;
    return `${spec.label.toLowerCase()} ${formatNumber(toDisplay(spec, feature.parameters[spec.key]), 3)} ${unitLabel(spec.unit)}`;
  });
  return { name: feature.name, text: parts.join('; ') };
}

function context(record, baseline, withDrawings, fingerprint) {
  const { model } = buildModel(record.spec.templateId, record.spec.base, record.spec.features);
  const date = new Date();
  const pad = (v) => String(v).padStart(2, '0');
  return {
    model,
    templateName: model.templateName,
    material: record.material,
    summary: record.summary,
    baseline: record.features.length > 0 && baseline && baseline !== record ? baseline.summary : null,
    load: record.analysis.load,
    selfWeight: record.setup.selfWeight,
    withDrawings,
    features: model.features.map(describeFeature),
    baseRows: model.baseSpecs.map((spec) => ({ label: spec.label, value: formatNumber(toDisplay(spec, model.base_m[spec.key]), 4), unit: unitLabel(spec.unit) })),
    supports: model.supports.map((s) => s.label),
    fingerprint,
    designation: `РП-${fingerprint.slice(0, 8).toUpperCase()}`,
    year: String(date.getFullYear()),
    dateText: `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`,
    date,
  };
}

function metadata(ctx) {
  return {
    title: `Расчет на прочность изделия ${ctx.templateName}`,
    subject: `Расчет прочности, документ ${ctx.designation}`,
    keywords: 'прочность, метод конечных элементов, усиления, запас прочности',
    created: ctx.date,
    identifier: ctx.fingerprint.slice(0, 32),
  };
}

// One layout pass. known: heading pages from the previous pass (contents), or null
function layoutPass(ctx, fontBytes, figures, sheets, known) {
  const doc = new PdfDocument(metadata(ctx));
  const fonts = { regular: doc.addFont(fontBytes.regular), bold: doc.addFont(fontBytes.bold), italic: doc.addFont(fontBytes.italic) };
  const ts = new Typesetter(doc, fonts, ctx.designation);
  ts.frontPages = FRONT_PAGES;
  drawCover(ts, ctx);
  drawPreface(ts, ctx);
  const tocEntries = known ?? placeholderEntries(ctx);
  drawContents(ts, tocEntries);
  ts.newPage();
  writeScope(ts, ctx);
  writeReferences(ts, ctx);
  writeTerms(ts);
  writeInput(ts, ctx);
  writeModel(ts, ctx);
  writeCriteria(ts, ctx);
  const placed = figures.map((f) => ({
    image: doc.addImage(f.rgb, f.width, f.height),
    widthMm: Math.min(FIGURE_WIDTH_MM, (FIGURE_HEIGHT_MAX_MM * f.width) / f.height),
    heightMm: Math.min(FIGURE_HEIGHT_MAX_MM, (FIGURE_WIDTH_MM * f.height) / f.width),
    caption: f.caption,
    overlay: legendOverlay(fonts, `${f.title}${f.unit ? `, ${f.unit}` : ''}`, f.range, f.reversed, (v) => formatNumber(v, 3)),
  }));
  writeResults(ts, ctx, placed);
  if (ctx.baseline) writeComparison(ts, ctx);
  writeReliability(ts, ctx);
  writeLimitations(ts, ctx);
  if (sheets.length) {
    ts.newPage();
    const index = ts.pageIndex;
    ts.heading(1, '', 'Приложение А (обязательное)', { center: true, record: false });
    ts.heading(1, '', 'Чертежи', { center: true, record: false });
    ts.paragraph(`Листов: ${sheets.length}. Формат A4, рамка и основная надпись по общему виду формы 1 ГОСТ 2.104-2006.`);
    ts.headingPages.push({ level: 1, number: '', text: 'Приложение А (обязательное) Чертежи', pageIndex: index });
    for (const sheet of sheets) sheet.draw(ts.doc.addPage(), fonts);
  }
  ts.newPage();
  writeBibliography(ts);
  ts.headingPages.push({ level: 1, number: '', text: 'Библиография', pageIndex: ts.pageIndex });
  for (const entry of ts.headingPages) if (entry.level === 1) doc.addOutline(entry.number ? `${entry.number} ${entry.text}` : entry.text, entry.pageIndex, 0);
  return { doc, ts };
}

// Contents rows with a stable line count before page numbers are known
function placeholderEntries(ctx) {
  const rows = [
    ['1', 'Область применения'], ['2', 'Нормативные ссылки'], ['3', 'Термины и определения'], ['4', 'Исходные данные'], ['5', 'Расчетная модель'],
    ['6', 'Критерии прочности'], ['7', 'Результаты расчета'],
  ];
  if (ctx.baseline) rows.push(['8', 'Сравнение с изделием без усилений']);
  rows.push(['9', 'Достоверность результата'], ['10', 'Ограничения']);
  if (ctx.withDrawings) rows.push(['', 'Приложение А (обязательное) Чертежи']);
  rows.push(['', 'Библиография']);
  return rows.map(([number, text]) => ({ level: 1, number, text, pageIndex: 0 }));
}

// record: current result; baseline: result without reinforcement or null;
// viewport: provides the display mesh. Returns Uint8Array with the PDF.
export async function buildReport({ record, baseline, withDrawings, viewport, onStatus }) {
  onStatus('Подготовка данных');
  const fingerprint = await digestHex(JSON.stringify({ spec: record.spec, setup: record.setup, required: record.required }));
  const ctx = context(record, baseline, withDrawings, fingerprint);
  const fontBytes = await loadFonts();

  onStatus('Рисунки результата');
  const pixels = renderFigures(viewport.display, record, record.analysis.load, FIGURE_MODES.map(([mode]) => mode));
  const figures = pixels.map((p, i) => ({ ...p, caption: FIGURE_MODES[i][1] }));

  let sheets = [];
  if (withDrawings) {
    onStatus(TEXT.documents.drawings);
    const { buildDrawingSheets } = await import('./drawing.js');
    sheets = buildDrawingSheets(ctx, viewport.display);
  }

  onStatus('Сборка файла');
  const first = layoutPass(ctx, fontBytes, figures, sheets, null);
  const second = layoutPass(ctx, fontBytes, figures, sheets, first.ts.headingPages);
  return second.doc.finish();
}
