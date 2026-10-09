// Active nodes, support connectivity, node sets on a voxel grid

import { WEIGHT_CUTOFF } from './grid.js';

const CELL_CORNERS = [
  [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
  [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
];

// Nodes reachable from supportNodes through cells with weight >= cutoff.
// Returns reachable mask over nodes and the list of dropped (unreachable active) cells.
export function reachableFromSupport(counts, weight, supportNodes) {
  const [nx, ny, nz] = counts;
  const nodeCount = (nx + 1) * (ny + 1) * (nz + 1);
  const reached = new Uint8Array(nodeCount);
  const stack = new Int32Array(nodeCount);
  let top = 0;
  for (const n of supportNodes) {
    if (!reached[n]) {
      reached[n] = 1;
      stack[top++] = n;
    }
  }
  while (top > 0) {
    const n = stack[--top];
    const i = n % (nx + 1);
    const rest = (n - i) / (nx + 1);
    const j = rest % (ny + 1);
    const k = (rest - j) / (ny + 1);
    for (let dk = -1; dk <= 0; dk++) {
      for (let dj = -1; dj <= 0; dj++) {
        for (let di = -1; di <= 0; di++) {
          const ci = i + di;
          const cj = j + dj;
          const ck = k + dk;
          if (ci < 0 || cj < 0 || ck < 0 || ci >= nx || cj >= ny || ck >= nz) continue;
          if (weight[(ck * ny + cj) * nx + ci] < WEIGHT_CUTOFF) continue;
          for (const [oi, oj, ok] of CELL_CORNERS) {
            const m = ((ck + ok) * (ny + 1) + (cj + oj)) * (nx + 1) + ci + oi;
            if (!reached[m]) {
              reached[m] = 1;
              stack[top++] = m;
            }
          }
        }
      }
    }
  }
  const dropped = [];
  for (let c = 0; c < weight.length; c++) {
    if (weight[c] < WEIGHT_CUTOFF) continue;
    const i = c % nx;
    const rest = (c - i) / nx;
    const j = rest % ny;
    const k = (rest - j) / ny;
    if (!reached[(k * (ny + 1) + j) * (nx + 1) + i]) dropped.push(c);
  }
  return { reached, dropped };
}

// Nodes belonging to at least one active cell
export function activeNodes(counts, weight) {
  const [nx, ny, nz] = counts;
  const mask = new Uint8Array((nx + 1) * (ny + 1) * (nz + 1));
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (weight[(k * ny + j) * nx + i] < WEIGHT_CUTOFF) continue;
        for (const [oi, oj, ok] of CELL_CORNERS) {
          mask[((k + ok) * (ny + 1) + (j + oj)) * (nx + 1) + i + oi] = 1;
        }
      }
    }
  }
  return mask;
}

// Nodes (index list) whose position satisfies test(x, y, z) and that are active
export function selectNodes(grid, active, test) {
  const [nx, ny, nz] = grid.counts;
  const picked = [];
  let n = 0;
  for (let k = 0; k <= nz; k++) {
    const z = grid.min_m[2] + k * grid.cell_m[2];
    for (let j = 0; j <= ny; j++) {
      const y = grid.min_m[1] + j * grid.cell_m[1];
      for (let i = 0; i <= nx; i++, n++) {
        if (active[n] && test(grid.min_m[0] + i * grid.cell_m[0], y, z)) picked.push(n);
      }
    }
  }
  return Int32Array.from(picked);
}
