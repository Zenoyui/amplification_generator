// Uniform voxel grid sampled from a signed distance function (negative inside, meters).
// Each cell gets a material volume fraction w in [0, 1]; cells crossed by the surface also keep fractions of
// their 64 sub-cubes (see element.js).

import { SUB_CUBES } from './element.js';

// Cells with weight below this are treated as empty
export const WEIGHT_CUTOFF = 0.02;
const SUB = 4;
// A cell is skipped as full or empty when a corner lies farther than BAND_FACTOR * diagonal from the surface.
// The factor exceeds 1 because round union fields have gradient length up to sqrt(2).
const BAND_FACTOR = 2;
// Cells with weight at least this are 'solid' (stress is reported there)
export const SOLID_WEIGHT = 0.5;
const GRADIENT_ZERO = 1e-12;

export function nodeIndex(counts, i, j, k) {
  return (k * (counts[1] + 1) + j) * (counts[0] + 1) + i;
}

// sdf(x_m, y_m, z_m) -> distance in meters. Returns grid with node field phi and cell weights.
export function sampleGrid(sdf, min_m, cell_m, counts) {
  const [nx, ny, nz] = counts;
  const nodeCount = (nx + 1) * (ny + 1) * (nz + 1);
  const phi = new Float32Array(nodeCount);
  let p = 0;
  for (let k = 0; k <= nz; k++) {
    const z = min_m[2] + k * cell_m[2];
    for (let j = 0; j <= ny; j++) {
      const y = min_m[1] + j * cell_m[1];
      for (let i = 0; i <= nx; i++) phi[p++] = sdf(min_m[0] + i * cell_m[0], y, z);
    }
  }

  const weight = new Float32Array(nx * ny * nz);
  const diagonal_m = Math.hypot(cell_m[0], cell_m[1], cell_m[2]);
  const band_m = BAND_FACTOR * diagonal_m;
  const sx = 1;
  const sy = nx + 1;
  const sz = (nx + 1) * (ny + 1);
  const cutCells = [];
  const cutAlpha = [];
  const cutIndex = new Int32Array(nx * ny * nz).fill(-1);
  const lattice3 = new Float64Array(27);
  const lattice5 = new Float64Array(125);
  const alpha = new Float64Array(SUB_CUBES);
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const n0 = k * sz + j * sy + i;
        const corner0 = phi[n0];
        let nearest_m = Math.abs(corner0);
        for (const off of [sx, sy, sx + sy, sz, sz + sx, sz + sy, sz + sx + sy]) {
          const mag = Math.abs(phi[n0 + off]);
          if (mag < nearest_m) nearest_m = mag;
        }
        const cell = (k * ny + j) * nx + i;
        if (nearest_m > band_m) {
          weight[cell] = corner0 < 0 ? 1 : 0;
          continue;
        }
        const origin = [min_m[0] + i * cell_m[0], min_m[1] + j * cell_m[1], min_m[2] + k * cell_m[2]];
        const state = classifyCell(sdf, origin, cell_m, lattice3, lattice5, alpha);
        weight[cell] = state.weight;
        if (state.cut) {
          cutIndex[cell] = cutCells.length;
          cutCells.push(cell);
          cutAlpha.push(Float32Array.from(alpha));
        }
      }
    }
  }
  return {
    counts: [nx, ny, nz],
    cell_m: [...cell_m],
    min_m: [...min_m],
    phi,
    weight,
    cut: { cells: Int32Array.from(cutCells), alpha: cutAlpha, index: cutIndex },
  };
}

// Corner values within this fraction of the cell size count as on the surface
const ON_SURFACE_FRACTION = 1e-6;
// A cell whose sub-cube fractions sum above this share of the 64 is treated as full
const FULL_SHARE = 1 - 1e-9;

// Material state of a cell near the surface. Fills alpha (64 sub-cube fractions) for cut cells.
// Returns { weight, cut }.
function classifyCell(sdf, origin, cell_m, lattice3, lattice5, alpha) {
  const tolerance_m = ON_SURFACE_FRACTION * Math.max(...cell_m);
  let lo = Infinity;
  let hi = -Infinity;
  for (let c = 0; c < 3; c++) {
    for (let b = 0; b < 3; b++) {
      for (let a = 0; a < 3; a++) {
        const v = sdf(origin[0] + (a * cell_m[0]) / 2, origin[1] + (b * cell_m[1]) / 2, origin[2] + (c * cell_m[2]) / 2);
        lattice3[(c * 3 + b) * 3 + a] = v;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
  }
  if (hi <= tolerance_m) return { weight: 1, cut: false };
  if (lo >= -tolerance_m) return { weight: 0, cut: false };
  for (let c = 0; c <= SUB; c++) {
    for (let b = 0; b <= SUB; b++) {
      for (let a = 0; a <= SUB; a++) {
        const index = (c * (SUB + 1) + b) * (SUB + 1) + a;
        const even = a % 2 === 0 && b % 2 === 0 && c % 2 === 0;
        lattice5[index] = even
          ? lattice3[((c / 2) * 3 + b / 2) * 3 + a / 2]
          : sdf(origin[0] + (a * cell_m[0]) / SUB, origin[1] + (b * cell_m[1]) / SUB, origin[2] + (c * cell_m[2]) / SUB);
      }
    }
  }
  const size = cell_m.map((h) => h / SUB);
  let total = 0;
  for (let c = 0; c < SUB; c++) {
    for (let b = 0; b < SUB; b++) {
      for (let a = 0; a < SUB; a++) {
        const fraction = subCubeFraction(lattice5, a, b, c, size, tolerance_m);
        alpha[a + SUB * b + SUB * SUB * c] = fraction;
        total += fraction;
      }
    }
  }
  if (total >= FULL_SHARE * SUB_CUBES) return { weight: 1, cut: false };
  return { weight: total / SUB_CUBES, cut: true };
}

// Fraction of the sub-cube (a, b, c) inside the material, from the 8 corner values of the 5 x 5 x 5 lattice
function subCubeFraction(lattice5, a, b, c, size, tolerance_m) {
  const at = (da, db, dc) => lattice5[((c + dc) * (SUB + 1) + (b + db)) * (SUB + 1) + a + da];
  let lo = Infinity;
  let hi = -Infinity;
  let mean = 0;
  let gx = 0;
  let gy = 0;
  let gz = 0;
  for (let corner = 0; corner < 8; corner++) {
    const da = corner & 1;
    const db = (corner >> 1) & 1;
    const dc = (corner >> 2) & 1;
    const v = at(da, db, dc);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
    mean += v / 8;
    gx += (da ? 1 : -1) * v;
    gy += (db ? 1 : -1) * v;
    gz += (dc ? 1 : -1) * v;
  }
  if (hi <= tolerance_m) return 1;
  if (lo >= -tolerance_m) return 0;
  gx /= 4 * size[0];
  gy /= 4 * size[1];
  gz /= 4 * size[2];
  const gradLength = Math.hypot(gx, gy, gz);
  if (gradLength < GRADIENT_ZERO) return mean < 0 ? 1 : 0;
  const ramp_m = (Math.abs(gx) * size[0] + Math.abs(gy) * size[1] + Math.abs(gz) * size[2]) / gradLength;
  const fraction = 0.5 - mean / ramp_m;
  return fraction < 0 ? 0 : fraction > 1 ? 1 : fraction;
}
