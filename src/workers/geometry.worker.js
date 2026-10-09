// Worker: display mesh, analysis, STL export. Messages: { id, type, payload } in, { id, kind, ... } out.

import { buildModel } from '../geometry/model.js';
import { dualContour, shadedSoup, featureEdges, edgeReport, meshVolume } from '../geometry/mesh.js';
import { analyze } from '../fea/analysis.js';
import { supportTest } from '../fea/supports.js';
import { binaryStl } from '../geometry/stl.js';

// Normal smoothing limit and crease line limit
const SHADE_CREASE_RAD = (35 * Math.PI) / 180;
const LINE_CREASE_RAD = (30 * Math.PI) / 180;
// Display mesh: cells across the thinnest feature, and bounds on cells along the longest side
const DISPLAY_CELLS_ACROSS = 3;
const DISPLAY_LONGEST_MIN = 80;
const DISPLAY_LONGEST_MAX = 300;
// Export mesh: finer limits
const EXPORT_CELLS_ACROSS = 4;
const EXPORT_LONGEST_MIN = 150;
const EXPORT_LONGEST_MAX = 450;
// Reinforcement vertex test: distance from the base surface in cells
const REINFORCEMENT_CELLS = 0.35;

function meshCellSize(model, acrossCells, longestMin, longestMax) {
  const size = model.bounds_m.max.map((hi, a) => hi - model.bounds_m.min[a]);
  const longest = Math.max(...size);
  return Math.min(longest / longestMin, Math.max(longest / longestMax, model.minFeature_m / acrossCells));
}

function modelOf(spec) {
  const { model, errors } = buildModel(spec.templateId, spec.base, spec.features);
  if (!model) throw new Error(`model: invalid (${errors.map((e) => `${e.label}: ${e.message}`).join('; ')})`);
  return model;
}

const handlers = {
  display(spec) {
    const model = modelOf(spec);
    const h = meshCellSize(model, DISPLAY_CELLS_ACROSS, DISPLAY_LONGEST_MIN, DISPLAY_LONGEST_MAX);
    const mesh = dualContour(model.sdf, model.bounds_m, h);
    const soup = shadedSoup(mesh, SHADE_CREASE_RAD);
    const edges = featureEdges(mesh, LINE_CREASE_RAD);
    const flags = new Uint8Array(soup.positions.length / 3);
    const tests = model.supports.map((s) => supportTest(s.spec, [h, h, h]));
    const hasFeatures = spec.features.length > 0;
    for (let v = 0; v < flags.length; v++) {
      const x = soup.positions[3 * v];
      const y = soup.positions[3 * v + 1];
      const z = soup.positions[3 * v + 2];
      let flag = 0;
      if (hasFeatures && Math.abs(model.baseSdf(x, y, z)) > REINFORCEMENT_CELLS * h) flag |= 1;
      if (tests.some((t) => t(x, y, z))) flag |= 2;
      flags[v] = flag;
    }
    return {
      output: { positions: soup.positions, normals: soup.normals, flags, edges, triangleCount: soup.triangleCount, cell_m: h, bounds_m: model.bounds_m },
      transfer: [soup.positions.buffer, soup.normals.buffer, flags.buffer, edges.buffer],
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
