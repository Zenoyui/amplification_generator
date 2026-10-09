// TrueType reader and glyph-id preserving subsetter for PDF embedding

const TABLES_KEPT = ['cvt ', 'fpgm', 'prep', 'head', 'hhea', 'maxp', 'hmtx', 'OS/2', 'loca', 'glyf', 'post'];
const COMPOSITE_ARG_WORDS = 0x0001;
const COMPOSITE_SCALE = 0x0008;
const COMPOSITE_MORE = 0x0020;
const COMPOSITE_XY_SCALE = 0x0040;
const COMPOSITE_TWO_BY_TWO = 0x0080;
const POST_VERSION_3 = 0x00030000;
const MAX_COMPONENTS = 64;

class TtfError extends Error {}

export class TrueTypeFont {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.tables = this.#readDirectory();
    const head = this.tables.head;
    this.unitsPerEm = this.view.getUint16(head.offset + 18);
    this.locaFormat = this.view.getInt16(head.offset + 50);
    this.bbox = [36, 38, 40, 42].map((o) => (this.view.getInt16(head.offset + o) * 1000) / this.unitsPerEm);
    const hhea = this.tables.hhea;
    this.ascent = (this.view.getInt16(hhea.offset + 4) * 1000) / this.unitsPerEm;
    this.descent = (this.view.getInt16(hhea.offset + 6) * 1000) / this.unitsPerEm;
    this.hMetricCount = this.view.getUint16(hhea.offset + 34);
    this.glyphCount = this.view.getUint16(this.tables.maxp.offset + 4);
    const os2 = this.tables['OS/2'];
    this.capHeight = os2 && os2.length >= 90 ? (this.view.getInt16(os2.offset + 88) * 1000) / this.unitsPerEm : this.ascent * 0.7;
    this.weight = os2 ? this.view.getUint16(os2.offset + 4) : 400;
    this.italicAngle = this.view.getInt32(this.tables.post.offset + 4) / 65536;
    this.cmap = tablesHasCmap(this.tables) ? this.#readCmap() : null;
  }

  #readDirectory() {
    const count = this.view.getUint16(4);
    const tables = {};
    for (let i = 0; i < count; i++) {
      const base = 12 + 16 * i;
      const tag = String.fromCharCode(...this.bytes.subarray(base, base + 4));
      tables[tag] = { offset: this.view.getUint32(base + 8), length: this.view.getUint32(base + 12) };
    }
    for (const required of ['head', 'hhea', 'maxp', 'hmtx', 'loca', 'glyf', 'post']) {
      if (!tables[required]) throw new TtfError(`table missing (tag=${required})`);
    }
    return tables;
  }

  #readCmap() {
    const { offset } = this.tables.cmap;
    const count = this.view.getUint16(offset + 2);
    let best = null;
    for (let i = 0; i < count; i++) {
      const platform = this.view.getUint16(offset + 4 + 8 * i);
      const encoding = this.view.getUint16(offset + 6 + 8 * i);
      const subtable = offset + this.view.getUint32(offset + 8 + 8 * i);
      const format = this.view.getUint16(subtable);
      const unicode = (platform === 3 && (encoding === 1 || encoding === 10)) || platform === 0;
      if (unicode && (format === 4 || format === 12) && (!best || format > best.format)) best = { subtable, format };
    }
    if (!best) throw new TtfError('cmap: no unicode subtable');
    return best;
  }

  glyphOf(codePoint) {
    if (!this.cmap) throw new TtfError('cmap: table absent in this font program');
    const { subtable, format } = this.cmap;
    const v = this.view;
    if (format === 12) {
      const groups = v.getUint32(subtable + 12);
      for (let g = 0; g < groups; g++) {
        const base = subtable + 16 + 12 * g;
        const start = v.getUint32(base);
        const end = v.getUint32(base + 4);
        if (codePoint >= start && codePoint <= end) return v.getUint32(base + 8) + (codePoint - start);
      }
      return 0;
    }
    const segX2 = v.getUint16(subtable + 6);
    const endCodes = subtable + 14;
    const startCodes = endCodes + segX2 + 2;
    const deltas = startCodes + segX2;
    const rangeOffsets = deltas + segX2;
    for (let s = 0; s < segX2 / 2; s++) {
      const end = v.getUint16(endCodes + 2 * s);
      if (codePoint > end) continue;
      const start = v.getUint16(startCodes + 2 * s);
      if (codePoint < start) return 0;
      const delta = v.getInt16(deltas + 2 * s);
      const rangeOffset = v.getUint16(rangeOffsets + 2 * s);
      if (rangeOffset === 0) return (codePoint + delta) & 0xffff;
      const at = rangeOffsets + 2 * s + rangeOffset + 2 * (codePoint - start);
      const glyph = v.getUint16(at);
      return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
    }
    return 0;
  }

  // Advance width in 1/1000 em
  advanceOf(glyph) {
    const index = Math.min(glyph, this.hMetricCount - 1);
    return (this.view.getUint16(this.tables.hmtx.offset + 4 * index) * 1000) / this.unitsPerEm;
  }

  #glyphRange(glyph) {
    const { offset } = this.tables.loca;
    const read = (i) => (this.locaFormat === 0 ? 2 * this.view.getUint16(offset + 2 * i) : this.view.getUint32(offset + 4 * i));
    return [read(glyph), read(glyph + 1)];
  }

  glyphBytes(glyph) {
    const [from, to] = this.#glyphRange(glyph);
    const base = this.tables.glyf.offset;
    return this.bytes.subarray(base + from, base + to);
  }

  // Glyph ids referenced as components of composite glyph data
  componentsOf(glyph) {
    if (glyph.length < 10) return [];
    const v = new DataView(glyph.buffer, glyph.byteOffset, glyph.byteLength);
    if (v.getInt16(0) >= 0) return [];
    const found = [];
    let at = 10;
    for (let part = 0; part < MAX_COMPONENTS; part++) {
      const flags = v.getUint16(at);
      found.push(v.getUint16(at + 2));
      at += 4 + (flags & COMPOSITE_ARG_WORDS ? 4 : 2);
      if (flags & COMPOSITE_SCALE) at += 2;
      else if (flags & COMPOSITE_XY_SCALE) at += 4;
      else if (flags & COMPOSITE_TWO_BY_TWO) at += 8;
      if (!(flags & COMPOSITE_MORE)) return found;
    }
    throw new TtfError(`composite glyph: more than ${MAX_COMPONENTS} components`);
  }

  // Font program with glyph data only for `glyphs` (and their components); glyph ids stay the same
  subset(glyphs) {
    const keep = new Set([0, ...glyphs]);
    const queue = [...keep];
    while (queue.length) {
      const glyph = queue.pop();
      for (const component of this.componentsOf(this.glyphBytes(glyph))) {
        if (!keep.has(component)) {
          keep.add(component);
          queue.push(component);
        }
      }
    }
    const chunks = [];
    const loca = new Uint32Array(this.glyphCount + 1);
    let size = 0;
    for (let g = 0; g < this.glyphCount; g++) {
      loca[g] = size;
      if (!keep.has(g)) continue;
      const bytes = this.glyphBytes(g);
      const padded = (bytes.length + 3) & ~3;
      chunks.push({ bytes, padded });
      size += padded;
    }
    loca[this.glyphCount] = size;
    const glyf = new Uint8Array(size);
    let at = 0;
    for (const { bytes, padded } of chunks) {
      glyf.set(bytes, at);
      at += padded;
    }
    const locaBytes = new Uint8Array(loca.buffer.slice(0));
    const locaView = new DataView(locaBytes.buffer);
    for (let i = 0; i < loca.length; i++) locaView.setUint32(4 * i, loca[i]);

    const tables = {};
    for (const tag of TABLES_KEPT) {
      if (!this.tables[tag]) continue;
      tables[tag] = this.bytes.slice(this.tables[tag].offset, this.tables[tag].offset + this.tables[tag].length);
    }
    tables.glyf = glyf;
    tables.loca = locaBytes;
    new DataView(tables.head.buffer).setInt16(50, 1);
    new DataView(tables.head.buffer).setUint32(8, 0);
    const post = tables.post.slice(0, 32);
    new DataView(post.buffer).setUint32(0, POST_VERSION_3);
    tables.post = post;
    return assemble(tables);
  }
}

