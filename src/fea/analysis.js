// Analysis of a geometry model: resolution choice, load vector, solve, convergence check

import { solveStatic } from './solve.js';
import { findMaterial } from './materials.js';
import { gradientNormal } from '../geometry/sdf.js';

// targetActive: cells with material aimed at; maxActive: cap; maxGrid: cap of grid cells including empty ones
export const QUALITY = {
  draft: { label: 'Быстро', targetActive: 12000, maxActive: 30000, maxGrid: 400000 },
  standard: { label: 'Стандарт', targetActive: 50000, maxActive: 100000, maxGrid: 1500000 },
  fine: { label: 'Точно', targetActive: 120000, maxActive: 250000, maxGrid: 3000000 },
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

export const GRAVITY_DIRECTION = [0, 0, -1];
// Cells across the thinnest feature and per smallest radius that the cell size aims at
const CELLS_ACROSS_FEATURE = 3;
const CELLS_PER_RADIUS = 5;
// Share of boundary cells on top of the interior cell count when estimating active cells
const BOUNDARY_FACTOR = 1.3;
// Samples per axis for the solid volume estimate
const VOLUME_SAMPLES = 32;
// Cell size ratio of the coarse solve in the convergence check
export const CHECK_RATIO = 1.5;
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

// Material volume in m3 by regular sampling of the signed distance field
export function estimateSolidVolume(model) {
  const { min, max } = model.bounds_m;
  const step = [0, 1, 2].map((a) => (max[a] - min[a]) / VOLUME_SAMPLES);
  let inside = 0;
  for (let k = 0; k < VOLUME_SAMPLES; k++) {
    for (let j = 0; j < VOLUME_SAMPLES; j++) {
      for (let i = 0; i < VOLUME_SAMPLES; i++) {
        if (model.sdf(min[0] + (i + 0.5) * step[0], min[1] + (j + 0.5) * step[1], min[2] + (k + 0.5) * step[2]) < 0) inside++;
      }
    }
  }
  return inside * step[0] * step[1] * step[2];
}

export function chooseCellSize(model, qualityId) {
  const quality = QUALITY[qualityId];
  if (!quality) throw new Error(`quality unknown (id=${qualityId})`);
  const budget_m = Math.cbrt((BOUNDARY_FACTOR * estimateSolidVolume(model)) / quality.targetActive);
  const featureLimit_m = model.minFeature_m / CELLS_ACROSS_FEATURE;
  const radiusLimit_m = Number.isFinite(model.minRadius_m) ? model.minRadius_m / CELLS_PER_RADIUS : Infinity;
  return { cellSize_m: Math.min(budget_m, featureLimit_m, radiusLimit_m), maxCells: quality.maxGrid, maxActiveCells: quality.maxActive };
}

// Default patch radius for a model
export function defaultPatchRadius(model) {
  const size_m = model.bounds_m.max.map((hi, a) => hi - model.bounds_m.min[a]);
  return Math.max(PATCH_FLOOR_M, PATCH_SHARE * Math.max(...size_m));
}

// Resolves the load point: preset id or explicit point; snaps to the surface normal estimate
export function resolveLoad(model, load) {
  const preset = load.presetId ? model.loadPresets.find((p) => p.id === load.presetId) : null;
  if (load.presetId && !preset) throw new Error(`load preset unknown (id=${load.presetId})`);
  const point_m = preset ? preset.point_m : load.point_m;
  const outwardNormal = preset ? preset.outwardNormal : gradientNormal(model.sdf, point_m, NORMAL_STEP_M);
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

// setup: { material (record) or materialId, selfWeight, requiredSafety, quality, load, convergenceCheck }
export function analyze(model, setup, onProgress = () => {}) {
  const material = setup.material ?? findMaterial(setup.materialId);
  const full = { ...setup, material };
  const loadSpec = resolveLoad(model, setup.load);
  const size = chooseCellSize(model, setup.quality);
  const doCheck = setup.convergenceCheck && setup.quality !== 'draft';
  const mainShare = doCheck ? 0.75 : 1;
  const main = solveWith(model, full, loadSpec, size, (p) => onProgress({ ...p, fraction: p.fraction * mainShare }));

  let convergence = null;
  if (doCheck) {
    const coarse = solveWith(model, full, loadSpec, { ...size, cellSize_m: Math.max(...main.grid.cell_m) * CHECK_RATIO, maxActiveCells: undefined }, (p) => onProgress({ ...p, stage: 'check', fraction: mainShare + p.fraction * (1 - mainShare) }));
    const governing = main.summary.governing[0];
    const peakFine = main.summary.theories[governing].peakEquivalent_pa;
    const peakCoarse = coarse.summary.theories[governing].peakEquivalent_pa;
    convergence = {
      coarseCell_m: coarse.grid.cell_m,
      displacementChange: (main.summary.maxDisplacement_m - coarse.summary.maxDisplacement_m) / main.summary.maxDisplacement_m,
      stressChange: peakFine > 0 ? (peakFine - peakCoarse) / peakFine : 0,
      coarseConverged: coarse.status.converged,
    };
  }
  const cell_m = main.grid.cell_m;
  const hMax = Math.max(...cell_m);
  const resolution = {
    cell_m,
    cellsAcrossThinnest: model.minFeature_m / hMax,
    cellsPerSmallestRadius: Number.isFinite(model.minRadius_m) ? model.minRadius_m / hMax : null,
  };
  return { solve: main, convergence, resolution, load: loadSpec, setup: { ...full, load: undefined }, quality: setup.quality };
}

