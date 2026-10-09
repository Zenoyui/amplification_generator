// Geometric multigrid V-cycle with Galerkin coarse operators on sparse voxel levels.
// Used as preconditioner for conjugate gradients.

import { Level, TRI_LENGTH, TRI_OFFSET } from './level.js';
import { NODE_DOFS } from './element.js';
import { bandCholeskyFactor, bandCholeskySolve, bandIndex, CholeskyError } from '../math/dense.js';

// Coarsest level is factored directly when n * bandwidth^2 is at most this (flops of the band factorization)
const COARSE_COST_LIMIT = 3e8;
// Axis is halved only while it has at least this many cells and an even count
const MIN_CELLS_TO_HALVE = 4;
// Chebyshev smoother: polynomial degree, smoothed band is [lambdaMax / SMOOTH_RATIO, lambdaMax]
const CHEBYSHEV_DEGREE = 2;
const SMOOTH_RATIO = 8;
// Margin on the power-iteration estimate of the largest eigenvalue of D^-1 A
const LAMBDA_MARGIN = 1.2;
const POWER_ITERATIONS = 12;
const MAX_LEVELS = 12;
// Smoothing steps on the coarsest level when a direct factor is too large
const COARSE_SMOOTH_STEPS = 24;

function halvedAxes(counts) {
  return counts.map((n) => n >= MIN_CELLS_TO_HALVE && n % 2 === 0);
}

// 1D interpolation weights: twice the fine coordinate inside the coarse cell is ts (0, 1 or 2)
const weight1d = (ts, cornerBit) => (cornerBit ? ts / 2 : (2 - ts) / 2);

// For child position p (3 bits): flat entries (fine corner a, coarse corner i, weight w) of the interpolation
function childInterpolation(axes) {
  const table = [];
  for (let p = 0; p < 8; p++) {
    const fineCorner = [];
    const coarseCorner = [];
    const weight = [];
    for (let a = 0; a < 8; a++) {
      for (let i = 0; i < 8; i++) {
        let w = 1;
        for (let axis = 0; axis < 3; axis++) {
          const ts = axes[axis] ? ((p >> axis) & 1) + ((a >> axis) & 1) : 2 * ((a >> axis) & 1);
          w *= weight1d(ts, (i >> axis) & 1);
        }
        if (w > 0) {
          fineCorner.push(a);
          coarseCorner.push(i);
          weight.push(w);
        }
      }
    }
    table.push({ fineCorner, coarseCorner, weight, length: weight.length });
  }
  return table;
}

// acc (packed upper triangle) += scale * T^T A T for child matrix A (full 24 x 24) and interpolation entries
function addGalerkin(acc, matrix, entries, scale) {
  const { fineCorner, coarseCorner, weight, length } = entries;
  for (let e = 0; e < length; e++) {
    const a = fineCorner[e];
    const i = coarseCorner[e];
    for (let f = 0; f < length; f++) {
      const j = coarseCorner[f];
      if (j < i) continue;
      const b = fineCorner[f];
      const w = scale * weight[e] * weight[f];
      for (let u = 0; u < 3; u++) {
        const row = 3 * i + u;
        const source = (3 * a + u) * NODE_DOFS + 3 * b;
        for (let v = 0; v < 3; v++) {
          const col = 3 * j + v;
          if (col < row) continue;
          acc[TRI_OFFSET[row] + col - row] += w * matrix[source + v];
        }
      }
    }
  }
}

