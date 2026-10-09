// Minimal PDF 1.7 writer: A4 pages, embedded TrueType fonts (subset, Identity-H), RGB images, vector graphics.
// Page coordinates are millimeters from the top left corner.

import { TrueTypeFont } from './ttf.js';
import { COLORS, hexToRgb } from '../ui/tokens.js';

export const BLACK = hexToRgb(COLORS.print);

export const PAGE_WIDTH_MM = 210;
export const PAGE_HEIGHT_MM = 297;
const PT_PER_MM = 72 / 25.4;

const num = (v) => {
  const text = v.toFixed(3);
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
};

const encoder = new TextEncoder();
const bytesOf = (text) => encoder.encode(text);

const hex4 = (v) => v.toString(16).toUpperCase().padStart(4, '0');

// UTF-16BE hex string with byte order mark, for Info strings
function utf16Hex(text) {
  let out = 'FEFF';
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp > 0xffff) {
      const v = cp - 0x10000;
      out += hex4(0xd800 + (v >> 10)) + hex4(0xdc00 + (v & 0x3ff));
    } else out += hex4(cp);
  }
  return `<${out}>`;
}

async function deflate(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

class PdfFont {
  constructor(name, ttf) {
    this.name = name;
    this.ttf = ttf;
    this.used = new Map();
    this.missing = new Set();
  }

  // Hex string of 2-byte glyph ids for text
  encode(text) {
    let out = '';
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      let glyph = this.ttf.glyphOf(cp);
      if (glyph === 0 && cp !== 0x20) {
        this.missing.add(ch);
        glyph = this.ttf.glyphOf(0x3f);
      }
      this.used.set(glyph, cp);
      out += hex4(glyph);
    }
    return `<${out}>`;
  }

  // Width in mm of text at size (pt)
  width(text, size_pt) {
    let sum = 0;
    for (const ch of text) sum += this.ttf.advanceOf(this.ttf.glyphOf(ch.codePointAt(0)));
    return (sum / 1000) * size_pt / PT_PER_MM;
  }
}

class Page {
  constructor(document) {
    this.document = document;
    this.parts = [];
    this.stateDepth = 0;
  }

