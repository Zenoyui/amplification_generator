// Worker: display mesh, analysis, STL export. Messages: { id, type, payload } in, { id, kind, ... } out.

import { modelOfSpec } from '../geometry/model.js';
import { parseStl, prepareUpload, estimateThickness } from '../geometry/upload.js';
import { dualContour, shadedSoup, featureEdges, edgeReport, meshVolume } from '../geometry/mesh.js';
import { analyze, analyzeCheck } from '../fea/analysis.js';
import { supportTest } from '../fea/supports.js';
import { binaryStl } from '../geometry/stl.js';

// Normal smoothing limit and crease line limit
const SHADE_CREASE_RAD = (35 * Math.PI) / 180;
const LINE_CREASE_RAD = (30 * Math.PI) / 180;
// Display mesh: cells across the thinnest feature, and bounds on cells along the longest side
const DISPLAY_CELLS_ACROSS = 3;
const DISPLAY_LONGEST_MIN = 80;
const DISPLAY_LONGEST_MAX = 500;
// Cells along the longest side: tolerance of the support highlight of an uploaded part
const UPLOAD_DISPLAY_CELLS = 300;
// Cells across the smallest radius of a model
const RADIUS_CELLS = 2;
// Export mesh: finer limits
const EXPORT_CELLS_ACROSS = 4;
const EXPORT_LONGEST_MIN = 150;
const EXPORT_LONGEST_MAX = 450;
// Reinforcement color share: 0 within REINFORCEMENT_NEAR cells of the base surface, 1 beyond NEAR + BLEND
const REINFORCEMENT_NEAR = 0.3;
const REINFORCEMENT_BLEND = 0.7;

function meshCellSize(model, acrossCells, longestMin, longestMax) {
  const size = model.bounds_m.max.map((hi, a) => hi - model.bounds_m.min[a]);
  const longest = Math.max(...size);
  const radiusLimit_m = Number.isFinite(model.minRadius_m) ? model.minRadius_m / RADIUS_CELLS : Infinity;
  return Math.max(longest / longestMax, Math.min(longest / longestMin, model.minFeature_m / acrossCells, radiusLimit_m));
}

function modelOf(spec) {
  const { model, errors } = modelOfSpec(spec);
  if (!model) throw new Error(`model: invalid (${errors.map((e) => `${e.label}: ${e.message}`).join('; ')})`);
  return model;
}

// Display data of an uploaded part: its own triangles, smooth normals, support highlight
function uploadDisplay(model) {
  const longest_m = Math.max(...model.bounds_m.max);
  const soup = shadedSoup(model.mesh, SHADE_CREASE_RAD);
  const edges = featureEdges(model.mesh, LINE_CREASE_RAD);
  const vertexCount = soup.positions.length / 3;
  const support = new Uint8Array(vertexCount);
  const cell_m = longest_m / UPLOAD_DISPLAY_CELLS;
  const tests = model.supports.map((s) => supportTest(s.spec, [cell_m, cell_m, cell_m]));
  for (let v = 0; v < vertexCount; v++) {
    if (tests.some((t) => t(soup.positions[3 * v], soup.positions[3 * v + 1], soup.positions[3 * v + 2]))) support[v] = 255;
  }
  const reinforcement = new Uint8Array(vertexCount);
  return {
    output: { positions: soup.positions, normals: soup.normals, reinforcement, support, edges, triangleCount: soup.triangleCount, cell_m, bounds_m: model.bounds_m },
    transfer: [soup.positions.buffer, soup.normals.buffer, reinforcement.buffer, support.buffer, edges.buffer],
  };
}