// Galerkin coarsening of `fine` over halved axes. Returns { level, transfer }.
function coarsen(fine, axes) {
  const [nx, ny] = fine.counts;
  const cx = axes[0] ? fine.counts[0] / 2 : fine.counts[0];
  const cy = axes[1] ? fine.counts[1] / 2 : fine.counts[1];
  const cz = axes[2] ? fine.counts[2] / 2 : fine.counts[2];
  const counts = [cx, cy, cz];
  const cell_m = fine.cell_m.map((h, a) => (axes[a] ? 2 * h : h));
  const parentMap = new Int32Array(cx * cy * cz).fill(-1);
  const parentGrid = [];
  const parentOfChild = new Int32Array(fine.cellCount);
  const childPosition = new Uint8Array(fine.cellCount);
  for (let q = 0; q < fine.cellCount; q++) {
    const g = fine.cellGrid[q];
    const i = g % nx;
    const rest = (g - i) / nx;
    const j = rest % ny;
    const k = (rest - j) / ny;
    const I = axes[0] ? i >> 1 : i;
    const J = axes[1] ? j >> 1 : j;
    const K = axes[2] ? k >> 1 : k;
    const cell = (K * cy + J) * cx + I;
    if (parentMap[cell] < 0) {
      parentMap[cell] = parentGrid.length;
      parentGrid.push(cell);
    }
    parentOfChild[q] = parentMap[cell];
    childPosition[q] = (axes[0] ? i & 1 : 0) | ((axes[1] ? j & 1 : 0) << 1) | ((axes[2] ? k & 1 : 0) << 2);
  }
  const parentCount = parentGrid.length;

  // coarse nodes and cell connectivity
  const sy = cx + 1;
  const sz = sy * (cy + 1);
  const offsets = [0, 1, sy, sy + 1, sz, sz + 1, sz + sy, sz + sy + 1];
  const nodeMap = new Int32Array((cx + 1) * (cy + 1) * (cz + 1)).fill(-1);
  const gridNode = [];
  const cellNodes = new Int32Array(8 * parentCount);
  for (let p = 0; p < parentCount; p++) {
    const cell = parentGrid[p];
    const I = cell % cx;
    const rest = (cell - I) / cx;
    const J = rest % cy;
    const K = (rest - J) / cy;
    const n0 = K * sz + J * sy + I;
    for (let a = 0; a < 8; a++) {
      const g = n0 + offsets[a];
      if (nodeMap[g] < 0) {
        nodeMap[g] = gridNode.length;
        gridNode.push(g);
      }
      cellNodes[8 * p + a] = nodeMap[g];
    }
  }

  // children grouped by parent
  const start = new Int32Array(parentCount + 1);
  for (let q = 0; q < fine.cellCount; q++) start[parentOfChild[q] + 1]++;
  for (let p = 0; p < parentCount; p++) start[p + 1] += start[p];
  const fill = Int32Array.from(start.subarray(0, parentCount));
  const grouped = new Int32Array(fine.cellCount);
  for (let q = 0; q < fine.cellCount; q++) grouped[fill[parentOfChild[q]]++] = q;

  // Galerkin element matrices. A scalar-mode child is weight * reference, so its transform is weight * (a table
  // entry computed once per child position).
  const interpolation = childInterpolation(axes);
  const tri = new Float32Array(parentCount * TRI_LENGTH);
  const childMatrix = new Float64Array(NODE_DOFS * NODE_DOFS);
  const acc = new Float64Array(TRI_LENGTH);
  let referenceTransforms = null;
  if (fine.element) {
    referenceTransforms = interpolation.map((entries) => {
      const transformed = new Float64Array(TRI_LENGTH);
      addGalerkin(transformed, fine.element.ke, entries, 1);
      return transformed;
    });
  }
  for (let p = 0; p < parentCount; p++) {
    acc.fill(0);
    for (let s = start[p]; s < start[p + 1]; s++) {
      const q = grouped[s];
      if (fine.slot[q] < 0) {
        const w = fine.weights[q];
        const reference = referenceTransforms[childPosition[q]];
        for (let i = 0; i < TRI_LENGTH; i++) acc[i] += w * reference[i];
      } else {
        fine.cellMatrix(q, childMatrix);
        addGalerkin(acc, childMatrix, interpolation[childPosition[q]], 1);
      }
    }
    tri.set(acc, p * TRI_LENGTH);
  }

  // free flags: a coarse node is blocked when a fine node at its place or next to it (along halved axes) is blocked,
  // so that supports not aligned with coarse nodes still remove the rigid modes of the coarse problem
  const free = new Uint8Array(gridNode.length);
  const fnx = fine.counts[0] + 1;
  const fny = fine.counts[1] + 1;
  const fnz = fine.counts[2] + 1;
  for (let n = 0; n < gridNode.length; n++) {
    const g = gridNode[n];
    const I = g % sy;
    const rest = (g - I) / sy;
    const J = rest % (cy + 1);
    const K = (rest - J) / (cy + 1);
    const fi = axes[0] ? 2 * I : I;
    const fj = axes[1] ? 2 * J : J;
    const fk = axes[2] ? 2 * K : K;
    let isFree = 1;
    for (let dk = axes[2] ? -1 : 0; dk <= (axes[2] ? 1 : 0); dk++) {
      for (let dj = axes[1] ? -1 : 0; dj <= (axes[1] ? 1 : 0); dj++) {
        for (let di = axes[0] ? -1 : 0; di <= (axes[0] ? 1 : 0); di++) {
          const i = fi + di;
          const j = fj + dj;
          const k = fk + dk;
          if (i < 0 || j < 0 || k < 0 || i >= fnx || j >= fny || k >= fnz) continue;
          const fineNode = fine.nodeMap[(k * fny + j) * fnx + i];
          if (fineNode >= 0 && !fine.free[fineNode]) isFree = 0;
        }
      }
    }
    free[n] = isFree;
  }

  const level = new Level({
    counts,
    cell_m,
    cellGrid: Int32Array.from(parentGrid),
    cellNodes,
    gridNode: Int32Array.from(gridNode),
    free,
    slot: Int32Array.from({ length: parentCount }, (_, index) => index),
    weights: new Float32Array(parentCount),
    tri,
  });
  level.nodeMap = nodeMap;
  return { level, transfer: buildTransfer(fine, level, axes, fnx, fny) };
}

