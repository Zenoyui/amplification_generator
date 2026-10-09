// Analysis of a geometry model: resolution choice, load vector, solve, convergence check

import { solveStatic } from './solve.js';
import { findMaterial } from './materials.js';
import { gradientNormal } from '../geometry/sdf.js';

// targetActive: cells with material aimed at; maxActive: cap; maxGrid: cap of grid cells including empty ones;
// cellsPerRadius: cells along the smallest radius that the cell size aims at
export const QUALITY = {
  draft: { label: 'Быстро', cellsPerRadius: 4, targetActive: 12000, maxActive: 30000, maxGrid: 400000 },
  standard: { label: 'Стандарт', cellsPerRadius: 5, targetActive: 50000, maxActive: 100000, maxGrid: 1500000 },
  fine: { label: 'Точно', cellsPerRadius: 7, targetActive: 120000, maxActive: 250000, maxGrid: 3000000 },
};

export const DIRECTIONS = [
  { id: 'inward', label: 'Вдоль нормали внутрь поверхности' },
  { id: 'gravity', label: 'Вниз (вес)' },
  { id: '+x', label: 'Вдоль +X' },
  { id: '-x', label: 'Вдоль -X' },
  { id: '+y', label: 'Вдоль +Y' },
  { id: '-y', label: 'Вдоль -Y' },
  { id: '+z', label: 'Вдоль +Z (вверх)' },
];

const GRAVITY_DIRECTION = [0, 0, -1];
// Cells across the thinnest feature that the cell size aims at
const CELLS_ACROSS_FEATURE = 3;
// Share of boundary cells on top of the interior cell count when estimating active cells
const BOUNDARY_FACTOR = 1.3;
// Samples per axis for the solid volume estimate
const VOLUME_SAMPLES = 48;
// Cell of a distance field built from a mesh, as a share of the solver cell
const FIELD_CELL_SHARE = 2;
// Cell size ratio of the coarse solve in the convergence check
const CHECK_RATIO = 1.5;
// Default load patch radius as a share of the largest model dimension, and its floor
const PATCH_SHARE = 0.02;
const PATCH_FLOOR_M = 0.0025;
// Step for the surface normal estimate, meters
const NORMAL_STEP_M = 1e-5;

export function directionVector(directionId, outwardNormal) {
  switch (directionId) {
    case 'inward': return [-outwardNormal[0], -outwardNormal[1], -outwardNormal[2]];
    case 'gravity': return [...GRAVITY_DIRECTION];
    case '+x': return [1, 0, 0];
    case '-x': return [-1, 0, 0];
    case '+y': return [0, 1, 0];
    case '-y': return [0, -1, 0];
    case '+z': return [0, 0, 1];
    default: throw new Error(`direction unknown (id=${directionId})`);
  }
}

// Samples the model bounds on a regular grid; calls visit(x, y, z) for every sample point
function sampleBounds(bounds_m, visit) {
  const { min, max } = bounds_m;
  const step = [0, 1, 2].map((a) => (max[a] - min[a]) / VOLUME_SAMPLES);
  for (let k = 0; k < VOLUME_SAMPLES; k++) {
    for (let j = 0; j < VOLUME_SAMPLES; j++) {
      for (let i = 0; i < VOLUME_SAMPLES; i++) visit(min[0] + (i + 0.5) * step[0], min[1] + (j + 0.5) * step[1], min[2] + (k + 0.5) * step[2]);
    }
  }
  return step[0] * step[1] * step[2];
}

// Material volume in m3 by regular sampling of the signed distance field
function estimateSolidVolume(model) {
  if (model.volume_m3) return model.volume_m3;
  let inside = 0;
  const cell_m3 = sampleBounds(model.bounds_m, (x, y, z) => {
    if (model.sdf(x, y, z) < 0) inside++;
  });
  return inside * cell_m3;
}

// Added volume of a model with reinforcements relative to the model without them; both sampled at the same points
export function estimateAddedShare(model, baseModel) {
  let withFeatures = 0;
  let without = 0;
  sampleBounds(model.bounds_m, (x, y, z) => {
    if (model.sdf(x, y, z) < 0) withFeatures++;
    if (baseModel.sdf(x, y, z) < 0) without++;
  });
  return without > 0 ? withFeatures / without - 1 : 0;
}

export function chooseCellSize(model, qualityId) {
  const quality = QUALITY[qualityId];
  if (!quality) throw new Error(`quality unknown (id=${qualityId})`);
  const budget_m = Math.cbrt((BOUNDARY_FACTOR * estimateSolidVolume(model)) / quality.targetActive);
  const featureLimit_m = model.minFeature_m / CELLS_ACROSS_FEATURE;
  const radiusLimit_m = Number.isFinite(model.minRadius_m) ? model.minRadius_m / quality.cellsPerRadius : Infinity;
  return { cellSize_m: Math.min(budget_m, featureLimit_m, radiusLimit_m), maxCells: quality.maxGrid, maxActiveCells: quality.maxActive };
}