const handlers = {
  // buffer: bytes of an STL file; returns the welded mesh, its report and the thinnest wall
  upload({ buffer, scale_m, up }) {
    const prepared = prepareUpload(parseStl(buffer), { scale_m, up });
    const thickness_m = estimateThickness(prepared.mesh);
    return {
      output: { mesh: prepared.mesh, bounds_m: prepared.bounds_m, report: prepared.report, thickness_m },
      transfer: [prepared.mesh.positions.buffer, prepared.mesh.indices.buffer],
    };
  },

  check(payload, progress) {
    const model = modelOf(payload.spec);
    return { output: analyzeCheck(model, payload.setup, progress), transfer: [] };
  },

  display(spec) {
    const model = modelOf(spec);
    if (model.kind === 'mesh') return uploadDisplay(model);
    const h = meshCellSize(model, DISPLAY_CELLS_ACROSS, DISPLAY_LONGEST_MIN, DISPLAY_LONGEST_MAX);
    const mesh = dualContour(model.sdf, model.bounds_m, h);
    const soup = shadedSoup(mesh, SHADE_CREASE_RAD);
    const edges = featureEdges(mesh, LINE_CREASE_RAD);
    const vertexCount = soup.positions.length / 3;
    const reinforcement = new Uint8Array(vertexCount);
    const support = new Uint8Array(vertexCount);
    const tests = model.supports.map((s) => supportTest(s.spec, [h, h, h]));
    const hasFeatures = spec.features.length > 0;
    for (let v = 0; v < vertexCount; v++) {
      const x = soup.positions[3 * v];
      const y = soup.positions[3 * v + 1];
      const z = soup.positions[3 * v + 2];
      if (hasFeatures) {
        const away = (Math.abs(model.baseSdf(x, y, z)) - REINFORCEMENT_NEAR * h) / (REINFORCEMENT_BLEND * h);
        reinforcement[v] = Math.round(255 * Math.min(1, Math.max(0, away)));
      }
      if (tests.some((t) => t(x, y, z))) support[v] = 255;
    }
    return {
      output: { positions: soup.positions, normals: soup.normals, reinforcement, support, edges, triangleCount: soup.triangleCount, cell_m: h, bounds_m: model.bounds_m },
      transfer: [soup.positions.buffer, soup.normals.buffer, reinforcement.buffer, support.buffer, edges.buffer],
    };
  },

  analyze(payload, progress) {
    const model = modelOf(payload.spec);
    const analysis = analyze(model, payload.setup, progress);
    const nodes = analysis.solve.nodes;
    const transfer = [nodes.displacement_m.buffer, nodes.stress_pa.buffer, nodes.count.buffer, nodes.mises_pa.buffer, nodes.excluded.buffer, nodes.active.buffer];
    for (const field of Object.values(nodes.safety)) transfer.push(field.buffer);
    return { output: analysis, transfer };
  },

  stl(spec) {
    const model = modelOf(spec);
    if (model.kind === 'mesh') {
      const bytes = binaryStl(model.mesh, 'amplification part');
      return { output: { bytes, triangleCount: model.mesh.indices.length / 3, cell_m: 0, edges: edgeReport(model.mesh), volume_m3: model.volume_m3 }, transfer: [bytes.buffer] };
    }
    const h = meshCellSize(model, EXPORT_CELLS_ACROSS, EXPORT_LONGEST_MIN, EXPORT_LONGEST_MAX);
    const mesh = dualContour(model.sdf, model.bounds_m, h);
    const bytes = binaryStl(mesh, 'amplification part');
    return { output: { bytes, triangleCount: mesh.indices.length / 3, cell_m: h, edges: edgeReport(mesh), volume_m3: meshVolume(mesh) }, transfer: [bytes.buffer] };
  },
};

self.onmessage = (event) => {
  const { id, type, payload } = event.data;
  try {
    const job = handlers[type];
    if (!job) throw new Error(`job unknown (type=${type})`);
    const { output, transfer } = job(payload, (info) => self.postMessage({ id, kind: 'progress', info }));
    self.postMessage({ id, kind: 'result', output }, transfer);
  } catch (error) {
    self.postMessage({ id, kind: 'error', message: error.message });
  }
};
