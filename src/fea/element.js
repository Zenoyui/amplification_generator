// Eight-node brick with 9 incompatible modes on a rectangular cell.
// Reference stiffness uses E = 1 Pa; real stiffness is E * ke. Stress is independent of E for given forces.
// Cut cells integrate over 64 sub-cubes (one 2-point Gauss point each) with material fractions alpha.

import { choleskyFactor, choleskySolve, CholeskyError } from '../math/dense.js';

const GAUSS = 1 / Math.sqrt(3);
export const NODE_DOFS = 24;
const GAUSS_POINTS = 8;
const MODE_COUNT = 9;
export const SUB_CUBES = 64;
// Added to the diagonal of the mode matrix, relative to its mean diagonal, for cells with little material
const MODE_REGULARIZATION = 1e-9;
// Share of the full cell stiffness added to every cut cell, so that nodes lying in empty space stay
// tied to their neighbours (finite cell method fictitious domain stiffness)
export const FICTITIOUS_STIFFNESS = 1e-3;

// Bit a = ia + 2 ja + 4 ka of node and gauss point selects the sign along x, y, z
const sign = (bit) => (bit ? 1 : -1);

// Isotropic constitutive matrix, engineering shear strain, order xx yy zz xy yz xz
export function constitutive(youngs_pa, poisson) {
  const lambda = (youngs_pa * poisson) / ((1 + poisson) * (1 - 2 * poisson));
  const mu = youngs_pa / (2 * (1 + poisson));
  const d = new Float64Array(36);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) d[i * 6 + j] = lambda;
    d[i * 6 + i] = lambda + 2 * mu;
    d[(i + 3) * 6 + (i + 3)] = mu;
  }
  return d;
}

// Shape function derivatives of the 8 nodes at natural point (xi, eta, zeta), physical axes
function shapeGradients(xi, eta, zeta, h_m) {
  const grad = new Float64Array(24);
  for (let a = 0; a < 8; a++) {
    const sx = sign(a & 1);
    const sy = sign(a & 2);
    const sz = sign(a & 4);
    const fx = 1 + sx * xi;
    const fy = 1 + sy * eta;
    const fz = 1 + sz * zeta;
    grad[3 * a] = (sx * fy * fz) / 8 / (h_m[0] / 2);
    grad[3 * a + 1] = (fx * sy * fz) / 8 / (h_m[1] / 2);
    grad[3 * a + 2] = (fx * fy * sz) / 8 / (h_m[2] / 2);
  }
  return grad;
}

// Strain-displacement matrix of the 8 nodes, 6 x 24
function nodalStrainMatrix(grad) {
  const b = new Float64Array(6 * NODE_DOFS);
  for (let a = 0; a < 8; a++) {
    const dx = grad[3 * a];
    const dy = grad[3 * a + 1];
    const dz = grad[3 * a + 2];
    const col = 3 * a;
    b[0 * 24 + col] = dx;
    b[1 * 24 + col + 1] = dy;
    b[2 * 24 + col + 2] = dz;
    b[3 * 24 + col] = dy;
    b[3 * 24 + col + 1] = dx;
    b[4 * 24 + col + 1] = dz;
    b[4 * 24 + col + 2] = dy;
    b[5 * 24 + col] = dz;
    b[5 * 24 + col + 2] = dx;
  }
  return b;
}

// Strain matrix of the incompatible modes, 6 x 9. Parameter index p = 3 * axis + component:
// mode 'axis' adds (1 - s^2) to displacement component 'component' along natural coordinate s
function modeStrainMatrix(natural, h_m) {
  const g = new Float64Array(6 * MODE_COUNT);
  const shearRow = (a, b) => (a + b === 1 ? 3 : a + b === 3 ? 4 : 5);
  for (let axis = 0; axis < 3; axis++) {
    const slope = (-2 * natural[axis]) / (h_m[axis] / 2);
    for (let component = 0; component < 3; component++) {
      const column = 3 * axis + component;
      if (component === axis) g[component * MODE_COUNT + column] = slope;
      else g[shearRow(component, axis) * MODE_COUNT + column] = slope;
    }
  }
  return g;
}

// out[r][c] += scale * sum_k left[k][r] * mid[k][m] * right[m][c] for dense small blocks
function accumulateTriple(out, outCols, left, leftCols, mid, right, rightCols, scale) {
  const rows = leftCols;
  for (let r = 0; r < rows; r++) {
    for (let m = 0; m < 6; m++) {
      let dl = 0;
      for (let k = 0; k < 6; k++) dl += left[k * leftCols + r] * mid[k * 6 + m];
      dl *= scale;
      for (let c = 0; c < rightCols; c++) out[r * outCols + c] += dl * right[m * rightCols + c];
    }
  }
}