// Interpolation from coarse to fine as CSR rows per fine node: coarse node ids and weights
function buildTransfer(fine, coarse, axes, fnx, fny) {
  const cnx = coarse.counts[0] + 1;
  const cny = coarse.counts[1] + 1;
  const rowStart = new Int32Array(fine.nodeCount + 1);
  const columns = [];
  const weights = [];
  for (let n = 0; n < fine.nodeCount; n++) {
    const g = fine.gridNode[n];
    const i = g % fnx;
    const rest = (g - i) / fnx;
    const j = rest % fny;
    const k = (rest - j) / fny;
    const axisParents = [i, j, k].map((c, a) => {
      if (!axes[a]) return [[c, 1]];
      return c % 2 === 0 ? [[c / 2, 1]] : [[(c - 1) / 2, 0.5], [(c + 1) / 2, 0.5]];
    });
    for (const [pk, wk] of axisParents[2]) {
      for (const [pj, wj] of axisParents[1]) {
        for (const [pi, wi] of axisParents[0]) {
          const id = coarse.nodeMap[(pk * cny + pj) * cnx + pi];
          columns.push(id);
          weights.push(wi * wj * wk);
        }
      }
    }
    rowStart[n + 1] = columns.length;
  }
  return { rowStart, columns: Int32Array.from(columns), weights: Float32Array.from(weights) };
}

function prolong(transfer, coarseVec, fineVec) {
  const { rowStart, columns, weights } = transfer;
  const n = rowStart.length - 1;
  for (let f = 0; f < n; f++) {
    let v0 = 0;
    let v1 = 0;
    let v2 = 0;
    for (let s = rowStart[f]; s < rowStart[f + 1]; s++) {
      const c = 3 * columns[s];
      const w = weights[s];
      v0 += w * coarseVec[c];
      v1 += w * coarseVec[c + 1];
      v2 += w * coarseVec[c + 2];
    }
    fineVec[3 * f] = v0;
    fineVec[3 * f + 1] = v1;
    fineVec[3 * f + 2] = v2;
  }
}

function restrict(transfer, fineVec, coarseVec) {
  const { rowStart, columns, weights } = transfer;
  const n = rowStart.length - 1;
  coarseVec.fill(0);
  for (let f = 0; f < n; f++) {
    const r0 = fineVec[3 * f];
    const r1 = fineVec[3 * f + 1];
    const r2 = fineVec[3 * f + 2];
    for (let s = rowStart[f]; s < rowStart[f + 1]; s++) {
      const c = 3 * columns[s];
      const w = weights[s];
      coarseVec[c] += w * r0;
      coarseVec[c + 1] += w * r1;
      coarseVec[c + 2] += w * r2;
    }
  }
}

