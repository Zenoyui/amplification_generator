// Drawing sheets (A4 portrait) from the display mesh: orthographic views in first angle projection,
// isometric view, hidden lines, overall dimensions, frame and title block (ГОСТ 2.301, 2.303, 2.305, 2.307, 2.104)

import { formatNumber } from '../ui/format.js';
import { BLACK } from './pdf.js';

const FRAME = { x0: 20, y0: 5, x1: 205, y1: 292 };
const BLOCK_HEIGHT = 55;
const BLOCK_TOP = FRAME.y1 - BLOCK_HEIGHT;
const MAIN_WIDTH = 0.7;
const THIN_WIDTH = 0.25;
const HIDDEN_WIDTH = 0.35;
const FRAME_WIDTH = 0.7;
const ARROW = { length: 4, half: 0.7 };
const DIM_TEXT = 3.5;
const DIM_STEP = 10;
const VIEW_GAP = 24;
const AREA = { x0: FRAME.x0 + 16, x1: FRAME.x1 - 8, y0: FRAME.y0 + 10, y1: BLOCK_TOP - 6 };
// Scales of ГОСТ 2.302-68 as paper millimeters per model millimeter
const SCALES = [100, 50, 40, 20, 10, 5, 4, 2.5, 2, 1, 1 / 2, 1 / 2.5, 1 / 4, 1 / 5, 1 / 10, 1 / 15, 1 / 20, 1 / 25, 1 / 40, 1 / 50, 1 / 75, 1 / 100];
// Raster of the visibility test, pixels per paper millimeter
const PIXELS_PER_MM = 4;
const SAMPLE_STEP_MM = 0.4;
const SILHOUETTE_NOISE = 1e-3;
const CAP_TO_POINTS = 72 / 25.4;
const SLANT_DEG = 15;
const CENTER_DASH = [8, 1.5, 1, 1.5];
const HIDDEN_DASH = [4, 1];

const VIEWS = {
  front: { toward: [0, -1, 0], up: [0, 0, 1] },
  top: { toward: [0, 0, 1], up: [0, 1, 0] },
  left: { toward: [-1, 0, 0], up: [0, 0, 1] },
  iso: { toward: [1 / Math.sqrt(3), -1 / Math.sqrt(3), 1 / Math.sqrt(3)], up: [0, 0, 1] },
};

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a) => {
  const len = Math.hypot(...a);
  return a.map((v) => v / len);
};

function axesOf(name) {
  const { toward, up } = VIEWS[name];
  const right = unit(cross(up, toward));
  const screenUp = cross(toward, right);
  return { right, up: screenUp, toward };
}

const trimmed = (amount) => String(Number(amount.toFixed(2))).replace('.', ',');

function scaleText(s) {
  return s >= 1 ? `${trimmed(s)}:1` : `1:${trimmed(1 / s)}`;
}

function dimText(value_m) {
  return String(Number((value_m * 1000).toFixed(2))).replace('.', ',');
}

// Font size in points whose capital height is capMm
function sizeFor(font, capMm) {
  return (capMm / (font.ttf.capHeight / 1000)) * CAP_TO_POINTS;
}

// Text of capital height capMm, shrunk to fit width, slanted as in ГОСТ 2.304 type B
function drawText(page, font, text, x, y, capMm, { align = 'left', width = Infinity } = {}) {
  let cap = capMm;
  let size = sizeFor(font, cap);
  while (font.width(text, size) > width && cap > 1.8) {
    cap -= 0.25;
    size = sizeFor(font, cap);
  }
  const w = font.width(text, size);
  const left = align === 'left' ? x : align === 'center' ? x - w / 2 : x - w;
  page.slantedText(text, left, y, { font, size, slantDeg: SLANT_DEG });
}

// Lines of words not wider than width (mm) at capital height capMm
function wrapText(font, text, capMm, width) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    const trial = line ? `${line} ${word}` : word;
    if (line && textWidth(font, trial, capMm) > width) {
      lines.push(line);
      line = word;
    } else line = trial;
  }
  if (line) lines.push(line);
  return lines;
}

function textWidth(font, text, capMm) {
  return font.width(text, sizeFor(font, capMm));
}


