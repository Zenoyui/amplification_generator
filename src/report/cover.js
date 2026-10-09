// Cover, preface and contents pages

import { PAGE_WIDTH_MM, PAGE_HEIGHT_MM, BLACK } from './pdf.js';
import { MARGIN, TEXT_WIDTH } from './layout.js';
import { formatNumber } from '../ui/format.js';

const LEFT = MARGIN.left;
const RIGHT = PAGE_WIDTH_MM - MARGIN.right;

// Greedy split of text into lines not wider than width (mm)
function splitLines(text, font, size, width) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    const trial = line ? `${line} ${word}` : word;
    if (font.width(trial, size) > width && line) {
      lines.push(line);
      line = word;
    } else line = trial;
  }
  if (line) lines.push(line);
  return lines;
}

export function drawCover(ts, ctx) {
  const page = ts.newPage({ plain: true });
  const { bold, regular, italic } = ts.fonts;
  page.stroke(BLACK);
  page.lineWidth(1);
  page.line(LEFT, 22, RIGHT, 22);
  ts.centered('ТЕХНИЧЕСКИЙ ДОКУМЕНТ С РЕЗУЛЬТАТАМИ РАСЧЕТА НА ПРОЧНОСТЬ', 30, { font: bold, size: 9 });
  ts.centered('Расчет статической прочности, усилений и повторной проверки', 35, { font: regular, size: 9 });
  page.lineWidth(0.35);
  page.line(LEFT, 40, RIGHT, 40);
  page.text('Р А С Ч Е Т Н Ы Й   Д О К У М Е Н Т', LEFT, 60, { font: bold, size: 10 });
  page.text(ctx.designation, RIGHT, 60, { font: bold, size: 22, align: 'right' });
  page.text(ctx.year, RIGHT, 68, { font: bold, size: 14, align: 'right' });
  page.lineWidth(1);
  page.line(LEFT, 74, RIGHT, 74);

  const title = `РАСЧЕТ НА ПРОЧНОСТЬ ИЗДЕЛИЯ ${ctx.templateName.toUpperCase()}`;
  let y = 108;
  for (const line of splitLines(title, bold, 17, TEXT_WIDTH - 10)) {
    ts.centered(line, y, { font: bold, size: 17 });
    y += 8;
  }
  y += 6;
  ts.centered('Статический расчет методом конечных элементов', y, { font: bold, size: 12 });
  y += 7;
  ts.centered(ctx.features.length ? 'Исходный вариант и вариант с усилениями' : 'Исходный вариант', y, { font: bold, size: 12 });
  y += 14;
  const material = splitLines(`Материал: ${ctx.material.name}`, regular, 10.5, TEXT_WIDTH - 20);
  for (const line of material) {
    ts.centered(line, y, { font: regular, size: 10.5 });
    y += 5.5;
  }
  ts.centered(`Нагрузка: ${formatNumber(ctx.load.magnitude_n, 4)} Н`, y, { font: regular, size: 10.5 });
  y += 5.5;
  ts.centered(ctx.withDrawings ? 'Приложение: чертежи' : '', y, { font: italic, size: 10.5 });

  page.lineWidth(0.35);
  page.line(LEFT, PAGE_HEIGHT_MM - 38, RIGHT, PAGE_HEIGHT_MM - 38);
  ts.centered(`Дата составления: ${ctx.dateText}`, PAGE_HEIGHT_MM - 30, { font: regular, size: 10 });
  ts.centered(`Идентификатор исходных данных: ${ctx.fingerprint.slice(0, 16)}`, PAGE_HEIGHT_MM - 24, { font: regular, size: 9 });
}

export function drawPreface(ts, ctx) {
  ts.newPage();
  ts.space(4);
  ts.heading(1, '', 'Предисловие', { center: true, record: false });
  ts.paragraph('**Сведения о документе**', { indent: 12.5 });
  ts.paragraph(`1  **ОБЪЕКТ РАСЧЕТА:** ${ctx.templateName}, материал ${ctx.material.name}.`, { indent: 12.5 });
  ts.paragraph('2  **ОСНОВАНИЕ:** исходные данные раздела 4: размеры изделия, материал, нагрузка, закрепление, требуемый запас прочности.', { indent: 12.5 });
  ts.paragraph('3  **МЕТОД:** метод конечных элементов, линейная упругость, статика; теории прочности I-V (раздел 6).', { indent: 12.5 });
  ts.paragraph(`4  **ИДЕНТИФИКАТОР ИСХОДНЫХ ДАННЫХ:** ${ctx.fingerprint.slice(0, 32)} (SHA-256, первые 32 знака). Одинаковые исходные данные дают одинаковый идентификатор и одинаковый результат.`, { indent: 12.5 });
  ts.paragraph(`5  **ДАТА СОСТАВЛЕНИЯ:** ${ctx.dateText}.`, { indent: 12.5 });
  ts.paragraph('Значения действительны в границах раздела 10. Для значений вне этих границ требуется отдельная проверка.', { indent: 12.5 });
}

// entries: [{ level, number, text, pageIndex }]
export function drawContents(ts, entries) {
  ts.newPage();
  ts.space(4);
  ts.heading(1, '', 'Содержание', { center: true, record: false });
  ts.contents(
    entries
      .filter((e) => e.level === 1)
      .map((e) => ({ level: 1, label: e.number ? `${e.number}  ${e.text}` : e.text, pageText: e.pageIndex === undefined ? '0' : ts.pageLabel(e.pageIndex) })),
  );
}
