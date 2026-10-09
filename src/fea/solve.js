// Static linear solve on a voxel grid: grid plan, supports, loads, multigrid CG, stress recovery, strength theories

import { sampleGrid, WEIGHT_CUTOFF } from './grid.js';
import { buildFinestLevel } from './level.js';
import { Multigrid } from './multigrid.js';
import { solvePcg } from './pcg.js';
import { activeNodes, reachableFromSupport, selectNodes } from './domain.js';
import { addPatchForce, addSelfWeight, cellVolume } from './loads.js';
import { recoverNodalStress, nodesNearSeeds, surfaceCrossings } from './stress.js';
import { evaluateFields, governingTheories } from './criteria.js';
import { supportTest } from './supports.js';

// Smallest supports: fewer nodes cannot remove 6 rigid modes reliably
const MIN_SUPPORT_NODES = 3;
// Cells per thinnest feature below which stiffness is unreliable
const MIN_CELLS_ACROSS_ERROR = 1;
const MIN_CELLS_ACROSS_WARN = 2;
// Displacement maxima are taken over nodes at most this many cells outside the surface
const MATERIAL_NODE_CELLS = 0.5;
// Layers of cells around supports and load patches excluded from the peak search
const EXCLUSION_LAYERS = 1;
// Coarsest axis cell count after padding lies in [COARSE_LOW, 2 * COARSE_LOW)
const COARSE_LOW = 3.5;
const MAX_HALVINGS = 5;
// Resampling rounds when the active cell count exceeds the cap, and the size margin per round
const MAX_REPLAN = 4;
const REPLAN_MARGIN = 1.02;
// Reported equilibrium error above this relative level marks the result unreliable
export const EQUILIBRIUM_LIMIT = 1e-5;

export class SolveError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SolveError';
    this.code = code;
    this.details = details;
  }
}

// Cell counts and sizes for bounds_m = { min, max } and a target cell size. Axis counts are rounded up to a
// multiple of 2^p so that the multigrid can halve them; cells shrink slightly, the bounds stay covered exactly.
export function planGrid(bounds_m, targetCell_m, maxCells) {
  const length_m = bounds_m.max.map((hi, a) => hi - bounds_m.min[a]);
  let cell_m = targetCell_m;
  let raw = length_m.map((len) => Math.max(1, Math.ceil(len / cell_m)));
  let reduced = false;
  const roundUp = (n) => {
    const halvings = Math.min(MAX_HALVINGS, Math.max(0, Math.floor(Math.log2(n / COARSE_LOW))));
    const unit = 2 ** halvings;
    return Math.ceil(n / unit) * unit;
  };
  let counts = raw.map(roundUp);
  while (counts[0] * counts[1] * counts[2] > maxCells) {
    cell_m *= Math.cbrt((counts[0] * counts[1] * counts[2]) / maxCells) * 1.01;
    raw = length_m.map((len) => Math.max(1, Math.ceil(len / cell_m)));
    counts = raw.map(roundUp);
    reduced = true;
  }
  const size_m = counts.map((n, a) => length_m[a] / n);
  return { counts, cell_m: size_m, min_m: [...bounds_m.min], reduced, effectiveTarget_m: cell_m };
}

function countActiveCells(weight) {
  let count = 0;
  for (let c = 0; c < weight.length; c++) if (weight[c] >= WEIGHT_CUTOFF) count++;
  return count;
}

export function nodePosition(grid, n) {
  const [nx, ny] = grid.counts;
  const i = n % (nx + 1);
  const rest = (n - i) / (nx + 1);
  const j = rest % (ny + 1);
  const k = (rest - j) / (ny + 1);
  return [grid.min_m[0] + i * grid.cell_m[0], grid.min_m[1] + j * grid.cell_m[1], grid.min_m[2] + k * grid.cell_m[2]];
}