function prepare(display) {
  const { positions } = display;
  const triangleCount = positions.length / 9;
  const ids = new Map();
  const coords = [];
  const idOf = (x, y, z) => {
    const key = `${x},${y},${z}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = coords.length / 3;
      coords.push(x, y, z);
      ids.set(key, id);
    }
    return id;
  };
  const corners = new Uint32Array(3 * triangleCount);
  const normals = new Float64Array(3 * triangleCount);
  const owners = new Map();
  for (let t = 0; t < triangleCount; t++) {
    for (let c = 0; c < 3; c++) corners[3 * t + c] = idOf(positions[9 * t + 3 * c], positions[9 * t + 3 * c + 1], positions[9 * t + 3 * c + 2]);
    const a = 9 * t;
    const u = [positions[a + 3] - positions[a], positions[a + 4] - positions[a + 1], positions[a + 5] - positions[a + 2]];
    const v = [positions[a + 6] - positions[a], positions[a + 7] - positions[a + 1], positions[a + 8] - positions[a + 2]];
    const n = cross(u, v);
    const len = Math.hypot(...n);
    if (len > 0) normals.set(n.map((x) => x / len), 3 * t);
    for (let e = 0; e < 3; e++) {
      const p = corners[3 * t + e];
      const q = corners[3 * t + ((e + 1) % 3)];
      if (p === q) continue;
      const key = p < q ? p * 4294967296 + q : q * 4294967296 + p;
      const entry = owners.get(key);
      if (entry === undefined) owners.set(key, [t, -1]);
      else if (entry[1] < 0) entry[1] = t;
    }
  }
  const feature = [];
  const featureKeys = new Set();
  const edges = display.edges;
  for (let i = 0; i < edges.length; i += 6) {
    const p = idOf(edges[i], edges[i + 1], edges[i + 2]);
    const q = idOf(edges[i + 3], edges[i + 4], edges[i + 5]);
    if (p === q) continue;
    feature.push([p, q]);
    featureKeys.add(p < q ? p * 4294967296 + q : q * 4294967296 + p);
  }
  return { coords: Float64Array.from(coords), corners, normals, owners, feature, featureKeys, triangleCount };
}

// Edges where the surface turns away from the viewer or ends
function silhouette(geometry, toward) {
  const { normals, owners, featureKeys } = geometry;
  const found = [];
  for (const [key, [first, second]] of owners) {
    if (featureKeys.has(key)) continue;
    const a = dot(toward, [normals[3 * first], normals[3 * first + 1], normals[3 * first + 2]]);
    let edge = false;
    if (second < 0) edge = true;
    else {
      const b = dot(toward, [normals[3 * second], normals[3 * second + 1], normals[3 * second + 2]]);
      edge = a * b < 0 && Math.max(Math.abs(a), Math.abs(b)) > SILHOUETTE_NOISE;
    }
    if (edge) found.push([Math.floor(key / 4294967296), key % 4294967296]);
  }
  return found;
}

// Polylines (arrays of vertex ids) from segments joined at shared vertices
function chain(segments) {
  const at = new Map();
  segments.forEach(([p, q], i) => {
    for (const v of [p, q]) {
      if (!at.has(v)) at.set(v, []);
      at.get(v).push(i);
    }
  });
  const used = new Uint8Array(segments.length);
  const chains = [];
  const walk = (start, first) => {
    const line = [start];
    let current = start;
    let segment = first;
    while (segment !== undefined && !used[segment]) {
      used[segment] = 1;
      const [p, q] = segments[segment];
      current = p === current ? q : p;
      line.push(current);
      const next = at.get(current);
      segment = next.length === 2 ? next.find((s) => !used[s]) : undefined;
    }
    chains.push(line);
  };
  for (const [v, list] of at) if (list.length !== 2) for (const s of list) if (!used[s]) walk(v, s);
  segments.forEach(([p], i) => {
    if (!used[i]) walk(p, i);
  });
  return chains;
}


// Orthographic view with a depth raster. s: paper mm per model mm
function makeView(geometry, name, scale) {
  const axes = axesOf(name);
  const { coords, corners, triangleCount } = geometry;
  const k = 1000 * scale;
  const count = coords.length / 3;
  const u = new Float64Array(count);
  const v = new Float64Array(count);
  const n = new Float64Array(count);
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (let i = 0; i < count; i++) {
    const p = [coords[3 * i], coords[3 * i + 1], coords[3 * i + 2]];
    u[i] = dot(p, axes.right);
    v[i] = dot(p, axes.up);
    n[i] = dot(p, axes.toward);
    u0 = Math.min(u0, u[i]);
    u1 = Math.max(u1, u[i]);
    v0 = Math.min(v0, v[i]);
    v1 = Math.max(v1, v[i]);
  }
  const widthMm = (u1 - u0) * k;
  const heightMm = (v1 - v0) * k;
  const px = k * PIXELS_PER_MM;
  const cols = Math.ceil((u1 - u0) * px) + 3;
  const rows = Math.ceil((v1 - v0) * px) + 3;
  const depth = new Float64Array(cols * rows).fill(-Infinity);
  const toX = (i) => (u[i] - u0) * px + 1;
  const toY = (i) => (v1 - v[i]) * px + 1;
  for (let t = 0; t < triangleCount; t++) {
    const a = corners[3 * t];
    const b = corners[3 * t + 1];
    const c = corners[3 * t + 2];
    const ax = toX(a);
    const ay = toY(a);
    const bx = toX(b);
    const by = toY(b);
    const cx = toX(c);
    const cy = toY(c);
    const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(area) < 1e-12) continue;
    const xMin = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const xMax = Math.min(cols - 1, Math.ceil(Math.max(ax, bx, cx)));
    const yMin = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const yMax = Math.min(rows - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let y = yMin; y <= yMax; y++) {
      for (let x = xMin; x <= xMax; x++) {
        const sx = x + 0.5;
        const sy = y + 0.5;
        const wa = ((bx - sx) * (cy - sy) - (cx - sx) * (by - sy)) / area;
        const wb = ((cx - sx) * (ay - sy) - (ax - sx) * (cy - sy)) / area;
        const wc = 1 - wa - wb;
        if (wa < -1e-9 || wb < -1e-9 || wc < -1e-9) continue;
        const z = wa * n[a] + wb * n[b] + wc * n[c];
        const index = y * cols + x;
        if (z > depth[index]) depth[index] = z;
      }
    }
  }
  return { name, axes, scale, k, u0, v1, widthMm, heightMm, px, cols, rows, depth, u, v, n, coords };
}

// Visibility of a point given in view coordinates
function visibleAt(view, uu, vv, nn, eps) {
  const x = Math.floor((uu - view.u0) * view.px + 1);
  const y = Math.floor((view.v1 - vv) * view.px + 1);
  let lowest = Infinity;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = x + dx;
      const cy = y + dy;
      const d = cx < 0 || cy < 0 || cx >= view.cols || cy >= view.rows ? -Infinity : view.depth[cy * view.cols + cx];
      if (d < lowest) lowest = d;
    }
  }
  return nn >= lowest - eps;
}

// Draws the lines of a view at paper origin (ox, oy). cell_m: display mesh cell used for the depth tolerance.
function drawLines(page, geometry, view, ox, oy, cell_m, { hidden }) {
  const segments = [...geometry.feature, ...silhouette(geometry, view.axes.toward)];
  const eps = 0.3 * cell_m + 2 / view.px;
  const paper = (i) => [ox + (view.u[i] - view.u0) * view.k, oy + (view.v1 - view.v[i]) * view.k];
  const shown = [];
  const covered = [];
  for (const line of chain(segments)) {
    const points = [];
    for (let s = 1; s < line.length; s++) {
      const a = line[s - 1];
      const b = line[s];
      const [ax, ay] = paper(a);
      const [bx, by] = paper(b);
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / SAMPLE_STEP_MM));
      for (let i = s === 1 ? 0 : 1; i <= steps; i++) {
        const t = i / steps;
        const uu = view.u[a] + (view.u[b] - view.u[a]) * t;
        const vv = view.v[a] + (view.v[b] - view.v[a]) * t;
        const nn = view.n[a] + (view.n[b] - view.n[a]) * t;
        points.push({ x: ax + (bx - ax) * t, y: ay + (by - ay) * t, visible: visibleAt(view, uu, vv, nn, eps) });
      }
    }
    let run = [];
    let state = null;
    const flush = () => {
      if (run.length > 1) (state ? shown : covered).push(run.map((p) => [p.x, p.y]));
      run = [];
    };
    for (const p of points) {
      if (state !== null && p.visible !== state) {
        const last = run[run.length - 1];
        flush();
        if (last) run.push(last);
      }
      state = p.visible;
      run.push(p);
    }
    flush();
  }
  page.cap(0);
  if (hidden) {
    page.lineWidth(HIDDEN_WIDTH);
    page.stroke(BLACK);
    page.dash(HIDDEN_DASH);
    for (const line of covered) page.polyline(line);
    page.dash([]);
  }
  page.lineWidth(MAIN_WIDTH);
  page.stroke(BLACK);
  for (const line of shown) page.polyline(line);
}


function arrow(page, x, y, dx, dy) {
  const nx = -dy;
  const ny = dx;
  page.fill(BLACK);
  page.polygon([[x, y], [x - dx * ARROW.length + nx * ARROW.half, y - dy * ARROW.length + ny * ARROW.half], [x - dx * ARROW.length - nx * ARROW.half, y - dy * ARROW.length - ny * ARROW.half]], 'fill');
}

function horizontalDimension(page, font, { x1, x2, yObject, yLine, label }) {
  const sign = yLine > yObject ? 1 : -1;
  page.lineWidth(THIN_WIDTH);
  page.stroke(BLACK);
  for (const x of [x1, x2]) page.line(x, yObject + sign * 1, x, yLine + sign * 2);
  const width = textWidth(font, label, DIM_TEXT);
  const inside = x2 - x1 >= width + 2 * ARROW.length + 1;
  if (inside) {
    page.line(x1, yLine, x2, yLine);
    arrow(page, x1, yLine, -1, 0);
    arrow(page, x2, yLine, 1, 0);
    drawText(page, font, label, (x1 + x2) / 2, yLine - 0.9, DIM_TEXT, { align: 'center' });
  } else {
    page.line(x1 - ARROW.length - 3, yLine, x2 + ARROW.length + 3 + width + 2, yLine);
    arrow(page, x1, yLine, 1, 0);
    arrow(page, x2, yLine, -1, 0);
    drawText(page, font, label, x2 + ARROW.length + 4, yLine - 0.9, DIM_TEXT);
  }
}

function verticalDimension(page, font, { y1, y2, xObject, xLine, label }) {
  const sign = xLine > xObject ? 1 : -1;
  page.lineWidth(THIN_WIDTH);
  page.stroke(BLACK);
  for (const y of [y1, y2]) page.line(xObject + sign * 1, y, xLine + sign * 2, y);
  const width = textWidth(font, label, DIM_TEXT);
  const middle = (y1 + y2) / 2;
  if (y2 - y1 >= 2 * ARROW.length + 1) {
    page.line(xLine, y1, xLine, y2);
    arrow(page, xLine, y1, 0, -1);
    arrow(page, xLine, y2, 0, 1);
  } else {
    page.line(xLine, y1 - ARROW.length - 3, xLine, y2 + ARROW.length + 3);
    arrow(page, xLine, y1, 0, 1);
    arrow(page, xLine, y2, 0, -1);
  }
  page.rotatedText(label, xLine - 0.9, middle + width / 2, 90, { font, size: sizeFor(font, DIM_TEXT) });
}

// Diameter sign: circle with an oblique stroke, capital height capMm, left edge at x
function diameterSign(page, x, baseline, capMm) {
  const radius = capMm * 0.42;
  const cx = x + radius;
  const cy = baseline - capMm / 2;
  page.lineWidth(THIN_WIDTH);
  page.stroke(BLACK);
  page.circle(cx, cy, radius);
  page.line(cx - radius * 1.25, cy + radius * 1.25, cx + radius * 1.25, cy - radius * 1.25);
  return 2 * radius + 0.8;
}

function diameterDimension(page, font, { cx, cy, r, label }) {
  const a = Math.PI / 4;
  const px = cx + r * Math.cos(a);
  const py = cy - r * Math.sin(a);
  const ex = px + 9;
  const ey = py - 9;
  page.lineWidth(THIN_WIDTH);
  page.stroke(BLACK);
  page.line(px, py, ex, ey);
  const signWidth = 2 * DIM_TEXT * 0.42 + 0.8;
  const width = textWidth(font, label, DIM_TEXT) + signWidth;
  page.line(ex, ey, ex + width + 2, ey);
  arrow(page, px, py, -Math.cos(a), Math.sin(a));
  diameterSign(page, ex + 1, ey - 0.9, DIM_TEXT);
  drawText(page, font, label, ex + 1 + signWidth, ey - 0.9, DIM_TEXT);
}

function centerCross(page, cx, cy, r) {
  page.lineWidth(THIN_WIDTH);
  page.stroke(BLACK);
  page.dash(CENTER_DASH);
  const reach = r + 3;
  page.line(cx - reach, cy, cx + reach, cy);
  page.line(cx, cy - reach, cx, cy + reach);
  page.dash([]);
}


function frame(page) {
  page.stroke(BLACK);
  page.lineWidth(FRAME_WIDTH);
  page.rect(FRAME.x0, FRAME.y0, FRAME.x1 - FRAME.x0, FRAME.y1 - FRAME.y0);
}

function titleBlock(page, font, info) {
  const x0 = FRAME.x0;
  const y0 = BLOCK_TOP;
  const x1 = FRAME.x1;
  const y1 = FRAME.y1;
  const grid = (xa, ya, xb, yb) => {
    page.lineWidth(THIN_WIDTH);
    page.stroke(BLACK);
    page.line(xa, ya, xb, yb);
  };
  const main = (xa, ya, xb, yb) => {
    page.lineWidth(FRAME_WIDTH);
    page.stroke(BLACK);
    page.line(xa, ya, xb, yb);
  };
  const cell = (text, x, y, w, h, cap = 3.5, align = 'center') => {
    if (!text) return;
    const base = y + h / 2 + cap / 2;
    drawText(page, font, text, align === 'center' ? x + w / 2 : x + 1.2, base, cap, { align, width: w - 3 });
  };
  main(x0, y0, x1, y0);
  main(x0 + 65, y0, x0 + 65, y1);
  // left part: columns 7, 10, 23, 15, 10
  const cols = [x0, x0 + 7, x0 + 17, x0 + 40, x0 + 55, x0 + 65];
  for (let r = 1; r <= 4; r++) grid(x0, y0 + 5 * r, x0 + 65, y0 + 5 * r);
  for (const c of [1, 2, 3, 4]) grid(cols[c], y0, cols[c], y0 + 25);
  main(x0, y0 + 25, x0 + 65, y0 + 25);
  const headers = ['Изм.', 'Лист', 'N докум.', 'Подп.', 'Дата'];
  headers.forEach((text, i) => cell(text, cols[i], y0 + 20, cols[i + 1] - cols[i], 5, 2.5));
  for (let r = 1; r <= 5; r++) grid(x0, y0 + 25 + 5 * r, x0 + 65, y0 + 25 + 5 * r);
  grid(cols[3], y0 + 25, cols[3], y1);
  grid(cols[4], y0 + 25, cols[4], y1);
  const roles = ['Разраб.', 'Пров.', 'Т. контр.', '', 'Н. контр.', 'Утв.'];
  roles.forEach((text, i) => cell(text, x0, y0 + 25 + 5 * i, 40, 5, 3.5, 'left'));
  cell(info.date, cols[4], y0 + 25, 10, 5, 2.5);
  // right part
  const rx = x0 + 65;
  grid(rx, y0 + 15, x1, y0 + 15);
  cell(info.designation, rx, y0, 120, 15, 7);
  const nameWidth = 65;
  const litX = rx + nameWidth;
  const massX = litX + 21;
  const scaleX = massX + 17;
  main(rx, y0 + 35, x1, y0 + 35);
  grid(litX, y0 + 15, litX, y0 + 35);
  grid(massX, y0 + 15, massX, y0 + 35);
  grid(scaleX, y0 + 15, scaleX, y0 + 35);
  grid(litX, y0 + 20, x1, y0 + 20);
  grid(litX + 7, y0 + 15, litX + 7, y0 + 20);
  grid(litX + 14, y0 + 15, litX + 14, y0 + 20);
  cell('Лит.', litX, y0 + 15, 21, 5, 2.5);
  cell('Масса', massX, y0 + 15, 17, 5, 2.5);
  cell('Масштаб', scaleX, y0 + 15, 17, 5, 2.5);
  cell(info.mass, massX, y0 + 20, 17, 15, 3.5);
  cell(info.scale, scaleX, y0 + 20, 17, 15, 3.5);
  cell(info.name, rx, y0 + 15, nameWidth, 12, 5);
  cell(info.subname, rx, y0 + 27, nameWidth, 8, 3.5);
  grid(rx + 65, y0 + 35, rx + 65, y1);
  grid(rx, y0 + 45, rx + 65, y0 + 45);
  const materialLines = wrapText(font, info.material, 3, 61);
  materialLines.slice(0, 2).forEach((line, i) => drawText(page, font, line, rx + 1.5, y0 + 35 + (materialLines.length > 1 ? 4.2 + 4 * i : 6.2), 3));
  cell(info.organization, rx, y0 + 45, 65, 10, 3.5);
  const sheetX = rx + 65;
  grid(sheetX + 27, y0 + 35, sheetX + 27, y1);
  grid(sheetX, y0 + 40, x1, y0 + 40);
  cell('Лист', sheetX, y0 + 35, 27, 5, 2.5);
  cell('Листов', sheetX + 27, y0 + 35, 28, 5, 2.5);
  cell(String(info.sheet), sheetX, y0 + 40, 27, 15, 3.5);
  cell(String(info.sheets), sheetX + 27, y0 + 40, 28, 15, 3.5);
  page.lineWidth(FRAME_WIDTH);
  page.stroke(BLACK);
}


function sizeOf(bounds_m) {
  return bounds_m.max.map((hi, a) => (hi - bounds_m.min[a]) * 1000);
}

// Largest standard scale where front, top and left views and gaps for dimensions fit the area
function chooseScale(sizeMm) {
  const [x, y, z] = sizeMm;
  const width = AREA.x1 - AREA.x0;
  const height = AREA.y1 - AREA.y0;
  for (const s of SCALES) {
    if (s * (x + y) + VIEW_GAP <= width && s * (z + y) + VIEW_GAP <= height) return s;
  }
  return SCALES[SCALES.length - 1];
}

function orthographicSheet(ctx, geometry, display, info) {
  const sizeMm = sizeOf(display.bounds_m);
  const s = chooseScale(sizeMm);
  const front = makeView(geometry, 'front', s);
  const top = makeView(geometry, 'top', s);
  const left = makeView(geometry, 'left', s);
  const totalWidth = front.widthMm + VIEW_GAP + left.widthMm;
  const totalHeight = front.heightMm + VIEW_GAP + top.heightMm;
  const startX = AREA.x0 + (AREA.x1 - AREA.x0 - totalWidth) / 2;
  const startY = AREA.y0 + (AREA.y1 - AREA.y0 - totalHeight) / 2;
  const frontAt = [startX, startY];
  const leftAt = [startX + front.widthMm + VIEW_GAP, startY];
  const topAt = [startX, startY + front.heightMm + VIEW_GAP];
  const bores = ctx.model.supports.filter((support) => support.spec.kind === 'bore');
  return {
    draw(page, fonts) {
      frame(page);
      page.save();
      page.clipRect(FRAME.x0 + 1, FRAME.y0 + 1, FRAME.x1 - FRAME.x0 - 2, BLOCK_TOP - FRAME.y0 - 1);
      drawLines(page, geometry, front, frontAt[0], frontAt[1], display.cell_m, { hidden: true });
      drawLines(page, geometry, left, leftAt[0], leftAt[1], display.cell_m, { hidden: true });
      drawLines(page, geometry, top, topAt[0], topAt[1], display.cell_m, { hidden: true });
      for (const bore of bores) {
        const { axis, center_m, radius_m } = bore.spec;
        if (axis !== 2) continue;
        const cx = topAt[0] + (center_m[0] - top.u0) * top.k;
        const cy = topAt[1] + (top.v1 - center_m[1]) * top.k;
        const r = radius_m * top.k;
        centerCross(page, cx, cy, r);
        diameterDimension(page, fonts.regular, { cx, cy, r, label: `${dimText(2 * radius_m)}*` });
      }
      // overall dimensions
      const [x, y, z] = display.bounds_m.max.map((hi, a) => hi - display.bounds_m.min[a]);
      horizontalDimension(page, fonts.regular, {
        x1: frontAt[0], x2: frontAt[0] + front.widthMm, yObject: frontAt[1] + front.heightMm, yLine: frontAt[1] + front.heightMm + DIM_STEP, label: `${dimText(x)}*`,
      });
      horizontalDimension(page, fonts.regular, {
        x1: leftAt[0], x2: leftAt[0] + left.widthMm, yObject: leftAt[1] + left.heightMm, yLine: leftAt[1] + left.heightMm + DIM_STEP, label: `${dimText(y)}*`,
      });
      verticalDimension(page, fonts.regular, {
        y1: frontAt[1], y2: frontAt[1] + front.heightMm, xObject: frontAt[0], xLine: frontAt[0] - DIM_STEP, label: `${dimText(z)}*`,
      });
      page.restore();
      titleBlock(page, fonts.regular, info);
    },
  };
}

function isometricSheet(ctx, geometry, display, info) {
  const probe = makeView(geometry, 'iso', 1);
  const width = AREA.x1 - AREA.x0;
  const height = 125;
  let s = SCALES[SCALES.length - 1];
  for (const candidate of SCALES) {
    if (probe.widthMm * candidate <= width && probe.heightMm * candidate <= height) {
      s = candidate;
      break;
    }
  }
  const view = makeView(geometry, 'iso', s);
  const at = [AREA.x0 + (width - view.widthMm) / 2, AREA.y0 + 4];
  const rows = [
    ...ctx.baseRows.map((r) => [r.label, `${r.value} ${r.unit}`]),
    ...ctx.features.map((f) => [f.name, f.text]),
  ];
  return {
    draw(page, fonts) {
      frame(page);
      page.save();
      page.clipRect(FRAME.x0 + 1, FRAME.y0 + 1, FRAME.x1 - FRAME.x0 - 2, BLOCK_TOP - FRAME.y0 - 1);
      drawLines(page, geometry, view, at[0], at[1], display.cell_m, { hidden: false });
      const caption = 'Изометрическая проекция';
      drawText(page, fonts.regular, caption, AREA.x0 + width / 2, at[1] + view.heightMm + 8, 5, { align: 'center' });
      // dimension table
      let y = at[1] + view.heightMm + 20;
      const tx = FRAME.x0 + 5;
      const tw = FRAME.x1 - FRAME.x0 - 10;
      const split = tw * 0.45;
      drawText(page, fonts.regular, 'Параметры модели, мм', tx, y, 3.5);
      y += 3;
      page.lineWidth(THIN_WIDTH);
      page.stroke(BLACK);
      const rowCap = 3.2;
      for (const [name, text] of rows) {
        const nameLines = wrapText(fonts.regular, name, rowCap, split - 2.4);
        const valueLines = wrapText(fonts.regular, text, rowCap, tw - split - 2.4);
        const count = Math.max(nameLines.length, valueLines.length);
        const h = 1.6 + 4.6 * count;
        if (y + h > BLOCK_TOP - 28) break;
        page.rect(tx, y, split, h);
        page.rect(tx + split, y, tw - split, h);
        nameLines.forEach((line, i) => drawText(page, fonts.regular, line, tx + 1.2, y + 4.3 + 4.6 * i - 0.6, rowCap));
        valueLines.forEach((line, i) => drawText(page, fonts.regular, line, tx + split + 1.2, y + 4.3 + 4.6 * i - 0.6, rowCap));
        y += h;
      }
      // technical requirements
      const lines = [
        '1. * Размеры для справок.',
        '2. Допуски размеров, шероховатость и технологические уклоны не назначены.',
        '3. Чертеж построен по расчетной модели изделия.',
      ];
      let ty = BLOCK_TOP - 22;
      drawText(page, fonts.regular, 'Технические требования', tx, ty, 5);
      ty += 2;
      for (const line of lines) {
        ty += 5.5;
        drawText(page, fonts.regular, line, tx, ty, 3.5, { width: tw });
      }
      page.restore();
      titleBlock(page, fonts.regular, info);
    },
  };
}

// ctx: report context; display: display mesh of the worker. Returns sheets with draw(page, fonts).
export function buildDrawingSheets(ctx, display) {
  const geometry = prepare(display);
  const sizeMm = sizeOf(display.bounds_m);
  const scale = chooseScale(sizeMm);
  const common = {
    designation: ctx.designation,
    name: ctx.templateName,
    subname: ctx.features.length ? 'Вариант с усилениями' : 'Расчетная модель',
    material: ctx.material.name,
    organization: '',
    mass: `${formatNumber(ctx.summary.mass_kg, 3)} кг`,
    date: ctx.dateText.slice(0, 5),
  };
  return [
    orthographicSheet(ctx, geometry, display, { ...common, scale: scaleText(scale), sheet: 1, sheets: 2 }),
    isometricSheet(ctx, geometry, display, { ...common, scale: '', sheet: 2, sheets: 2 }),
  ];
}
