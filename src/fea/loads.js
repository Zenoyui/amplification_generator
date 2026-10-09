// Load vectors: force on a surface patch, self weight

import { STANDARD_GRAVITY_MPS2 } from '../si/units.js';
import { WEIGHT_CUTOFF } from './grid.js';
import { cornerMaterialShares } from './element.js';

// Smallest patch radius in cells; below this the load concentrates on too few nodes
export const MIN_PATCH_CELLS = 1.5;
// Nodes farther than this many cells from the surface are not patch candidates
const SURFACE_BAND_CELLS = 0.9;
// Patch nodes must lie within this many cells of the tangent plane at the picked point
const PLANE_BAND_CELLS = 1.2;
const MIN_PATCH_NODES = 4;

// Distributes force_n (3-vector, newtons) over active surface nodes within radius_m of point_m.
// outwardNormal: unit vector of the surface at point_m. Skips nodes in 'blocked' (supports).
// Returns { nodes (count), nodeList, radius_m } and adds into b.
export function addPatchForce(grid, active, blocked, b, point_m, outwardNormal, force_n, radius_m) {
  const [nx, ny, nz] = grid.counts;
  const hMax = Math.max(...grid.cell_m);
  const radius = Math.max(radius_m, MIN_PATCH_CELLS * hMax);
  const picked = [];
  const weights = [];
  let n = 0;
  for (let k = 0; k <= nz; k++) {
    const z = grid.min_m[2] + k * grid.cell_m[2];
    for (let j = 0; j <= ny; j++) {
      const y = grid.min_m[1] + j * grid.cell_m[1];
      for (let i = 0; i <= nx; i++, n++) {
        if (!active[n] || blocked[n]) continue;
        if (Math.abs(grid.phi[n]) > SURFACE_BAND_CELLS * hMax) continue;
        const dx = grid.min_m[0] + i * grid.cell_m[0] - point_m[0];
        const dy = y - point_m[1];
        const dz = z - point_m[2];
        const along = dx * outwardNormal[0] + dy * outwardNormal[1] + dz * outwardNormal[2];
        if (Math.abs(along) > PLANE_BAND_CELLS * hMax) continue;
        const tangent = Math.sqrt(Math.max(0, dx * dx + dy * dy + dz * dz - along * along));
        if (tangent >= radius) continue;
        picked.push(n);
        weights.push(0.5 * (1 + Math.cos((Math.PI * tangent) / radius)));
      }
    }
  }
  if (picked.length < MIN_PATCH_NODES) {
    throw new Error(`load patch: too few surface nodes (found=${picked.length}, radius_m=${radius})`);
  }
  const total = weights.reduce((a, c) => a + c, 0);
  picked.forEach((node, idx) => {
    const share = weights[idx] / total;
    b[3 * node] += share * force_n[0];
    b[3 * node + 1] += share * force_n[1];
    b[3 * node + 2] += share * force_n[2];
  });
  return { nodes: picked.length, nodeList: picked, radius_m: radius };
}

// Adds self weight (gravity along gravityDir, unit vector) into b. Full cells share their mass equally between
// the 8 corners; cut cells distribute it by the sub-cube fractions and corner shape functions.
export function addSelfWeight(grid, element, b, density_kgpm3, gravityDir) {
  const [nx, ny, nz] = grid.counts;
  const cellVolume_m3 = grid.cell_m[0] * grid.cell_m[1] * grid.cell_m[2];
  const sy = nx + 1;
  const sz = sy * (ny + 1);
  const offsets = [0, 1, sy, sy + 1, sz, sz + 1, sz + sy, sz + sy + 1];
  const shares = new Float64Array(8);
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const cell = (k * ny + j) * nx + i;
        const w = grid.weight[cell];
        if (w < WEIGHT_CUTOFF) continue;
        const cutIndex = grid.cut.index[cell];
        if (cutIndex >= 0) cornerMaterialShares(element, grid.cut.alpha[cutIndex], shares);
        else shares.fill(w / 8);
        const n0 = k * sz + j * sy + i;
        for (let a = 0; a < 8; a++) {
          const force = shares[a] * cellVolume_m3 * density_kgpm3 * STANDARD_GRAVITY_MPS2;
          const node = n0 + offsets[a];
          b[3 * node] += force * gravityDir[0];
          b[3 * node + 1] += force * gravityDir[1];
          b[3 * node + 2] += force * gravityDir[2];
        }
      }
    }
  }
}

// Material volume in m3 from cell weights
export function cellVolume(grid) {
  let sum = 0;
  const cellVolume_m3 = grid.cell_m[0] * grid.cell_m[1] * grid.cell_m[2];
  for (let c = 0; c < grid.weight.length; c++) if (grid.weight[c] >= WEIGHT_CUTOFF) sum += grid.weight[c] * cellVolume_m3;
  return sum;
}