// Numbering for the direct solve: free nodes ordered with the longest active axis slowest.
// Returns { index (dof index per stored dof, -1 for blocked), size, bandwidth }.
function directNumbering(level) {
  const dims = level.nodeDims;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  const coords = new Int32Array(3 * level.nodeCount);
  for (let n = 0; n < level.nodeCount; n++) {
    const g = level.gridNode[n];
    const i = g % dims[0];
    const rest = (g - i) / dims[0];
    const j = rest % dims[1];
    const k = (rest - j) / dims[1];
    coords[3 * n] = i;
    coords[3 * n + 1] = j;
    coords[3 * n + 2] = k;
    for (let a = 0; a < 3; a++) {
      const c = coords[3 * n + a];
      if (c < lo[a]) lo[a] = c;
      if (c > hi[a]) hi[a] = c;
    }
  }
  const extent = hi.map((h, a) => h - lo[a] + 1);
  const axes = [0, 1, 2].sort((a, b) => extent[a] - extent[b]);
  const stride = [0, 0, 0];
  stride[axes[0]] = 1;
  stride[axes[1]] = extent[axes[0]];
  stride[axes[2]] = extent[axes[0]] * extent[axes[1]];
  const rank = new Float64Array(level.nodeCount);
  for (let n = 0; n < level.nodeCount; n++) {
    rank[n] = (coords[3 * n] - lo[0]) * stride[0] + (coords[3 * n + 1] - lo[1]) * stride[1] + (coords[3 * n + 2] - lo[2]) * stride[2];
  }
  const order = [];
  for (let n = 0; n < level.nodeCount; n++) if (level.free[n]) order.push(n);
  order.sort((p, q) => rank[p] - rank[q]);
  const index = new Int32Array(3 * level.nodeCount).fill(-1);
  order.forEach((node, position) => {
    for (let c = 0; c < 3; c++) index[3 * node + c] = 3 * position + c;
  });
  let bandwidth = 0;
  for (let q = 0; q < level.cellCount; q++) {
    let low = Infinity;
    let high = -Infinity;
    for (let a = 0; a < 8; a++) {
      for (let c = 0; c < 3; c++) {
        const d = index[3 * level.cellNodes[8 * q + a] + c];
        if (d < 0) continue;
        if (d < low) low = d;
        if (d > high) high = d;
      }
    }
    if (high - low > bandwidth) bandwidth = high - low;
  }
  return { index, size: 3 * order.length, bandwidth };
}

export class Multigrid {
  constructor(finest) {
    this.levels = [finest];
    this.transfers = [];
    this.numbering = directNumbering(finest);
    for (let l = 0; l < MAX_LEVELS; l++) {
      const level = this.levels[l];
      const { size, bandwidth } = this.numbering;
      if (size * bandwidth * bandwidth <= COARSE_COST_LIMIT) break;
      const axes = halvedAxes(level.counts);
      if (!axes.some(Boolean)) break;
      const { level: next, transfer } = coarsen(level, axes);
      this.transfers.push(transfer);
      this.levels.push(next);
      this.numbering = directNumbering(next);
    }
    this.work = this.levels.map((lv) => ({
      r: new Float64Array(3 * lv.nodeCount),
      d: new Float64Array(3 * lv.nodeCount),
      t: new Float64Array(3 * lv.nodeCount),
      x: new Float64Array(3 * lv.nodeCount),
      b: new Float64Array(3 * lv.nodeCount),
    }));
    this.lambdaMax = this.levels.map((lv) => this.#estimateLambdaMax(lv));
    this.#factorCoarsest();
  }

  // Largest eigenvalue of D^-1 A by power iteration (fixed start vector), with safety margin
  #estimateLambdaMax(level) {
    const n = 3 * level.nodeCount;
    const v = new Float64Array(n);
    const av = new Float64Array(n);
    let seed = 987654321;
    for (let i = 0; i < n; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      v[i] = seed / 2147483648 - 0.5;
    }
    level.zeroBlocked(v);
    let lambda = 1;
    for (let it = 0; it < POWER_ITERATIONS; it++) {
      level.apply(v, av);
      let num = 0;
      let den = 0;
      for (let i = 0; i < n; i++) {
        num += v[i] * av[i];
        den += v[i] * v[i] * level.diagonal[i];
      }
      if (!(den > 0)) return 1;
      lambda = num / den;
      let norm = 0;
      for (let i = 0; i < n; i++) {
        v[i] = av[i] / level.diagonal[i];
        norm += v[i] * v[i];
      }
      norm = Math.sqrt(norm);
      if (!(norm > 0)) return 1;
      for (let i = 0; i < n; i++) v[i] /= norm;
    }
    return LAMBDA_MARGIN * lambda;
  }