const tablesHasCmap = (tables) => Boolean(tables.cmap);

function checksum(bytes) {
  let sum = 0;
  const padded = new Uint8Array((bytes.length + 3) & ~3);
  padded.set(bytes);
  const v = new DataView(padded.buffer);
  for (let i = 0; i < padded.length; i += 4) sum = (sum + v.getUint32(i)) >>> 0;
  return sum;
}

function assemble(tables) {
  const tags = Object.keys(tables).sort();
  const headerSize = 12 + 16 * tags.length;
  let total = headerSize;
  const offsets = {};
  for (const tag of tags) {
    offsets[tag] = total;
    total += (tables[tag].length + 3) & ~3;
  }
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x00010000);
  v.setUint16(4, tags.length);
  let power = 1;
  let log = 0;
  while (power * 2 <= tags.length) {
    power *= 2;
    log++;
  }
  v.setUint16(6, power * 16);
  v.setUint16(8, log);
  v.setUint16(10, tags.length * 16 - power * 16);
  tags.forEach((tag, i) => {
    const base = 12 + 16 * i;
    for (let c = 0; c < 4; c++) out[base + c] = tag.charCodeAt(c);
    v.setUint32(base + 4, checksum(tables[tag]));
    v.setUint32(base + 8, offsets[tag]);
    v.setUint32(base + 12, tables[tag].length);
    out.set(tables[tag], offsets[tag]);
  });
  const wholeSum = checksum(out);
  v.setUint32(offsets.head + 8, (0xb1b0afba - wholeSum) >>> 0);
  return out;
}