function defaultPatchRadius(model) {
  const size_m = model.bounds_m.max.map((hi, a) => hi - model.bounds_m.min[a]);
  return Math.max(PATCH_FLOOR_M, PATCH_SHARE * Math.max(...size_m));
}

// Resolves the load point: preset id or explicit point; snaps to the surface normal estimate
export function resolveLoad(model, load) {
  const preset = load.presetId ? model.loadPresets.find((p) => p.id === load.presetId) : null;
  if (load.presetId && !preset) throw new Error(`load preset unknown (id=${load.presetId})`);
  const point_m = preset ? preset.point_m : load.point_m;
  const outwardNormal = preset ? preset.outwardNormal : load.outwardNormal ?? gradientNormal(model.sdf, point_m, NORMAL_STEP_M);
  const direction = directionVector(load.direction, outwardNormal);
  return {
    point_m,
    outwardNormal,
    direction,
    force_n: direction.map((c) => c * load.magnitude_n),
    magnitude_n: load.magnitude_n,
    massKg: load.massKg ?? null,
    radius_m: load.radius_m ?? defaultPatchRadius(model),
  };
}

function solveWith(model, setup, loadSpec, size, onProgress) {
  return solveStatic({
    sdf: model.sdf,
    bounds_m: model.bounds_m,
    cellSize_m: size.cellSize_m,
    maxCells: size.maxCells,
    maxActiveCells: size.maxActiveCells,
    minFeature_m: model.minFeature_m,
    material: setup.material,
    supports: model.supports.map((s) => s.spec),
    loads: [{ point_m: loadSpec.point_m, outwardNormal: loadSpec.outwardNormal, force_n: loadSpec.force_n, radius_m: loadSpec.radius_m }],
    selfWeight: setup.selfWeight,
    gravityDir: GRAVITY_DIRECTION,
    requiredSafety: setup.requiredSafety,
    onProgress,
  });
}

// setup: { material (record) or materialId, selfWeight, requiredSafety, quality, load }
export function analyze(model, setup, onProgress = () => {}) {
  const material = setup.material ?? findMaterial(setup.materialId);
  const full = { ...setup, material };
  const size = chooseCellSize(model, setup.quality);
  model.attachField?.(size.cellSize_m / FIELD_CELL_SHARE);
  const loadSpec = resolveLoad(model, setup.load);
  const main = solveWith(model, full, loadSpec, size, onProgress);
  const cell_m = main.grid.cell_m;
  const hMax = Math.max(...cell_m);
  const resolution = {
    cell_m,
    cellsAcrossThinnest: model.minFeature_m / hMax,
    cellsPerSmallestRadius: Number.isFinite(model.minRadius_m) ? model.minRadius_m / hMax : null,
  };
  return { solve: main, convergence: null, resolution, load: loadSpec, setup: { ...full, load: undefined }, quality: setup.quality };
}

// Solve on a cell CHECK_RATIO times larger, run next to analyze() (another worker): peaks to compare with the main result
export function analyzeCheck(model, setup, onProgress = () => {}) {
  const material = setup.material ?? findMaterial(setup.materialId);
  const full = { ...setup, material };
  const size = chooseCellSize(model, setup.quality);
  model.attachField?.(size.cellSize_m / FIELD_CELL_SHARE);
  const loadSpec = resolveLoad(model, setup.load);
  const coarse = solveWith(model, full, loadSpec, { ...size, cellSize_m: size.cellSize_m * CHECK_RATIO, maxActiveCells: undefined }, onProgress);
  return {
    cell_m: coarse.grid.cell_m,
    converged: coarse.status.converged,
    maxDisplacement_m: coarse.summary.maxDisplacement_m,
    peaks_pa: Object.fromEntries(Object.entries(coarse.summary.theories).map(([id, entry]) => [id, entry.peakEquivalent_pa])),
  };
}

// Changes of displacement and governing peak stress from the coarse to the main solve; null when the check did not converge
export function convergenceOf(main, check) {
  if (!check || !check.converged) return null;
  const governing = main.summary.governing[0];
  const peakFine = main.summary.theories[governing].peakEquivalent_pa;
  return {
    ratio: Math.max(...check.cell_m) / Math.max(...main.grid.cell_m),
    displacementChange: (main.summary.maxDisplacement_m - check.maxDisplacement_m) / main.summary.maxDisplacement_m,
    stressChange: peakFine > 0 ? (peakFine - check.peaks_pa[governing]) / peakFine : 0,
  };
}