  #factorCoarsest() {
    const level = this.levels[this.levels.length - 1];
    const { index, size, bandwidth } = this.numbering;
    this.direct = null;
    if (size === 0 || size * bandwidth * bandwidth > COARSE_COST_LIMIT) return;
    const band = new Float64Array(size * (bandwidth + 1));
    const matrix = new Float64Array(NODE_DOFS * NODE_DOFS);
    for (let q = 0; q < level.cellCount; q++) {
      level.cellMatrix(q, matrix);
      for (let a = 0; a < NODE_DOFS; a++) {
        const gi = index[3 * level.cellNodes[8 * q + Math.floor(a / 3)] + (a % 3)];
        if (gi < 0) continue;
        for (let b = 0; b < NODE_DOFS; b++) {
          const gj = index[3 * level.cellNodes[8 * q + Math.floor(b / 3)] + (b % 3)];
          if (gj < 0 || gj > gi) continue;
          band[bandIndex(gi, gj, bandwidth)] += matrix[a * NODE_DOFS + b];
        }
      }
    }
    try {
      bandCholeskyFactor(band, size, bandwidth);
    } catch (error) {
      if (!(error instanceof CholeskyError)) throw error;
      // coarse problem lost positive definiteness (supports too sparse at this level): smooth instead
      return;
    }
    this.direct = { band, index, size, bandwidth };
  }

  // One Chebyshev smoothing pass on level l: improves x for A x = b. x may start nonzero.
  #smooth(l, x, b, zeroStart) {
    const level = this.levels[l];
    const { r, d, t } = this.work[l];
    const n = 3 * level.nodeCount;
    const diag = level.diagonal;
    const lmax = this.lambdaMax[l];
    const lmin = lmax / SMOOTH_RATIO;
    const theta = 0.5 * (lmax + lmin);
    const delta = 0.5 * (lmax - lmin);
    const sigma = theta / delta;
    let rho = 1 / sigma;
    if (zeroStart) {
      x.fill(0);
      r.set(b);
    } else {
      level.apply(x, t);
      for (let i = 0; i < n; i++) r[i] = b[i] - t[i];
    }
    for (let i = 0; i < n; i++) d[i] = r[i] / (diag[i] * theta);
    level.zeroBlocked(d);
    for (let i = 0; i < n; i++) x[i] += d[i];
    for (let step = 1; step < CHEBYSHEV_DEGREE; step++) {
      level.apply(d, t);
      for (let i = 0; i < n; i++) r[i] -= t[i];
      const rhoNew = 1 / (2 * sigma - rho);
      for (let i = 0; i < n; i++) d[i] = rhoNew * rho * d[i] + ((2 * rhoNew) / delta) * (r[i] / diag[i]);
      level.zeroBlocked(d);
      for (let i = 0; i < n; i++) x[i] += d[i];
      rho = rhoNew;
    }
  }

  #solveCoarsest(x, b) {
    const l = this.levels.length - 1;
    if (this.direct) {
      const { band, index, size, bandwidth } = this.direct;
      const rhs = new Float64Array(size);
      for (let i = 0; i < index.length; i++) if (index[i] >= 0) rhs[index[i]] = b[i];
      bandCholeskySolve(band, size, bandwidth, rhs);
      x.fill(0);
      for (let i = 0; i < index.length; i++) if (index[i] >= 0) x[i] = rhs[index[i]];
      return;
    }
    x.fill(0);
    for (let s = 0; s < COARSE_SMOOTH_STEPS; s++) this.#smooth(l, x, b, false);
  }

  // x = M^-1 b, one V-cycle starting at level l
  cycle(l, b, x) {
    if (l === this.levels.length - 1) {
      this.#solveCoarsest(x, b);
      return;
    }
    const level = this.levels[l];
    const n = 3 * level.nodeCount;
    const w = this.work[l];
    const next = this.work[l + 1];
    this.#smooth(l, x, b, true);
    level.apply(x, w.t);
    for (let i = 0; i < n; i++) w.r[i] = b[i] - w.t[i];
    restrict(this.transfers[l], w.r, next.b);
    this.levels[l + 1].zeroBlocked(next.b);
    this.cycle(l + 1, next.b, next.x);
    prolong(this.transfers[l], next.x, w.d);
    level.zeroBlocked(w.d);
    for (let i = 0; i < n; i++) x[i] += w.d[i];
    this.#smooth(l, x, b, false);
  }
}