// Static condensation: q = Kaa^-1 Kua^T (9 x 24) and ke = kuu - kua q. kaa is overwritten by its factor.
function condense(kuu, kua, kaa) {
  let meanDiagonal = 0;
  for (let m = 0; m < MODE_COUNT; m++) meanDiagonal += kaa[m * MODE_COUNT + m] / MODE_COUNT;
  for (let m = 0; m < MODE_COUNT; m++) kaa[m * MODE_COUNT + m] += MODE_REGULARIZATION * meanDiagonal;
  choleskyFactor(kaa, MODE_COUNT);
  const q = new Float64Array(MODE_COUNT * 24);
  const column = new Float64Array(MODE_COUNT);
  for (let c = 0; c < 24; c++) {
    for (let r = 0; r < MODE_COUNT; r++) column[r] = kua[c * MODE_COUNT + r];
    choleskySolve(kaa, MODE_COUNT, column);
    for (let r = 0; r < MODE_COUNT; r++) q[r * 24 + c] = column[r];
  }
  const ke = new Float64Array(kuu);
  for (let i = 0; i < 24; i++) {
    for (let j = 0; j < 24; j++) {
      let acc = 0;
      for (let m = 0; m < MODE_COUNT; m++) acc += kua[i * MODE_COUNT + m] * q[m * 24 + j];
      ke[i * 24 + j] -= acc;
    }
  }
  for (let i = 0; i < 24; i++) {
    for (let j = i + 1; j < 24; j++) {
      const mean = 0.5 * (ke[i * 24 + j] + ke[j * 24 + i]);
      ke[i * 24 + j] = mean;
      ke[j * 24 + i] = mean;
    }
  }
  return { ke, q };
}

// 1D sub-cube gauss positions inside the cell (fraction of the cell size): two Gauss points per half cell
const SUB_POSITION = [0.25 - 0.25 * GAUSS, 0.25 + 0.25 * GAUSS, 0.75 - 0.25 * GAUSS, 0.75 + 0.25 * GAUSS];

// Sub-cube index s = ix + 4 iy + 16 iz; its centre is at (i + 0.5) / 4 of the cell

// Reference element for cell sizes h_m = [hx, hy, hz] (meters), E = 1: ke 24 x 24 condensed stiffness,
// stressB 8 x 6 x 24 (D B) and stressG 8 x 6 x 9 (D G) at gauss points, q 9 x 24 (modes = -q u),
// extrap 8 x 8 (corner values = extrap * gauss values), sub: sample tables for cut cells
export function buildElement(h_m, poisson) {
  const d = constitutive(1, poisson);
  const detJ = (h_m[0] * h_m[1] * h_m[2]) / 8;
  const kuu = new Float64Array(24 * 24);
  const kua = new Float64Array(24 * MODE_COUNT);
  const kaa = new Float64Array(MODE_COUNT * MODE_COUNT);
  const stressB = new Float64Array(GAUSS_POINTS * 6 * 24);
  const stressG = new Float64Array(GAUSS_POINTS * 6 * MODE_COUNT);
  for (let g = 0; g < GAUSS_POINTS; g++) {
    const natural = [sign(g & 1) * GAUSS, sign(g & 2) * GAUSS, sign(g & 4) * GAUSS];
    const b = nodalStrainMatrix(shapeGradients(natural[0], natural[1], natural[2], h_m));
    const gm = modeStrainMatrix(natural, h_m);
    accumulateTriple(kuu, 24, b, 24, d, b, 24, detJ);
    accumulateTriple(kua, MODE_COUNT, b, 24, d, gm, MODE_COUNT, detJ);
    accumulateTriple(kaa, MODE_COUNT, gm, MODE_COUNT, d, gm, MODE_COUNT, detJ);
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 24; c++) {
        let acc = 0;
        for (let k = 0; k < 6; k++) acc += d[r * 6 + k] * b[k * 24 + c];
        stressB[(g * 6 + r) * 24 + c] = acc;
      }
      for (let c = 0; c < MODE_COUNT; c++) {
        let acc = 0;
        for (let k = 0; k < 6; k++) acc += d[r * 6 + k] * gm[k * MODE_COUNT + c];
        stressG[(g * 6 + r) * MODE_COUNT + c] = acc;
      }
    }
  }
  const { ke, q } = condense(kuu, kua, kaa);
  return { ke, q, stressB, stressG, extrap: gaussToCornerMatrix(), poisson, h_m, sub: buildSubTables(h_m, d) };
}

// Stress at the 8 gauss points of a cell for displacement u (24) and mode recovery q (9 x 24): out (8 x 6)
export function gaussStress(element, q, u, out) {
  const modes = new Float64Array(MODE_COUNT);
  for (let m = 0; m < MODE_COUNT; m++) {
    let acc = 0;
    for (let c = 0; c < 24; c++) acc -= q[m * 24 + c] * u[c];
    modes[m] = acc;
  }
  for (let row = 0; row < GAUSS_POINTS * 6; row++) {
    let acc = 0;
    const base = row * 24;
    for (let c = 0; c < 24; c++) acc += element.stressB[base + c] * u[c];
    const gBase = row * MODE_COUNT;
    for (let m = 0; m < MODE_COUNT; m++) acc += element.stressG[gBase + m] * modes[m];
    out[row] = acc;
  }
}

