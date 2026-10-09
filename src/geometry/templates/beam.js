// Cantilever bar of rectangular section, fixed at x = 0

import { boxFromCorners, joinWithFillet, mergeBounds } from '../sdf.js';
import { numberSpec, enumSpec } from '../params.js';

const SIDES = [
  { value: 'bottom', label: 'снизу' },
  { value: 'top', label: 'сверху' },
];

const params = [
  numberSpec('length_m', 'Длина', 200, 40, 800),
  numberSpec('width_m', 'Ширина', 20, 4, 150),
  numberSpec('height_m', 'Высота', 10, 3, 150),
];

// Longitudinal rib on the bottom or top face
const ribSpecs = (base) => [
  enumSpec('side', 'Сторона', SIDES, 'bottom'),
  numberSpec('thickness_m', 'Толщина ребра', Math.max(1, Math.round(base.width_m * 1000 * 0.25)), 0.8, 60),
  numberSpec('height_m', 'Высота ребра', Math.max(2, Math.round(base.height_m * 1000)), 1, 120),
  numberSpec('length_m', 'Длина ребра', Math.round(base.length_m * 1000), 10, 800),
  numberSpec('offset_m', 'Смещение от оси', 0, -75, 75),
  numberSpec('root_m', 'Радиус у основания', Math.max(0, Math.round(base.height_m * 1000 * 0.25)), 0, 20),
];

function ribCheck(base, v) {
  const problems = [];
  if (v.length_m > base.length_m + 1e-9) problems.push('длина ребра больше длины бруса');
  if (Math.abs(v.offset_m) + v.thickness_m / 2 > base.width_m / 2 + 1e-9) problems.push('ребро выходит за ширину бруса');
  if (v.root_m > v.height_m) problems.push('радиус у основания больше высоты ребра');
  return problems;
}

function ribSolid(base, v) {
  const yc = base.width_m / 2 + v.offset_m;
  const zLo = v.side === 'bottom' ? -v.height_m : base.height_m;
  const zHi = v.side === 'bottom' ? 0 : base.height_m + v.height_m;
  return {
    sdf: boxFromCorners([0, yc - v.thickness_m / 2, zLo], [v.length_m, yc + v.thickness_m / 2, zHi]),
    bounds: { min: [0, yc - v.thickness_m / 2, zLo], max: [v.length_m, yc + v.thickness_m / 2, zHi] },
  };
}

export const beam = {
  id: 'beam',
  name: 'Консольный брус',
  params,
  features: {
    rib: { name: 'Ребро жесткости', specs: ribSpecs, check: ribCheck },
  },
  build(base, featureList) {
    const body = boxFromCorners([0, 0, 0], [base.length_m, base.width_m, base.height_m]);
    let sdf = body;
    const boundsList = [{ min: [0, 0, 0], max: [base.length_m, base.width_m, base.height_m] }];
    let minFeature_m = Math.min(base.width_m, base.height_m);
    let minRadius_m = Infinity;
    for (const feature of featureList) {
      const solid = ribSolid(base, feature.values);
      sdf = joinWithFillet(sdf, solid.sdf, feature.values.root_m);
      boundsList.push(solid.bounds);
      minFeature_m = Math.min(minFeature_m, feature.values.thickness_m);
      if (feature.values.root_m > 0) minRadius_m = Math.min(minRadius_m, feature.values.root_m);
    }
    const tipOffset_m = Math.min(0.1 * base.length_m, 0.02);
    return {
      sdf,
      bounds_m: mergeBounds(boundsList),
      minFeature_m,
      minRadius_m,
      supports: [{ id: 'root', label: 'Торец x = 0', spec: { kind: 'plane', axis: 0, coord_m: 0 } }],
      loadPresets: [
        { id: 'tip', label: 'Свободный конец, верхняя грань', point_m: [base.length_m - tipOffset_m, base.width_m / 2, base.height_m], outwardNormal: [0, 0, 1] },
        { id: 'middle', label: 'Середина длины, верхняя грань', point_m: [base.length_m / 2, base.width_m / 2, base.height_m], outwardNormal: [0, 0, 1] },
      ],
    };
  },
};