  #emit(text) {
    this.parts.push(text);
  }

  save() {
    this.stateDepth++;
    this.#emit('q');
  }

  restore() {
    this.stateDepth--;
    this.#emit('Q');
  }

  clipRect(x, y, w, h) {
    this.#emit(`${num(x * PT_PER_MM)} ${num((PAGE_HEIGHT_MM - y - h) * PT_PER_MM)} ${num(w * PT_PER_MM)} ${num(h * PT_PER_MM)} re W n`);
  }

  stroke(rgb) {
    this.#emit(`${rgb.map(num).join(' ')} RG`);
  }

  fill(rgb) {
    this.#emit(`${rgb.map(num).join(' ')} rg`);
  }

  lineWidth(mm) {
    this.#emit(`${num(mm * PT_PER_MM)} w`);
  }

  dash(pattern_mm, phase_mm = 0) {
    this.#emit(`[${pattern_mm.map((v) => num(v * PT_PER_MM)).join(' ')}] ${num(phase_mm * PT_PER_MM)} d`);
  }

  cap(style) {
    this.#emit(`${style} J`);
  }

  #path(points, close) {
    const [first, ...rest] = points;
    let out = `${num(first[0] * PT_PER_MM)} ${num((PAGE_HEIGHT_MM - first[1]) * PT_PER_MM)} m`;
    for (const p of rest) out += ` ${num(p[0] * PT_PER_MM)} ${num((PAGE_HEIGHT_MM - p[1]) * PT_PER_MM)} l`;
    if (close) out += ' h';
    return out;
  }

  line(x1, y1, x2, y2) {
    this.#emit(`${this.#path([[x1, y1], [x2, y2]], false)} S`);
  }

  // mode: 'stroke' | 'fill' | 'both'
  polygon(points, mode = 'stroke') {
    const op = { stroke: 'S', fill: 'f', both: 'B' }[mode];
    this.#emit(`${this.#path(points, true)} ${op}`);
  }

  polyline(points) {
    if (points.length < 2) return;
    this.#emit(`${this.#path(points, false)} S`);
  }

  rect(x, y, w, h, mode = 'stroke') {
    this.polygon([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], mode);
  }

  circle(cx, cy, r, mode = 'stroke') {
    const k = 0.5522847498 * r;
    const p = (x, y) => `${num(x * PT_PER_MM)} ${num((PAGE_HEIGHT_MM - y) * PT_PER_MM)}`;
    const op = { stroke: 'S', fill: 'f', both: 'B' }[mode];
    this.#emit(
      `${p(cx + r, cy)} m ${p(cx + r, cy - k)} ${p(cx + k, cy - r)} ${p(cx, cy - r)} c ${p(cx - k, cy - r)} ${p(cx - r, cy - k)} ${p(cx - r, cy)} c ${p(cx - r, cy + k)} ${p(cx - k, cy + r)} ${p(cx, cy + r)} c ${p(cx + k, cy + r)} ${p(cx + r, cy + k)} ${p(cx + r, cy)} c h ${op}`,
    );
  }

  // Baseline at (x, y) in mm. align: 'left' | 'center' | 'right'. spacing_pt: extra character spacing.
  text(text, x, y, { font, size, align = 'left', rgb = BLACK, spacing = 0, scaleX = 1 }) {
    if (!text) return;
    const width = font.width(text, size) + spacing * [...text].length / PT_PER_MM;
    const left = align === 'left' ? x : align === 'center' ? x - (width * scaleX) / 2 : x - width * scaleX;
    this.#emit(
      `BT ${rgb.map(num).join(' ')} rg /${font.name} ${num(size)} Tf ${num(spacing)} Tc ${num(scaleX * 100)} Tz ${num(left * PT_PER_MM)} ${num((PAGE_HEIGHT_MM - y) * PT_PER_MM)} Td ${font.encode(text)} Tj ET`,
    );
  }

  // Text slanted by angle_deg (italic drawing); x, y baseline origin
  slantedText(text, x, y, { font, size, rgb = BLACK, slantDeg = 15 }) {
    const shear = Math.tan((slantDeg * Math.PI) / 180);
    this.#emit(
      `BT ${rgb.map(num).join(' ')} rg /${font.name} ${num(size)} Tf 1 0 ${num(shear)} 1 ${num(x * PT_PER_MM)} ${num((PAGE_HEIGHT_MM - y) * PT_PER_MM)} Tm ${font.encode(text)} Tj ET`,
    );
  }

  // Rotated text about (x, y), angle in degrees counterclockwise on the page
  rotatedText(text, x, y, angleDeg, { font, size, rgb = BLACK }) {
    const c = Math.cos((angleDeg * Math.PI) / 180);
    const s = Math.sin((angleDeg * Math.PI) / 180);
    this.#emit(
      `BT ${rgb.map(num).join(' ')} rg /${font.name} ${num(size)} Tf ${num(c)} ${num(s)} ${num(-s)} ${num(c)} ${num(x * PT_PER_MM)} ${num((PAGE_HEIGHT_MM - y) * PT_PER_MM)} Tm ${font.encode(text)} Tj ET`,
    );
  }

  image(image, x, y, w, h) {
    this.#emit(`q ${num(w * PT_PER_MM)} 0 0 ${num(h * PT_PER_MM)} ${num(x * PT_PER_MM)} ${num((PAGE_HEIGHT_MM - y - h) * PT_PER_MM)} cm /${image.name} Do Q`);
    this.document.usedImages.add(image);
  }

  content() {
    if (this.stateDepth !== 0) throw new Error(`pdf: unbalanced graphics state (depth=${this.stateDepth})`);
    return this.parts.join('\n');
  }
}

export class PdfDocument {
  constructor({ title, subject, keywords, created, identifier }) {
    this.info = { title, subject, keywords, created };
    this.identifier = identifier;
    this.fonts = [];
    this.images = [];
    this.usedImages = new Set();
    this.pages = [];
    this.outline = [];
  }

  addFont(ttfBytes) {
    const font = new PdfFont(`F${this.fonts.length + 1}`, new TrueTypeFont(ttfBytes));
    this.fonts.push(font);
    return font;
  }

  addPage() {
    const page = new Page(this);
    this.pages.push(page);
    return page;
  }

  // rgb: Uint8Array (3 bytes per pixel)
  addImage(rgb, width, height) {
    const image = { name: `Im${this.images.length + 1}`, rgb, width, height };
    this.images.push(image);
    return image;
  }

