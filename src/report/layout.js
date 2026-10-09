// Typesetting on A4 pages: headings, justified paragraphs, lists, tables with repeated headers, figures, contents

import { PAGE_WIDTH_MM, PAGE_HEIGHT_MM, BLACK } from './pdf.js';
import { COLORS, hexToRgb } from '../ui/tokens.js';

export const MARGIN = { left: 25, right: 15, top: 22, bottom: 22 };
export const TEXT_WIDTH = PAGE_WIDTH_MM - MARGIN.left - MARGIN.right;
export const BODY_SIZE = 11;
const LINE_HEIGHT = 5.1;
const INDENT = 12.5;
const TABLE_SIZE = 9.5;
const TABLE_LINE = 4.2;
const CELL_PAD = 1.4;
const HEADER_Y = 13;
const FOOTER_Y = PAGE_HEIGHT_MM - 12;
const RULE = 0.25;
const GRAY = hexToRgb(COLORS.panel);
// Gaps wider than this multiple of a space make a justified line look loose: such lines stay left aligned
const MAX_STRETCH = 3.2;

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

export class Typesetter {
  // fonts: { regular, bold, italic } PdfFont; designation: text in the page header
  constructor(doc, fonts, designation) {
    this.doc = doc;
    this.fonts = fonts;
    this.designation = designation;
    this.page = null;
    this.y = 0;
    this.headingPages = [];
    this.figureCount = 0;
    this.tableCount = 0;
    this.frontPages = 0;
  }

  get pageIndex() {
    return this.doc.pages.length - 1;
  }

  // A page with header and footer. front: Roman numbered front matter
  newPage({ plain = false } = {}) {
    this.page = this.doc.addPage();
    this.y = MARGIN.top;
    if (!plain) this.#decorate();
    return this.page;
  }

