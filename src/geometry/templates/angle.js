// Angle bracket: wall plate (y = 0 .. tw, fixed back face) and horizontal arm along +y

import { boxFromCorners, extrudePolygon, joinWithFillet, union, mergeBounds } from '../sdf.js';
import { numberSpec } from '../params.js';

const params = [
  numberSpec('width_m', 'Ширина', 60, 10, 300),
  numberSpec('wallHeight_m', 'Высота стойки', 80, 20, 400),
  numberSpec('armLength_m', 'Вылет полки', 100, 20, 400),
  numberSpec('wallThickness_m', 'Толщина стойки', 5, 1, 40),
  numberSpec('armThickness_m', 'Толщина полки', 5, 1, 40),
];

const freeArm = (b) => b.armLength_m - b.wallThickness_m;
const freeWall = (b) => b.wallHeight_m - b.armThickness_m;

const filletSpecs = (b) => [numberSpec('radius_m', 'Радиус скругления', Math.min(8, Math.floor(Math.min(freeArm(b), freeWall(b)) * 1000 * 0.3)), 0.5, 100)];
const filletCheck = (b, v) => (v.radius_m > Math.min(freeArm(b), freeWall(b)) * 0.9 ? ['радиус больше свободной части полки или стойки'] : []);

const gussetSpecs = (b) => [
  numberSpec('thickness_m', 'Толщина косынки', Math.max(2, Math.round(Math.min(b.wallThickness_m, b.armThickness_m) * 1000)), 0.8, 40),
  numberSpec('legArm_m', 'Катет по полке', Math.round(freeArm(b) * 1000 * 0.7), 5, 380),
  numberSpec('legWall_m', 'Катет по стойке', Math.round(freeWall(b) * 1000 * 0.7), 5, 380),
  numberSpec('offset_m', 'Смещение по ширине', 0, -150, 150),
  numberSpec('root_m', 'Радиус у основания', 2, 0, 20),
];
const gussetCheck = (b, v) => {
  const problems = [];
  if (v.legArm_m > freeArm(b) + 1e-9) problems.push('катет по полке больше свободной длины полки');
  if (v.legWall_m > freeWall(b) + 1e-9) problems.push('катет по стойке больше свободной высоты стойки');
  if (Math.abs(v.offset_m) + v.thickness_m / 2 > b.width_m / 2 + 1e-9) problems.push('косынка выходит за ширину');
  return problems;
};

const flangeSpecs = (b) => [
  numberSpec('thickness_m', 'Толщина бортика', 3, 0.8, 30),
  numberSpec('height_m', 'Высота бортика', Math.max(3, Math.round(b.armThickness_m * 1000 * 1.5)), 1, 60),
  numberSpec('root_m', 'Радиус у основания', 1.5, 0, 10),
];
const flangeCheck = (b, v) => (2 * v.thickness_m >= b.width_m ? ['бортики перекрываются по ширине'] : []);

function gussetSolid(b, v) {
  const tw = b.wallThickness_m;
  const ta = b.armThickness_m;
  const xc = b.width_m / 2 + v.offset_m;
  const overlap = Math.min(tw, ta) * 0.5;
  const polygon = [
    [tw - overlap, ta - overlap],
    [tw + v.legArm_m, ta - overlap],
    [tw + v.legArm_m, ta],
    [tw, ta + v.legWall_m],
    [tw - overlap, ta + v.legWall_m],
  ];
  return {
    sdf: extrudePolygon('yz', polygon, [xc - v.thickness_m / 2, xc + v.thickness_m / 2]),
    bounds: { min: [xc - v.thickness_m / 2, tw - overlap, ta - overlap], max: [xc + v.thickness_m / 2, tw + v.legArm_m, ta + v.legWall_m] },
  };
}

function flangeSolid(b, v) {
  const ta = b.armThickness_m;
  const yLo = b.wallThickness_m;
  const left = boxFromCorners([0, yLo, ta], [v.thickness_m, b.armLength_m, ta + v.height_m]);
  const right = boxFromCorners([b.width_m - v.thickness_m, yLo, ta], [b.width_m, b.armLength_m, ta + v.height_m]);
  return {
    sdf: union(left, right),
    bounds: { min: [0, yLo, ta], max: [b.width_m, b.armLength_m, ta + v.height_m] },
  };
}

export const angle = {
  id: 'angle',
  name: 'Угловой кронштейн',
  params,
  features: {
    fillet: { name: 'Скругление внутреннего угла', specs: filletSpecs, check: filletCheck, unique: true },
    gusset: { name: 'Косынка', specs: gussetSpecs, check: gussetCheck },
    flange: { name: 'Бортик по кромкам полки', specs: flangeSpecs, check: flangeCheck, unique: true },
  },
  checkBase(b) {
    return b.wallThickness_m >= b.armLength_m || b.armThickness_m >= b.wallHeight_m ? ['толщина не меньше габарита'] : [];
  },
  build(b, featureList) {
    const wall = boxFromCorners([0, 0, 0], [b.width_m, b.wallThickness_m, b.wallHeight_m]);
    const arm = boxFromCorners([0, 0, 0], [b.width_m, b.armLength_m, b.armThickness_m]);
    const cornerRadius_m = featureList.filter((f) => f.kind === 'fillet').reduce((m, f) => Math.max(m, f.values.radius_m), 0);
    let sdf = joinWithFillet(wall, arm, cornerRadius_m);
    const boundsList = [{ min: [0, 0, 0], max: [b.width_m, b.armLength_m, b.wallHeight_m] }];
    let minFeature_m = Math.min(b.wallThickness_m, b.armThickness_m);
    let minRadius_m = cornerRadius_m > 0 ? cornerRadius_m : Infinity;
    for (const feature of featureList) {
      if (feature.kind === 'fillet') continue;
      const solid = feature.kind === 'gusset' ? gussetSolid(b, feature.values) : flangeSolid(b, feature.values);
      sdf = joinWithFillet(sdf, solid.sdf, feature.values.root_m);
      boundsList.push(solid.bounds);
      minFeature_m = Math.min(minFeature_m, feature.values.thickness_m);
      if (feature.values.root_m > 0) minRadius_m = Math.min(minRadius_m, feature.values.root_m);
    }
    const tipOffset_m = Math.min(0.12 * b.armLength_m, 0.02);
    return {
      sdf,
      bounds_m: mergeBounds(boundsList),
      minFeature_m,
      minRadius_m,
      supports: [{ id: 'wall', label: 'Тыльная плоскость стойки (стена)', spec: { kind: 'plane', axis: 1, coord_m: 0 } }],
      loadPresets: [
        { id: 'arm-tip', label: 'Край полки, верхняя грань', point_m: [b.width_m / 2, b.armLength_m - tipOffset_m, b.armThickness_m], outwardNormal: [0, 0, 1] },
        { id: 'arm-middle', label: 'Середина полки, верхняя грань', point_m: [b.width_m / 2, (b.wallThickness_m + b.armLength_m) / 2, b.armThickness_m], outwardNormal: [0, 0, 1] },
      ],
    };
  },
};