// Per sub-cube terms of the three condensation blocks, weight included (E = 1)
function buildSubTables(h_m, d) {
  const detJ = (h_m[0] * h_m[1] * h_m[2]) / 8;
  const weight = detJ / 8;
  const kuu = new Float64Array(SUB_CUBES * 24 * 24);
  const kua = new Float64Array(SUB_CUBES * 24 * MODE_COUNT);
  const kaa = new Float64Array(SUB_CUBES * MODE_COUNT * MODE_COUNT);
  for (let s = 0; s < SUB_CUBES; s++) {
    const natural = [2 * SUB_POSITION[s & 3] - 1, 2 * SUB_POSITION[(s >> 2) & 3] - 1, 2 * SUB_POSITION[(s >> 4) & 3] - 1];
    const b = nodalStrainMatrix(shapeGradients(natural[0], natural[1], natural[2], h_m));
    const gm = modeStrainMatrix(natural, h_m);
    const kuuS = new Float64Array(24 * 24);
    const kuaS = new Float64Array(24 * MODE_COUNT);
    const kaaS = new Float64Array(MODE_COUNT * MODE_COUNT);
    accumulateTriple(kuuS, 24, b, 24, d, b, 24, weight);
    accumulateTriple(kuaS, MODE_COUNT, b, 24, d, gm, MODE_COUNT, weight);
    accumulateTriple(kaaS, MODE_COUNT, gm, MODE_COUNT, d, gm, MODE_COUNT, weight);
    kuu.set(kuuS, s * 24 * 24);
    kua.set(kuaS, s * 24 * MODE_COUNT);
    kaa.set(kaaS, s * MODE_COUNT * MODE_COUNT);
  }
  return { kuu, kua, kaa, shape: subShapeTable() };
}

// Corner shape function values at the 64 sub-cube gauss points, 64 x 8
function subShapeTable() {
  const shape = new Float64Array(SUB_CUBES * 8);
  for (let s = 0; s < SUB_CUBES; s++) {
    const natural = [2 * SUB_POSITION[s & 3] - 1, 2 * SUB_POSITION[(s >> 2) & 3] - 1, 2 * SUB_POSITION[(s >> 4) & 3] - 1];
    for (let a = 0; a < 8; a++) {
      shape[s * 8 + a] = ((1 + sign(a & 1) * natural[0]) * (1 + sign(a & 2) * natural[1]) * (1 + sign(a & 4) * natural[2])) / 8;
    }
  }
  return shape;
}

// Shares of the cell material (fractions of the cell volume) carried by each of the 8 corner nodes
export function cornerMaterialShares(element, alpha, out) {
  out.fill(0);
  const { shape } = element.sub;
  for (let s = 0; s < SUB_CUBES; s++) {
    const a = alpha[s] / SUB_CUBES;
    for (let c = 0; c < 8; c++) out[c] += a * shape[s * 8 + c];
  }
}

// Stiffness and mode recovery of a cut cell from sub-cube fractions alpha (64 values in [0, 1]).
// Returns null when the cell has no usable material (all fractions zero).
export function cutElement(element, alpha) {
  const { kuu: tuu, kua: tua, kaa: taa } = element.sub;
  const kuu = new Float64Array(24 * 24);
  const kua = new Float64Array(24 * MODE_COUNT);
  const kaa = new Float64Array(MODE_COUNT * MODE_COUNT);
  let total = 0;
  for (let s = 0; s < SUB_CUBES; s++) {
    const a = alpha[s];
    if (a <= 0) continue;
    total += a;
    const uu = s * 24 * 24;
    for (let i = 0; i < 24 * 24; i++) kuu[i] += a * tuu[uu + i];
    const ua = s * 24 * MODE_COUNT;
    for (let i = 0; i < 24 * MODE_COUNT; i++) kua[i] += a * tua[ua + i];
    const aa = s * MODE_COUNT * MODE_COUNT;
    for (let i = 0; i < MODE_COUNT * MODE_COUNT; i++) kaa[i] += a * taa[aa + i];
  }
  if (!(total > 0)) return null;
  try {
    const cut = condense(kuu, kua, kaa);
    for (let i = 0; i < cut.ke.length; i++) cut.ke[i] += FICTITIOUS_STIFFNESS * element.ke[i];
    return cut;
  } catch (error) {
    if (!(error instanceof CholeskyError)) throw error;
    return null;
  }
}

// Inverse of the 8 x 8 matrix N[g][a] of corner shape functions at gauss points (Kronecker of 1D blocks)
function gaussToCornerMatrix() {
  // 1D: N[g][a] = (1 + s_g s_a / sqrt(3)) / 2 with s = +-1; inverse of [[p, q],[q, p]] is [[p, -q],[-q, p]] / (p^2 - q^2)
  const p = (1 + GAUSS) / 2;
  const q = (1 - GAUSS) / 2;
  const det = p * p - q * q;
  const inv = [
    [p / det, -q / det],
    [-q / det, p / det],
  ];
  const e = new Float64Array(64);
  for (let a = 0; a < 8; a++) {
    for (let g = 0; g < 8; g++) {
      e[a * 8 + g] =
        inv[a & 1][g & 1] * inv[(a >> 1) & 1][(g >> 1) & 1] * inv[(a >> 2) & 1][(g >> 2) & 1];
    }
  }
  return e;
}