// spec: { sdf, bounds_m, cellSize_m, maxCells (grid cells), maxActiveCells (cells with material), minFeature_m, material, supports: [support spec], loads: [...],
//   selfWeight, gravityDir, requiredSafety, onProgress }
// loads[i]: { point_m, outwardNormal, force_n, radius_m }
export function solveStatic(spec) {
  const progress = spec.onProgress ?? (() => {});
  const warnings = [];
  progress({ stage: 'grid', fraction: 0 });
  let target_m = spec.cellSize_m;
  let plan = planGrid(spec.bounds_m, target_m, spec.maxCells);
  let grid = sampleGrid(spec.sdf, plan.min_m, plan.cell_m, plan.counts);
  for (let attempt = 0; attempt < MAX_REPLAN && spec.maxActiveCells; attempt++) {
    const activeCount = countActiveCells(grid.weight);
    if (activeCount <= spec.maxActiveCells) break;
    target_m = Math.max(...plan.cell_m) * Math.cbrt(activeCount / spec.maxActiveCells) * REPLAN_MARGIN;
    plan = planGrid(spec.bounds_m, target_m, spec.maxCells);
    grid = sampleGrid(spec.sdf, plan.min_m, plan.cell_m, plan.counts);
    plan.reduced = true;
  }
  if (plan.reduced) warnings.push({ code: 'cells-capped', cell_m: Math.max(...plan.cell_m) });
  const hMax = Math.max(...plan.cell_m);
  if (spec.minFeature_m) {
    const across = spec.minFeature_m / hMax;
    if (across < MIN_CELLS_ACROSS_ERROR) {
      throw new SolveError('thin-feature', `thin feature (cells=${across.toFixed(2)})`, { across });
    }
    if (across < MIN_CELLS_ACROSS_WARN) warnings.push({ code: 'thin-feature', across });
  }

  const active = activeNodes(grid.counts, grid.weight);

  const tests = spec.supports.map((support) => supportTest(support, grid.cell_m));
  const supportNodes = selectNodes(grid, active, (x, y, z) => tests.some((test) => test(x, y, z)));
  if (supportNodes.length < MIN_SUPPORT_NODES) {
    throw new SolveError('support-empty', `support: too few nodes (found=${supportNodes.length})`, { found: supportNodes.length });
  }
  const { dropped } = reachableFromSupport(grid.counts, grid.weight, supportNodes);
  const cellVolume_m3 = grid.cell_m[0] * grid.cell_m[1] * grid.cell_m[2];
  let droppedVolume_m3 = 0;
  for (const c of dropped) {
    droppedVolume_m3 += grid.weight[c] * cellVolume_m3;
    grid.weight[c] = 0;
  }
  if (dropped.length > 0) warnings.push({ code: 'island-dropped', volume_m3: droppedVolume_m3 });
  const keptNodes = dropped.length > 0 ? activeNodes(grid.counts, grid.weight) : active;

  const nodeCount = keptNodes.length;
  const blocked = new Uint8Array(nodeCount);
  for (const n of supportNodes) blocked[n] = 1;

  const bGrid = new Float64Array(3 * nodeCount);
  const patches = [];
  for (const load of spec.loads) {
    patches.push(addPatchForce(grid, keptNodes, blocked, bGrid, load.point_m, load.outwardNormal, load.force_n, load.radius_m));
  }

  progress({ stage: 'setup', fraction: 0.1 });
  const level = buildFinestLevel(grid, blocked, spec.material.poisson);
  if (spec.selfWeight) addSelfWeight(grid, level.element, bGrid, spec.material.density_kgpm3, spec.gravityDir);
  const applied_n = [0, 0, 0];
  for (let n = 0; n < nodeCount; n++) for (let c = 0; c < 3; c++) applied_n[c] += bGrid[3 * n + c];
  const multigrid = new Multigrid(level);
  const b = new Float64Array(3 * level.nodeCount);
  for (let n = 0; n < level.nodeCount; n++) {
    for (let c = 0; c < 3; c++) b[3 * n + c] = bGrid[3 * level.gridNode[n] + c];
  }
  const forceAtSupports = new Float64Array(3 * supportNodes.length);
  supportNodes.forEach((g, idx) => {
    for (let c = 0; c < 3; c++) forceAtSupports[3 * idx + c] = bGrid[3 * g + c];
  });
  level.zeroBlocked(b);

  progress({ stage: 'solve', fraction: 0.2 });
  const solution = solvePcg(multigrid, b, {
    onIteration: (iteration, residual) => progress({ stage: 'solve', iteration, residual, fraction: 0.2 + 0.7 * Math.min(1, iteration / 40) }),
  });

  // reactions: product without masking, E = 1 basis equals true reaction
  const ku = new Float64Array(3 * level.nodeCount);
  level.applyUnmasked(solution.x, ku);
  const reaction_n = [0, 0, 0];
  supportNodes.forEach((g, idx) => {
    const n = level.nodeMap[g];
    for (let c = 0; c < 3; c++) reaction_n[c] += ku[3 * n + c] - forceAtSupports[3 * idx + c];
  });
  const appliedNorm = Math.hypot(...applied_n);
  const imbalance = Math.hypot(reaction_n[0] + applied_n[0], reaction_n[1] + applied_n[1], reaction_n[2] + applied_n[2]);
  const equilibriumError = appliedNorm > 0 ? imbalance / appliedNorm : 0;
  if (equilibriumError > EQUILIBRIUM_LIMIT) warnings.push({ code: 'equilibrium', error: equilibriumError });

  progress({ stage: 'stress', fraction: 0.92 });
  const youngs_pa = spec.material.youngs_pa;
  const uHat = new Float64Array(3 * nodeCount);
  for (let n = 0; n < level.nodeCount; n++) {
    for (let c = 0; c < 3; c++) uHat[3 * level.gridNode[n] + c] = solution.x[3 * n + c];
  }
  const displacement_m = new Float32Array(3 * nodeCount);
  let maxDisplacement_m = 0;
  let maxDisplacementNode = -1;
  for (let n = 0; n < nodeCount; n++) {
    const ux = uHat[3 * n] / youngs_pa;
    const uy = uHat[3 * n + 1] / youngs_pa;
    const uz = uHat[3 * n + 2] / youngs_pa;
    displacement_m[3 * n] = ux;
    displacement_m[3 * n + 1] = uy;
    displacement_m[3 * n + 2] = uz;
    const magnitude = Math.hypot(ux, uy, uz);
    if (keptNodes[n] && grid.phi[n] <= MATERIAL_NODE_CELLS * hMax && magnitude > maxDisplacement_m) {
      maxDisplacement_m = magnitude;
      maxDisplacementNode = n;
    }
  }
  let work_j = 0;
  for (let i = 0; i < b.length; i++) work_j += b[i] * (solution.x[i] / youngs_pa);

  const { stress_pa, count } = recoverNodalStress(grid, level.element, uHat);
  const seeds = Int32Array.from([...supportNodes, ...patches.flatMap((patch) => patch.nodeList)]);
  const excluded = nodesNearSeeds(grid, seeds, EXCLUSION_LAYERS);
  const inside = new Uint8Array(nodeCount);
  for (let n = 0; n < nodeCount; n++) inside[n] = grid.phi[n] < 0 ? 1 : 0;
  const fields = evaluateFields(stress_pa, count, excluded, inside, surfaceCrossings(grid, count), spec.material, spec.requiredSafety);
  const pointOf = (where) => {
    if (where === null) return null;
    if (where.n !== undefined) return nodePosition(grid, where.n);
    const a = nodePosition(grid, where.n0);
    const b = nodePosition(grid, where.n1);
    return a.map((v, axis) => v + where.t * (b[axis] - v));
  };
  const theories = Object.fromEntries(
    Object.entries(fields.summary).map(([id, entry]) => [id, { ...entry, point_m: pointOf(entry.where), peakPoint_m: pointOf(entry.peakWhere) }]),
  );

  const volume_m3 = cellVolume(grid);
  let solidCells = 0;
  for (let c = 0; c < grid.weight.length; c++) if (grid.weight[c] >= 0.5) solidCells++;
  progress({ stage: 'done', fraction: 1 });
  return {
    status: {
      converged: solution.converged,
      iterations: solution.iterations,
      relativeResidual: solution.relativeResidual,
      breakdown: solution.breakdown ?? null,
    },
    grid: { counts: grid.counts, cell_m: grid.cell_m, min_m: grid.min_m },
    nodes: { displacement_m, stress_pa, count, mises_pa: fields.mises_pa, safety: fields.safety, excluded, active: keptNodes },
    summary: {
      cells: grid.weight.length,
      activeCells: level.cellCount,
      solidCells,
      freeDofs: level.freeDofCount,
      levels: multigrid.levels.length,
      volume_m3,
      mass_kg: volume_m3 * spec.material.density_kgpm3,
      maxDisplacement_m,
      maxDisplacementPoint_m: maxDisplacementNode >= 0 ? nodePosition(grid, maxDisplacementNode) : null,
      theories,
      rawPeakMises_pa: fields.rawPeak.mises_pa,
      rawPeakPoint_m: pointOf(fields.rawPeak.where),
      governing: governingTheories(spec.material),
      contradictions: fields.contradictions,
      applied_n,
      reaction_n,
      equilibriumError,
      work_j,
      supportNodes: supportNodes.length,
      patches: patches.map((patch) => ({ nodes: patch.nodes, radius_m: patch.radius_m })),
      droppedVolume_m3,
      warnings,
    },
  };
}