  #label(index) {
    if (index === 0) return '';
    if (index <= this.frontPages) return ROMAN[index + 1] ?? String(index + 1);
    return String(index - this.frontPages);
  }

  // Printed number of a physical page index
  pageLabel(index) {
    return this.#label(index);
  }

  #decorate() {
    const index = this.pageIndex;
    const odd = (index + 1) % 2 === 1;
    const font = this.fonts.bold;
    const align = odd ? 'right' : 'left';
    const x = odd ? PAGE_WIDTH_MM - MARGIN.right : MARGIN.left;
    if (index > 0) this.page.text(this.designation, x, HEADER_Y, { font, size: 9, align });
    const label = this.#label(index);
    if (label) this.page.text(label, x, FOOTER_Y, { font: this.fonts.regular, size: 10, align });
  }

  get bottom() {
    return PAGE_HEIGHT_MM - MARGIN.bottom;
  }

  ensure(height) {
    if (this.y + height > this.bottom) this.newPage();
  }

  space(height) {
    this.y += height;
  }

  // Words with styles from text with **bold** segments
  #words(text, base) {
    const words = [];
    const parts = text.split('**');
    parts.forEach((part, i) => {
      const font = i % 2 === 1 ? this.fonts.bold : base;
      for (const word of part.split(/\s+/)) if (word) words.push({ text: word, font });
    });
    return words;
  }

  // Lines of words fitting width (mm); the first line is narrower by firstIndent
  #wrap(words, size, width, firstIndent = 0) {
    const space = this.fonts.regular.width(' ', size);
    const lines = [];
    let line = [];
    let used = 0;
    let limit = width - firstIndent;
    for (const word of words) {
      const w = word.font.width(word.text, size);
      const needed = line.length ? used + space + w : w;
      if (needed > limit && line.length) {
        lines.push({ words: line, used });
        line = [];
        used = 0;
        limit = width;
      }
      used = line.length ? used + space + w : w;
      line.push({ ...word, width: w });
    }
    if (line.length) lines.push({ words: line, used });
    return { lines, space };
  }

  #drawLine(line, x, y, width, size, space, justify, rgb = BLACK) {
    const gaps = line.words.length - 1;
    let gap = space;
    if (justify && gaps > 0) {
      const stretched = (width - line.words.reduce((s, w) => s + w.width, 0)) / gaps;
      if (stretched <= space * MAX_STRETCH) gap = stretched;
    }
    let cursor = x;
    for (const word of line.words) {
      this.page.text(word.text, cursor, y, { font: word.font, size, rgb });
      cursor += word.width + gap;
    }
  }

  paragraph(text, { indent = INDENT, justify = true, size = BODY_SIZE, font = this.fonts.regular, left = 0, after = 1.5 } = {}) {
    const width = TEXT_WIDTH - left;
    const { lines, space } = this.#wrap(this.#words(text, font), size, width, indent);
    lines.forEach((line, i) => {
      this.ensure(LINE_HEIGHT);
      const x = MARGIN.left + left + (i === 0 ? indent : 0);
      const lineWidth = width - (i === 0 ? indent : 0);
      this.#drawLine(line, x, this.y + LINE_HEIGHT * 0.78, lineWidth, size, space, justify && i < lines.length - 1);
      this.y += LINE_HEIGHT;
    });
    this.y += after;
  }

  // List with dash markers
  list(entries, { left = INDENT } = {}) {
    for (const entry of entries) {
      const width = TEXT_WIDTH - left - 5;
      const { lines, space } = this.#wrap(this.#words(entry, this.fonts.regular), BODY_SIZE, width);
      lines.forEach((line, i) => {
        this.ensure(LINE_HEIGHT);
        if (i === 0) this.page.text('-', MARGIN.left + left, this.y + LINE_HEIGHT * 0.78, { font: this.fonts.regular, size: BODY_SIZE });
        this.#drawLine(line, MARGIN.left + left + 5, this.y + LINE_HEIGHT * 0.78, width, BODY_SIZE, space, i < lines.length - 1);
        this.y += LINE_HEIGHT;
      });
    }
    this.y += 1.5;
  }

  // Numbered heading. level 1: bold 13 pt, level 2: bold 11 pt. number may be '' (unnumbered).
  heading(level, number, text, { record = true, center = false } = {}) {
    const size = level === 1 ? 13 : 11;
    const before = level === 1 ? 7 : 4;
    const height = before + LINE_HEIGHT * 1.2 + LINE_HEIGHT * 3;
    this.ensure(height);
    this.y += before;
    const label = number ? `${number}  ${text}` : text;
    const x = center ? PAGE_WIDTH_MM / 2 : MARGIN.left + (level === 1 ? INDENT : INDENT);
    this.page.text(label, x, this.y + LINE_HEIGHT * 0.85, { font: this.fonts.bold, size, align: center ? 'center' : 'left' });
    if (record) this.headingPages.push({ level, number, text, pageIndex: this.pageIndex });
    this.y += LINE_HEIGHT * 1.2 + 1.5;
  }

  // Table. columns: [{ width, align }]; header: [text]; rows: [[text]]; caption without number
  table({ columns, header, rows, caption }) {
    this.tableCount++;
    const total = columns.reduce((s, c) => s + c.width, 0);
    const scale = TEXT_WIDTH / total;
    const widths = columns.map((c) => c.width * scale);
    const measure = (cells, font) =>
      cells.map((cell, i) => this.#wrap(this.#words(String(cell), font), TABLE_SIZE, widths[i] - 2 * CELL_PAD).lines);
    const drawRow = (cells, font, fill) => {
      const wrapped = measure(cells, font);
      const height = Math.max(...wrapped.map((l) => l.length)) * TABLE_LINE + 2 * CELL_PAD - 0.6;
      if (this.y + height > this.bottom) {
        this.newPage();
        drawHeader();
      }
      let x = MARGIN.left;
      this.page.lineWidth(RULE);
      this.page.stroke(BLACK);
      cells.forEach((cell, i) => {
        if (fill) {
          this.page.fill(GRAY);
          this.page.rect(x, this.y, widths[i], height, 'both');
        } else this.page.rect(x, this.y, widths[i], height);
        const align = columns[i].align ?? 'left';
        wrapped[i].forEach((line, k) => {
          const base = this.y + CELL_PAD + TABLE_LINE * (k + 0.78) - 0.3;
          const lineX = align === 'right' ? x + widths[i] - CELL_PAD - line.used : align === 'center' ? x + (widths[i] - line.used) / 2 : x + CELL_PAD;
          this.#drawLine(line, lineX, base, widths[i] - 2 * CELL_PAD, TABLE_SIZE, this.fonts.regular.width(' ', TABLE_SIZE), false);
        });
        x += widths[i];
      });
      this.y += height;
    };
    const drawHeader = () => drawRow(header, this.fonts.bold, true);
    // keep the caption and the header with the first row
    const firstHeight = Math.max(...measure(rows[0] ?? header, this.fonts.regular).map((l) => l.length)) * TABLE_LINE + 4;
    const headerHeight = Math.max(...measure(header, this.fonts.bold).map((l) => l.length)) * TABLE_LINE + 4;
    this.ensure(firstHeight + headerHeight + (caption ? LINE_HEIGHT + 1 : 0));
    if (caption) {
      this.page.text(`Таблица ${this.tableCount} - ${caption}`, MARGIN.left, this.y + LINE_HEIGHT * 0.8, { font: this.fonts.regular, size: BODY_SIZE });
      this.y += LINE_HEIGHT + 1;
    }
    drawHeader();
    for (const row of rows) drawRow(row, this.fonts.regular, false);
    this.y += 4;
  }

  // Image of widthMm x heightMm with numbered caption below; overlay(page, box) draws vector marks on the image
  figure({ image, widthMm, heightMm, caption, overlay }) {
    this.figureCount++;
    this.ensure(heightMm + LINE_HEIGHT * 3);
    const box = { x: MARGIN.left + (TEXT_WIDTH - widthMm) / 2, y: this.y, width: widthMm, height: heightMm };
    this.page.image(image, box.x, box.y, box.width, box.height);
    if (overlay) overlay(this.page, box);
    this.page.lineWidth(RULE);
    this.page.stroke(BLACK);
    this.page.rect(box.x, box.y, box.width, box.height);
    this.y += heightMm + 1.5;
    this.figureCaption(caption);
  }

  figureCaption(text) {
    const size = BODY_SIZE;
    const { lines, space } = this.#wrap(this.#words(`Рисунок ${this.figureCount} - ${text}`, this.fonts.bold), size, TEXT_WIDTH);
    for (const line of lines) {
      this.ensure(LINE_HEIGHT);
      this.#drawLine(line, MARGIN.left + (TEXT_WIDTH - line.used) / 2, this.y + LINE_HEIGHT * 0.8, TEXT_WIDTH, size, space, false);
      this.y += LINE_HEIGHT;
    }
    this.y += 3;
  }

  // Contents lines with dot leaders. entries: [{ label, pageText, level }]
  contents(entries) {
    for (const entry of entries) {
      this.ensure(LINE_HEIGHT);
      const indent = entry.level === 2 ? 6 : 0;
      const label = entry.label;
      const font = this.fonts.regular;
      const x = MARGIN.left + indent;
      const baseline = this.y + LINE_HEIGHT * 0.78;
      this.page.text(label, x, baseline, { font, size: BODY_SIZE });
      const labelWidth = font.width(label, BODY_SIZE);
      const pageWidth = font.width(entry.pageText, BODY_SIZE);
      const dotWidth = font.width('.', BODY_SIZE) + 0.6;
      const from = x + labelWidth + 2;
      const to = PAGE_WIDTH_MM - MARGIN.right - pageWidth - 2;
      for (let dx = from; dx < to; dx += dotWidth) this.page.text('.', dx, baseline, { font, size: BODY_SIZE });
      this.page.text(entry.pageText, PAGE_WIDTH_MM - MARGIN.right, baseline, { font, size: BODY_SIZE, align: 'right' });
      this.y += LINE_HEIGHT;
    }
  }

  // Block of rules and centered text lines used on the cover
  centered(text, y, { font, size, spacing = 0 }) {
    this.page.text(text, PAGE_WIDTH_MM / 2, y, { font, size, align: 'center', spacing });
  }
}
