// Uploaded part: STL parsing, units and axes, welding, closed-surface checks, ray picking, wall thickness

import { edgeReport, meshVolume } from './mesh.js';

const BINARY_HEADER_BYTES = 80;
const BINARY_TRIANGLE_BYTES = 50;
const MAX_TRIANGLES = 1500000;
// Vertices closer than this share of the bounding box diagonal are welded
const WELD_RELATIVE = 1e-7;
// Share of edges without a pair above which the model is refused
const OPEN_EDGE_REFUSE = 0.01;
// Rays for the wall thickness estimate and the percentile of the hit distances taken as the thinnest wall
const THICKNESS_RAYS = 1200;
const THICKNESS_PERCENTILE = 0.03;
const THICKNESS_TRIANGLE_BUDGET = 3e8;
const RAY_EPSILON = 1e-12;

export const UNITS = [
  { id: 'mm', label: 'мм', scale_m: 0.001 },
  { id: 'cm', label: 'см', scale_m: 0.01 },
  { id: 'm', label: 'м', scale_m: 1 },
  { id: 'in', label: 'дюйм', scale_m: 0.0254 },
];

export class UploadError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'UploadError';
    this.code = code;
    this.details = details;
  }
}

function parseAscii(text) {
  const numbers = [];
  for (const match of text.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/gi)) numbers.push(Number(match[1]), Number(match[2]), Number(match[3]));
  if (numbers.length === 0 || numbers.length % 9 !== 0) throw new UploadError('stl', 'ascii vertex count is not a multiple of 3', { vertices: numbers.length / 3 });
  return Float64Array.from(numbers);
}

// Triangle soup of a binary or ASCII STL, 9 numbers per triangle in file units
export function parseStl(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 15) throw new UploadError('stl', 'file too short', { bytes: bytes.length });
  const view = new DataView(buffer);
  const declared = bytes.length >= BINARY_HEADER_BYTES + 4 ? view.getUint32(BINARY_HEADER_BYTES, true) : -1;
  let positions;
  if (declared >= 0 && BINARY_HEADER_BYTES + 4 + declared * BINARY_TRIANGLE_BYTES === bytes.length) {
    if (declared > MAX_TRIANGLES) throw new UploadError('stl', 'too many triangles', { triangles: declared, limit: MAX_TRIANGLES });
    positions = new Float64Array(9 * declared);
    for (let t = 0; t < declared; t++) {
      const base = BINARY_HEADER_BYTES + 4 + t * BINARY_TRIANGLE_BYTES + 12;
      for (let k = 0; k < 9; k++) positions[9 * t + k] = view.getFloat32(base + 4 * k, true);
    }
  } else {
    positions = parseAscii(new TextDecoder().decode(bytes));
    if (positions.length / 9 > MAX_TRIANGLES) throw new UploadError('stl', 'too many triangles', { triangles: positions.length / 9, limit: MAX_TRIANGLES });
  }
  for (let i = 0; i < positions.length; i++) if (!Number.isFinite(positions[i])) throw new UploadError('stl', 'vertex coordinate is not a number', { index: i });
  return positions;
}

// Soup in file units -> welded mesh in meters, z up, bounding box minimum at the origin.
// up: 'z' | 'y' (file axis that points up). Returns { mesh: { positions, indices }, bounds_m, report }.
export function prepareUpload(soup, { scale_m, up }) {
  if (!(scale_m > 0)) throw new UploadError('units', 'scale must be above zero', { scale_m });
  const count = soup.length / 3;
  const points = new Float64Array(soup.length);
  for (let v = 0; v < count; v++) {
    const x = soup[3 * v] * scale_m;
    const y = soup[3 * v + 1] * scale_m;
    const z = soup[3 * v + 2] * scale_m;
    points.set(up === 'y' ? [x, -z, y] : [x, y, z], 3 * v);
  }
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < count; v++) {
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], points[3 * v + a]);
      max[a] = Math.max(max[a], points[3 * v + a]);
    }
  }
  const diagonal_m = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  if (!(diagonal_m > 0)) throw new UploadError('stl', 'zero size', {});
  const weld_m = WELD_RELATIVE * diagonal_m;
  const ids = new Map();
  const unique = [];
  const indices = [];
  const idOf = (v) => {
    const key = [0, 1, 2].map((a) => Math.round((points[3 * v + a] - min[a]) / weld_m)).join(',');
    let id = ids.get(key);
    if (id === undefined) {
      id = unique.length / 3;
      ids.set(key, id);
      unique.push(points[3 * v] - min[0], points[3 * v + 1] - min[1], points[3 * v + 2] - min[2]);
    }
    return id;
  };
  let degenerate = 0;
  for (let t = 0; t < count / 3; t++) {
    const a = idOf(3 * t);
    const b = idOf(3 * t + 1);
    const c = idOf(3 * t + 2);
    if (a === b || b === c || a === c) {
      degenerate++;
      continue;
    }
    indices.push(a, b, c);
  }
  const mesh = { positions: Float64Array.from(unique), indices: Uint32Array.from(indices) };
  if (mesh.indices.length === 0) throw new UploadError('stl', 'no triangles with area', { degenerate });
  const edges = edgeReport(mesh);
  const openShare = (edges.open + edges.overshared) / edges.edges;
  if (openShare > OPEN_EDGE_REFUSE) throw new UploadError('open', 'surface is not closed', { openEdges: edges.open, oversharedEdges: edges.overshared, share: openShare });
  let volume_m3 = meshVolume(mesh);
  if (volume_m3 < 0) {
    for (let t = 0; t < mesh.indices.length; t += 3) [mesh.indices[t + 1], mesh.indices[t + 2]] = [mesh.indices[t + 2], mesh.indices[t + 1]];
    volume_m3 = -volume_m3;
  }
  if (!(volume_m3 > 0)) throw new UploadError('stl', 'volume is not above zero', { volume_m3 });
  const size_m = [0, 1, 2].map((a) => max[a] - min[a]);
  return {
    mesh,
    bounds_m: { min: [0, 0, 0], max: size_m },
    report: { triangles: mesh.indices.length / 3, vertices: mesh.positions.length / 3, degenerate, openEdges: edges.open, oversharedEdges: edges.overshared, volume_m3, size_m },
  };
}

