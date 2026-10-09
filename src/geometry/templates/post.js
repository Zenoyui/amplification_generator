// Post on a square base plate, base bottom face (z = 0) fixed, post axis along z

import { boxFromCorners, cylinder, extrudePolygon, joinWithFillet, revolvedBox, rotatedAboutZ, mergeBounds, unionAll } from '../sdf.js';
import { numberSpec, enumSpec } from '../params.js';

const params = [
  numberSpec('baseSide_m', 'Сторона основания', 80, 20, 400),
  numberSpec('baseThickness_m', 'Толщина основания', 8, 2, 50),
  numberSpec('postRadius_m', 'Радиус стойки', 12, 3, 100),
  numberSpec('height_m', 'Высота от низа основания', 150, 30, 600),
];

const COUNTS = [
  { value: '2', label: '2' },
  { value: '4', label: '4' },
];

const freeBase = (b) => b.baseSide_m / 2 - b.postRadius_m;
const freePost = (b) => b.height_m - b.baseThickness_m;

const filletSpecs = (b) => [numberSpec('radius_m', 'Радиус скругления', Math.max(1, Math.min(10, Math.floor(freeBase(b) * 1000 * 0.4))), 0.5, 100)];
const filletCheck = (b, v) => (v.radius_m > freeBase(b) * 0.95 ? ['радиус скругления больше свободной части основания'] : []);

const gussetSpecs = (b) => [
  enumSpec('count', 'Количество косынок', COUNTS, '4'),
  numberSpec('thickness_m', 'Толщина косынки', Math.max(2, Math.round(b.baseThickness_m * 1000 * 0.5)), 0.8, 40),
  numberSpec('legBase_m', 'Катет по основанию', Math.max(3, Math.round(freeBase(b) * 1000 * 0.8)), 3, 190),
  numberSpec('legPost_m', 'Катет по стойке', Math.max(5, Math.round(freePost(b) * 1000 * 0.35)), 5, 590),
  numberSpec('root_m', 'Радиус у основания', 2, 0, 20),
];
const gussetCheck = (b, v) => {
  const problems = [];
  if (v.legBase_m > freeBase(b) + 1e-9) problems.push('катет по основанию выходит за край основания');
  if (v.legPost_m > freePost(b) + 1e-9) problems.push('катет по стойке больше высоты стойки');
  return problems;
};

function gussetSolid(b, v) {
  const rp = b.postRadius_m;
  const tb = b.baseThickness_m;
  const overlap = Math.min(rp, tb) * 0.5;
  const polygon = [
    [rp - overlap, tb - overlap],
    [rp + v.legBase_m, tb - overlap],
    [rp + v.legBase_m, tb],
    [rp, tb + v.legPost_m],
    [rp - overlap, tb + v.legPost_m],
  ];
  const count = Number(v.count);
  const shapes = [];
  for (let i = 0; i < count; i++) {
    const angle_rad = (2 * Math.PI * i) / count;
    // polygon in plane (radial, z), extruded across the tangential direction
    const local = extrudePolygon('zx', polygon.map(([s, z]) => [z, s]), [-v.thickness_m / 2, v.thickness_m / 2]);
    shapes.push(rotatedAboutZ(local, 0, 0, angle_rad));
  }
  const reach = rp + v.legBase_m;
  return {
    sdf: unionAll(shapes),
    bounds: { min: [-reach, -reach, tb - overlap], max: [reach, reach, tb + v.legPost_m] },
    zone: boxFromCorners([-reach - v.root_m, -reach - v.root_m, tb], [reach + v.root_m, reach + v.root_m, tb + v.legPost_m]),
  };
}

export const post = {
  id: 'post',
  name: 'Стойка на основании',
  params,
  features: {
    fillet: { name: 'Скругление стойки у основания', specs: filletSpecs, check: filletCheck, unique: true },
    gusset: { name: 'Косынки вокруг стойки', specs: gussetSpecs, check: gussetCheck, unique: true },
  },
  checkBase(b) {
    const problems = [];
    if (b.postRadius_m * 2 >= b.baseSide_m) problems.push('диаметр стойки не меньше стороны основания');
    if (b.height_m <= b.baseThickness_m * 2) problems.push('высота меньше двух толщин основания');
    return problems;
  },
  build(b, featureList) {
    const half = b.baseSide_m / 2;
    const base = boxFromCorners([-half, -half, 0], [half, half, b.baseThickness_m]);
    const column = cylinder('z', [0, 0, b.height_m / 2], b.postRadius_m, b.height_m / 2);
    const cornerRadius_m = featureList.filter((f) => f.kind === 'fillet').reduce((m, f) => Math.max(m, f.parameters.radius_m), 0);
    const cornerZone = revolvedBox(b.postRadius_m, b.postRadius_m + cornerRadius_m, b.baseThickness_m, b.baseThickness_m + cornerRadius_m);
    let sdf = joinWithFillet(base, column, cornerRadius_m, cornerZone);
    const boundsList = [{ min: [-half, -half, 0], max: [half, half, b.height_m] }];
    let minFeature_m = Math.min(b.baseThickness_m, 2 * b.postRadius_m);
    let minRadius_m = Math.min(b.postRadius_m, cornerRadius_m > 0 ? cornerRadius_m : Infinity);
    for (const feature of featureList) {
      if (feature.kind === 'fillet') continue;
      const solid = gussetSolid(b, feature.parameters);
      sdf = joinWithFillet(sdf, solid.sdf, feature.parameters.root_m, solid.zone);
      boundsList.push(solid.bounds);
      minFeature_m = Math.min(minFeature_m, feature.parameters.thickness_m);
      if (feature.parameters.root_m > 0) minRadius_m = Math.min(minRadius_m, feature.parameters.root_m);
    }
    const sideOffset_m = Math.min(0.1 * b.height_m, 0.02);
    return {
      sdf,
      bounds_m: mergeBounds(boundsList),
      minFeature_m,
      minRadius_m,
      supports: [{ id: 'floor', label: 'Нижняя плоскость основания', spec: { kind: 'plane', axis: 2, coord_m: 0 } }],
      loadPresets: [
        { id: 'side', label: 'Боковая поверхность у верха стойки', point_m: [b.postRadius_m, 0, b.height_m - sideOffset_m], outwardNormal: [1, 0, 0] },
        { id: 'top', label: 'Верхний торец стойки', point_m: [0, 0, b.height_m], outwardNormal: [0, 0, 1] },
      ],
    };
  },
};