  // title at page index (0 based) with nesting level 0 or 1
  addOutline(title, pageIndex, level = 0) {
    this.outline.push({ title, pageIndex, level });
  }

  async finish() {
    const chunks = [];
    const offsets = [];
    let length = 0;
    const write = (chunk) => {
      const bytes = typeof chunk === 'string' ? bytesOf(chunk) : chunk;
      chunks.push(bytes);
      length += bytes.length;
    };
    const objects = [];
    const reserve = () => {
      objects.push(null);
      return objects.length;
    };
    const set = (id, body) => {
      objects[id - 1] = body;
    };
    const catalogId = reserve();
    const pagesId = reserve();
    const infoId = reserve();
    const fontResources = [];
    for (const font of this.fonts) fontResources.push(await this.#fontObjects(font, reserve, set));
    const imageIds = [];
    for (const image of this.images) {
      const raw = await deflate(image.rgb);
      const id = reserve();
      const dict = `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8${raw ? ' /Filter /FlateDecode' : ''} /Length ${(raw ?? image.rgb).length} >>`;
      set(id, { dict, stream: raw ?? image.rgb });
      imageIds.push(id);
    }
    const resources = `<< /Font << ${this.fonts.map((f, i) => `/${f.name} ${fontResources[i]} 0 R`).join(' ')} >> /XObject << ${this.images.map((im, i) => `/${im.name} ${imageIds[i]} 0 R`).join(' ')} >> >>`;
    const pageIds = [];
    for (const page of this.pages) {
      const contentId = reserve();
      const raw = bytesOf(page.content());
      const packed = await deflate(raw);
      set(contentId, { dict: `<< ${packed ? '/Filter /FlateDecode ' : ''}/Length ${(packed ?? raw).length} >>`, stream: packed ?? raw });
      const pageId = reserve();
      const box = `[0 0 ${num(PAGE_WIDTH_MM * PT_PER_MM)} ${num(PAGE_HEIGHT_MM * PT_PER_MM)}]`;
      set(pageId, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox ${box} /CropBox ${box} /TrimBox ${box} /Rotate 0 /Resources ${resources} /Contents ${contentId} 0 R >>`);
      pageIds.push(pageId);
    }
    set(pagesId, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
    const outlineRoot = this.#outlineObjects(reserve, set, pageIds);
    set(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R /Lang (ru-RU) /ViewerPreferences << /PrintScaling /None /DisplayDocTitle true >>${outlineRoot ? ` /Outlines ${outlineRoot} 0 R /PageMode /UseOutlines` : ''} >>`);
    const d = this.info.created;
    const pad = (v) => String(v).padStart(2, '0');
    const stamp = `D:${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
    set(infoId, `<< /Title ${utf16Hex(this.info.title)} /Subject ${utf16Hex(this.info.subject)} /Keywords ${utf16Hex(this.info.keywords)} /CreationDate (${stamp}) /ModDate (${stamp}) >>`);

    // header line and a comment of high bytes that marks the file as binary
    write(Uint8Array.from([...'%PDF-1.7\n'].map((c) => c.charCodeAt(0)).concat([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])));
    objects.forEach((body, index) => {
      offsets.push(length);
      write(`${index + 1} 0 obj\n`);
      if (typeof body === 'string') write(`${body}\nendobj\n`);
      else {
        write(`${body.dict}\nstream\n`);
        write(body.stream);
        write('\nendstream\nendobj\n');
      }
    });
    const xref = length;
    write(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
    for (const offset of offsets) write(`${String(offset).padStart(10, '0')} 00000 n \n`);
    const id = this.identifier;
    write(`trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R /ID [<${id}> <${id}>] >>\nstartxref\n${xref}\n%%EOF\n`);
    const out = new Uint8Array(length);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }

  async #fontObjects(font, reserve, set) {
    const ttf = font.ttf;
    const glyphs = [...font.used.keys()];
    const program = ttf.subset(glyphs);
    const packed = await deflate(program);
    const fileId = reserve();
    set(fileId, { dict: `<< ${packed ? '/Filter /FlateDecode ' : ''}/Length ${(packed ?? program).length} /Length1 ${program.length} >>`, stream: packed ?? program });
    const descriptorId = reserve();
    const tag = `${String.fromCharCode(65 + (font.name.charCodeAt(1) % 26)).repeat(6)}+LiberationSans${ttf.weight >= 600 ? '-Bold' : ttf.italicAngle !== 0 ? '-Italic' : '-Regular'}`;
    const flags = 32 | (ttf.italicAngle !== 0 ? 64 : 0);
    set(
      descriptorId,
      `<< /Type /FontDescriptor /FontName /${tag} /Flags ${flags} /FontBBox [${ttf.bbox.map((v) => Math.round(v)).join(' ')}] /ItalicAngle ${num(ttf.italicAngle)} /Ascent ${Math.round(ttf.ascent)} /Descent ${Math.round(ttf.descent)} /CapHeight ${Math.round(ttf.capHeight)} /StemV ${ttf.weight >= 600 ? 140 : 80} /FontFile2 ${fileId} 0 R >>`,
    );
    const widths = glyphs
      .sort((a, b) => a - b)
      .map((g) => `${g} [${Math.round(ttf.advanceOf(g))}]`)
      .join(' ');
    const cidId = reserve();
    set(cidId, `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${tag} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptorId} 0 R /DW 1000 /W [${widths}] /CIDToGIDMap /Identity >>`);
    const unicodeId = reserve();
    const mapping = [...font.used.entries()].sort((a, b) => a[0] - b[0]);
    let cmap = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n';
    for (let i = 0; i < mapping.length; i += 100) {
      const part = mapping.slice(i, i + 100);
      cmap += `${part.length} beginbfchar\n${part.map(([g, cp]) => `<${hex4(g)}> <${cp > 0xffff ? hex4(0xd800 + ((cp - 0x10000) >> 10)) + hex4(0xdc00 + ((cp - 0x10000) & 0x3ff)) : hex4(cp)}>`).join('\n')}\nendbfchar\n`;
    }
    cmap += 'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend';
    const cmapBytes = bytesOf(cmap);
    const cmapPacked = await deflate(cmapBytes);
    set(unicodeId, { dict: `<< ${cmapPacked ? '/Filter /FlateDecode ' : ''}/Length ${(cmapPacked ?? cmapBytes).length} >>`, stream: cmapPacked ?? cmapBytes });
    const type0Id = reserve();
    set(type0Id, `<< /Type /Font /Subtype /Type0 /BaseFont /${tag} /Encoding /Identity-H /DescendantFonts [${cidId} 0 R] /ToUnicode ${unicodeId} 0 R >>`);
    return type0Id;
  }

  #outlineObjects(reserve, set, pageIds) {
    if (this.outline.length === 0) return 0;
    const rootId = reserve();
    const ids = this.outline.map(() => reserve());
    const parentOf = [];
    const stack = [];
    this.outline.forEach((entry, i) => {
      while (stack.length && this.outline[stack[stack.length - 1]].level >= entry.level) stack.pop();
      parentOf[i] = stack.length ? stack[stack.length - 1] : -1;
      stack.push(i);
    });
    const children = (parent) => this.outline.map((_, i) => i).filter((i) => parentOf[i] === parent);
    this.outline.forEach((entry, i) => {
      const siblings = children(parentOf[i]);
      const position = siblings.indexOf(i);
      const kids = children(i);
      const parentId = parentOf[i] === -1 ? rootId : ids[parentOf[i]];
      const fields = [`/Title ${utf16Hex(entry.title)}`, `/Parent ${parentId} 0 R`, `/Dest [${pageIds[entry.pageIndex]} 0 R /XYZ 0 ${num(PAGE_HEIGHT_MM * PT_PER_MM)} 0]`];
      if (position > 0) fields.push(`/Prev ${ids[siblings[position - 1]]} 0 R`);
      if (position < siblings.length - 1) fields.push(`/Next ${ids[siblings[position + 1]]} 0 R`);
      if (kids.length) fields.push(`/First ${ids[kids[0]]} 0 R /Last ${ids[kids[kids.length - 1]]} 0 R /Count ${kids.length}`);
      set(ids[i], `<< ${fields.join(' ')} >>`);
    });
    const top = children(-1);
    set(rootId, `<< /Type /Outlines /First ${ids[top[0]]} 0 R /Last ${ids[top[top.length - 1]]} 0 R /Count ${top.length} >>`);
    return rootId;
  }
}