function subtract(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

// Moeller-Trumbore. Returns the ray parameter of the hit or -1.
function hitTriangle(origin, direction, a, b, c) {
  const e1 = subtract(b, a);
  const e2 = subtract(c, a);
  const p = [direction[1] * e2[2] - direction[2] * e2[1], direction[2] * e2[0] - direction[0] * e2[2], direction[0] * e2[1] - direction[1] * e2[0]];
  const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
  if (Math.abs(det) < RAY_EPSILON) return -1;
  const s = subtract(origin, a);
  const u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) / det;
  if (u < 0 || u > 1) return -1;
  const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
  const v = (direction[0] * q[0] + direction[1] * q[1] + direction[2] * q[2]) / det;
  if (v < 0 || u + v > 1) return -1;
  return (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
}

function corners(mesh, t) {
  const { positions, indices } = mesh;
  return [0, 1, 2].map((k) => [positions[3 * indices[3 * t + k]], positions[3 * indices[3 * t + k] + 1], positions[3 * indices[3 * t + k] + 2]]);
}

// Nearest surface hit along a ray: { point, outwardNormal, distance } or null. The normal faces the ray origin.
export function pickMesh(mesh, origin, direction, maxDistance_m) {
  let best = Infinity;
  let bestTriangle = -1;
  for (let t = 0; t < mesh.indices.length / 3; t++) {
    const [a, b, c] = corners(mesh, t);
    const hit = hitTriangle(origin, direction, a, b, c);
    if (hit > 0 && hit < best && hit < maxDistance_m) {
      best = hit;
      bestTriangle = t;
    }
  }
  if (bestTriangle < 0) return null;
  const [a, b, c] = corners(mesh, bestTriangle);
  const e1 = subtract(b, a);
  const e2 = subtract(c, a);
  let normal = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  const length = Math.hypot(...normal);
  normal = normal.map((v) => v / length);
  if (normal[0] * direction[0] + normal[1] * direction[1] + normal[2] * direction[2] > 0) normal = normal.map((v) => -v);
  return { point: origin.map((v, k) => v + direction[k] * best), outwardNormal: normal, distance: best };
}

// Thinnest wall: rays from face centers along the inward normal, hit distance to the opposite surface.
// Takes a low percentile of the hit distances, so a few rays near edges do not set the result.
export function estimateThickness(mesh) {
  const triangleCount = mesh.indices.length / 3;
  const rays = Math.max(60, Math.min(THICKNESS_RAYS, Math.floor(THICKNESS_TRIANGLE_BUDGET / triangleCount)));
  const stride = Math.max(1, Math.floor(triangleCount / rays));
  const distances = [];
  for (let t = 0; t < triangleCount; t += stride) {
    const [a, b, c] = corners(mesh, t);
    const e1 = subtract(b, a);
    const e2 = subtract(c, a);
    const normal = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const length = Math.hypot(...normal);
    const inward = normal.map((v) => -v / length);
    const centroid = [0, 1, 2].map((k) => (a[k] + b[k] + c[k]) / 3);
    const nudge = 1e-9;
    const origin = centroid.map((v, k) => v + inward[k] * nudge);
    let nearest = Infinity;
    for (let u = 0; u < triangleCount; u++) {
      if (u === t) continue;
      const [p, q, r] = corners(mesh, u);
      const hit = hitTriangle(origin, inward, p, q, r);
      if (hit > nudge && hit < nearest) nearest = hit;
    }
    if (Number.isFinite(nearest)) distances.push(nearest);
  }
  if (distances.length === 0) return null;
  distances.sort((x, y) => x - y);
  return distances[Math.floor(THICKNESS_PERCENTILE * (distances.length - 1))];
}
