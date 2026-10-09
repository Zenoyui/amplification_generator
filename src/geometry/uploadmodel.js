// Model object of an uploaded part with the fields the analysis and the page read from template models

import { buildMeshField } from './meshfield.js';
import { pickMesh } from './upload.js';

// Cell-centered rays tried for the default load point, as offsets from the box center in shares of the size
const TOP_PROBES = [[0, 0], [0.15, 0], [-0.15, 0], [0, 0.15], [0, -0.15], [0.3, 0.3], [-0.3, 0.3], [0.3, -0.3], [-0.3, -0.3]];

export const planeSupport = (axis, coord_m, label) => ({ id: `plane${axis}-${coord_m}`, label, spec: { kind: 'plane', axis, coord_m } });

// Highest surface point near the box center, found by rays pointing down
function topPoint(mesh, bounds_m) {
  const size = bounds_m.max.map((hi, a) => hi - bounds_m.min[a]);
  const top = bounds_m.max[2] + 0.01 * size[2] + 1e-6;
  for (const [u, v] of TOP_PROBES) {
    const origin = [bounds_m.min[0] + size[0] * (0.5 + u), bounds_m.min[1] + size[1] * (0.5 + v), top];
    const hit = pickMesh(mesh, origin, [0, 0, -1], 2 * size[2] + 1e-3);
    if (hit) return { point_m: hit.point, outwardNormal: hit.outwardNormal };
  }
  return null;
}

// upload: { title, mesh, bounds_m, report, thickness_m, supports }
export function buildUploadModel(upload) {
  const { mesh, bounds_m, report } = upload;
  const size = bounds_m.max.map((hi, a) => hi - bounds_m.min[a]);
  const top = topPoint(mesh, bounds_m);
  const model = {
    kind: 'mesh',
    templateName: upload.title,
    bounds_m,
    minFeature_m: upload.thickness_m ?? Math.min(...size),
    minRadius_m: Infinity,
    volume_m3: report.volume_m3,
    mesh,
    supports: upload.supports,
    loadPresets: top ? [{ id: 'top', label: 'Верхняя точка около центра', point_m: top.point_m, outwardNormal: top.outwardNormal }] : [],
    features: [],
    baseSpecs: [],
    base_m: {},
    sdf: null,
    baseSdf: null,
    pick: (origin, direction, maxDistance_m) => pickMesh(mesh, origin, direction, maxDistance_m),
    // Builds the distance field; needed by the solver, not by the page
    attachField(cell_m) {
      const field = buildMeshField(mesh, bounds_m, cell_m);
      model.sdf = field.sdf;
      model.baseSdf = field.sdf;
      model.fieldCell_m = field.cell_m;
    },
  };
  return model;
}
