// Lever with an eye: ring at the origin with a bore (pin support), tapered handle along +x, plate thickness t along z

import { boxFromCorners, cylinder, extrudePolygon, joinWithFillet, subtract, mergeBounds, unionAll } from '../sdf.js';
import { numberSpec, enumSpec } from '../params.js';

const SIDES = [
  { value: 'top', label: 'сверху' },
  { value: 'both', label: 'с двух сторон' },
];

const params = [
  numberSpec('handleLength_m', 'Длина рукоятки от оси отверстия', 150, 40, 500),
  numberSpec('rootWidth_m', 'Ширина у проушины', 24, 6, 120),
  numberSpec('tipWidth_m', 'Ширина на конце', 16, 4, 120),
  numberSpec('ringRadius_m', 'Наружный радиус проушины', 18, 6, 80),
  numberSpec('boreRadius_m', 'Радиус отверстия', 8, 2, 60),
  numberSpec('thickness_m', 'Толщина', 6, 2, 40),
];

const halfWidthAt = (b, x) => (b.rootWidth_m + (b.tipWidth_m - b.rootWidth_m) * (x / b.handleLength_m)) / 2;

const filletSpecs = (b) => [numberSpec('radius_m', 'Радиус скругления шейки', Math.max(1, Math.round(b.ringRadius_m * 1000 * 0.4)), 0.5, 60)];
const filletCheck = (b, v) => (v.radius_m > b.ringRadius_m * 2 ? ['радиус скругления больше диаметра проушины'] : []);

const bossSpecs = (b) => [
  numberSpec('outerRadius_m', 'Радиус бобышки', Math.max(3, Math.round(b.ringRadius_m * 1000 * 0.9)), 3, 80),
  numberSpec('height_m', 'Высота бобышки', 3, 0.8, 30),
  enumSpec('side', 'Сторона', SIDES, 'both'),
  numberSpec('root_m', 'Радиус у основания', 1.5, 0, 10),
];
const bossCheck = (b, v) => {
  const problems = [];
  if (v.outerRadius_m <= b.boreRadius_m) problems.push('радиус бобышки не больше радиуса отверстия');
  if (v.outerRadius_m > b.ringRadius_m + 1e-9) problems.push('радиус бобышки больше радиуса проушины');
  return problems;
};

const edgeRibSpecs = (b) => [
  numberSpec('thickness_m', 'Толщина бортика', 3, 0.8, 30),
  numberSpec('height_m', 'Высота бортика', Math.max(3, Math.round(b.thickness_m * 1000)), 1, 60),
  numberSpec('start_m', 'Начало от оси отверстия', Math.round(b.ringRadius_m * 1000), 0, 480),
  enumSpec('side', 'Сторона', SIDES, 'top'),
  numberSpec('root_m', 'Радиус у основания', 1.5, 0, 10),
];
const edgeRibCheck = (b, v) => {
  const problems = [];
  if (v.start_m > b.handleLength_m - 0.01) problems.push('начало бортика слишком близко к концу рукоятки');
  if (2 * v.thickness_m >= b.tipWidth_m) problems.push('бортики перекрываются на конце рукоятки');
  return problems;
};

const centerRibSpecs = (b) => [
  numberSpec('thickness_m', 'Толщина ребра', 4, 0.8, 40),
  numberSpec('height_m', 'Высота ребра', Math.max(3, Math.round(b.thickness_m * 1000)), 1, 60),
  numberSpec('start_m', 'Начало от оси отверстия', Math.round(b.ringRadius_m * 1000 * 0.6), 0, 480),
  enumSpec('side', 'Сторона', SIDES, 'top'),
  numberSpec('root_m', 'Радиус у основания', 1.5, 0, 10),
];
const centerRibCheck = (b, v) => (v.start_m > b.handleLength_m - 0.01 ? ['начало ребра слишком близко к концу рукоятки'] : []);

// z ranges of a feature on the chosen sides
function zRanges(b, v) {
  const ranges = [[b.thickness_m, b.thickness_m + v.height_m]];
  if (v.side === 'both') ranges.push([-v.height_m, 0]);
  return ranges;
}

function bossSolid(b, v) {
  const ranges = zRanges(b, v);
  const shapes = ranges.map(([lo, hi]) => cylinder('z', [0, 0, (lo + hi) / 2], v.outerRadius_m, (hi - lo) / 2));
  return {
    sdf: unionAll(shapes),
    bounds: {
      min: [-v.outerRadius_m, -v.outerRadius_m, Math.min(...ranges.map((r) => r[0]))],
      max: [v.outerRadius_m, v.outerRadius_m, Math.max(...ranges.map((r) => r[1]))],
    },
  };
}

function edgeRibSolid(b, v) {
  const xs = v.start_m;
  const xe = b.handleLength_m - 0.002;
  const shapes = [];
  let zMin = Infinity;
  let zMax = -Infinity;
  for (const [lo, hi] of zRanges(b, v)) {
    zMin = Math.min(zMin, lo);
    zMax = Math.max(zMax, hi);
    for (const sign of [1, -1]) {
      const outer = (x) => sign * halfWidthAt(b, x);
      const inner = (x) => sign * (halfWidthAt(b, x) - v.thickness_m);
      shapes.push(extrudePolygon('xy', [[xs, outer(xs)], [xe, outer(xe)], [xe, inner(xe)], [xs, inner(xs)]], [lo, hi]));
    }
  }
  const half = halfWidthAt(b, xs);
  return { sdf: unionAll(shapes), bounds: { min: [xs, -half, zMin], max: [xe, half, zMax] } };
}

function centerRibSolid(b, v) {
  const xs = v.start_m;
  const xe = b.handleLength_m - 0.002;
  const shapes = zRanges(b, v).map(([lo, hi]) => boxFromCorners([xs, -v.thickness_m / 2, lo], [xe, v.thickness_m / 2, hi]));
  const zs = zRanges(b, v);
  return {
    sdf: unionAll(shapes),
    bounds: { min: [xs, -v.thickness_m / 2, Math.min(...zs.map((r) => r[0]))], max: [xe, v.thickness_m / 2, Math.max(...zs.map((r) => r[1]))] },
  };
}

export const lever = {
  id: 'lever',
  name: 'Рычаг с проушиной',
  params,
  features: {
    fillet: { name: 'Скругление шейки', specs: filletSpecs, check: filletCheck, unique: true },
    boss: { name: 'Бобышка вокруг отверстия', specs: bossSpecs, check: bossCheck, unique: true },
    flange: { name: 'Бортики по кромкам рукоятки', specs: edgeRibSpecs, check: edgeRibCheck, unique: true },
    rib: { name: 'Ребро по оси рукоятки', specs: centerRibSpecs, check: centerRibCheck, unique: true },
  },
  checkBase(b) {
    const problems = [];
    if (b.boreRadius_m >= b.ringRadius_m) problems.push('радиус отверстия не меньше радиуса проушины');
    else if (b.ringRadius_m - b.boreRadius_m < 0.002) problems.push('стенка проушины тоньше 2 мм');
    if (b.rootWidth_m / 2 > b.ringRadius_m + 1e-9) problems.push('ширина у проушины больше диаметра проушины');
    if (b.handleLength_m <= b.ringRadius_m) problems.push('рукоятка короче радиуса проушины');
    return problems;
  },
  build(b, featureList) {
    const ring = cylinder('z', [0, 0, b.thickness_m / 2], b.ringRadius_m, b.thickness_m / 2);
    const handle = extrudePolygon('xy', [[0, -b.rootWidth_m / 2], [b.handleLength_m, -b.tipWidth_m / 2], [b.handleLength_m, b.tipWidth_m / 2], [0, b.rootWidth_m / 2]], [0, b.thickness_m]);
    const neckRadius_m = featureList.filter((f) => f.kind === 'fillet').reduce((m, f) => Math.max(m, f.values.radius_m), 0);
    let sdf = joinWithFillet(ring, handle, neckRadius_m);
    const half = Math.max(b.ringRadius_m, b.rootWidth_m / 2, b.tipWidth_m / 2);
    const boundsList = [{ min: [-b.ringRadius_m, -half, 0], max: [b.handleLength_m, half, b.thickness_m] }];
    let minFeature_m = Math.min(b.thickness_m, b.tipWidth_m, b.ringRadius_m - b.boreRadius_m);
    let minRadius_m = Math.min(b.boreRadius_m, neckRadius_m > 0 ? neckRadius_m : Infinity);
    for (const feature of featureList) {
      if (feature.kind === 'fillet') continue;
      const builder = { boss: bossSolid, flange: edgeRibSolid, rib: centerRibSolid }[feature.kind];
      const solid = builder(b, feature.values);
      sdf = joinWithFillet(sdf, solid.sdf, feature.values.root_m);
      boundsList.push(solid.bounds);
      const thin = feature.values.thickness_m ?? feature.values.height_m;
      minFeature_m = Math.min(minFeature_m, thin);
      if (feature.values.root_m > 0) minRadius_m = Math.min(minRadius_m, feature.values.root_m);
    }
    const bore = cylinder('z', [0, 0, b.thickness_m / 2], b.boreRadius_m, 10 * b.thickness_m + 1);
    sdf = subtract(sdf, bore);
    const tipOffset_m = Math.min(0.08 * b.handleLength_m, 0.015);
    return {
      sdf,
      bounds_m: mergeBounds(boundsList),
      minFeature_m,
      minRadius_m,
      supports: [{ id: 'bore', label: 'Поверхность отверстия (палец)', spec: { kind: 'bore', axis: 2, center_m: [0, 0], radius_m: b.boreRadius_m } }],
      loadPresets: [
        { id: 'tip', label: 'Конец рукоятки, верхняя грань', point_m: [b.handleLength_m - tipOffset_m, 0, b.thickness_m], outwardNormal: [0, 0, 1] },
        { id: 'middle', label: 'Середина рукоятки, верхняя грань', point_m: [b.handleLength_m / 2, 0, b.thickness_m], outwardNormal: [0, 0, 1] },
      ],
    };
  },
};
