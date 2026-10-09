// Stress recovery: gauss point stress per solid cell, corner extrapolation, nodal averaging

import { SOLID_WEIGHT } from './grid.js';
import { gaussStress } from './element.js';

const STRESS_COMPONENTS = 6;

// uHat: displacement solving the E = 1 system (3 per node). Returns nodal averaged stress tensor
// (6 per node, Pa) and count of contributing cells per node.
export function recoverNodalStress(grid, element, uHat) {
  const [nx, ny, nz] = grid.counts;
  const nodeCount = (nx + 1) * (ny + 1) * (nz + 1);
  const sum = new Float64Array(STRESS_COMPONENTS * nodeCount);
  const count = new Uint8Array(nodeCount);
  const sy = nx + 1;
  const sz = sy * (ny + 1);
  const offsets = [0, 1, sy, sy + 1, sz, sz + 1, sz + sy, sz + sy + 1];
  const ue = new Float64Array(24);
  const gaussValues = new Float64Array(8 * STRESS_COMPONENTS);
  const { extrap } = element;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const cell = (k * ny + j) * nx + i;
        if (grid.weight[cell] < SOLID_WEIGHT) continue;
        const n0 = k * sz + j * sy + i;
        for (let a = 0; a < 8; a++) {
          const base = 3 * (n0 + offsets[a]);
          ue[3 * a] = uHat[base];
          ue[3 * a + 1] = uHat[base + 1];
          ue[3 * a + 2] = uHat[base + 2];
        }
        gaussStress(element, element.q, ue, gaussValues);
        for (let a = 0; a < 8; a++) {
          const node = n0 + offsets[a];
          for (let comp = 0; comp < STRESS_COMPONENTS; comp++) {
            let acc = 0;
            for (let g = 0; g < 8; g++) acc += extrap[a * 8 + g] * gaussValues[g * STRESS_COMPONENTS + comp];
            sum[STRESS_COMPONENTS * node + comp] += acc;
          }
          count[node]++;
        }
      }
    }
  }
  const stress_pa = new Float32Array(STRESS_COMPONENTS * nodeCount);
  for (let node = 0; node < nodeCount; node++) {
    if (count[node] === 0) continue;
    for (let comp = 0; comp < STRESS_COMPONENTS; comp++) {
      stress_pa[STRESS_COMPONENTS * node + comp] = sum[STRESS_COMPONENTS * node + comp] / count[node];
    }
  }
  return { stress_pa, count };
}

// Nodes within `layers` cell layers of seedNodes (index list), via cells that touch a seed node
export function nodesNearSeeds(grid, seedNodes, layers) {
  const [nx, ny, nz] = grid.counts;
  const nodeCount = (nx + 1) * (ny + 1) * (nz + 1);
  const near = new Uint8Array(nodeCount);
  for (const n of seedNodes) near[n] = 1;
  const sy = nx + 1;
  const sz = sy * (ny + 1);
  const offsets = [0, 1, sy, sy + 1, sz, sz + 1, sz + sy, sz + sy + 1];
  for (let layer = 0; layer < layers; layer++) {
    const snapshot = Uint8Array.from(near);
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const n0 = k * sz + j * sy + i;
          let touched = false;
          for (const off of offsets) if (snapshot[n0 + off]) touched = true;
          if (!touched) continue;
          for (const off of offsets) near[n0 + off] = 1;
        }
      }
    }
  }
  return near;
}

// Points where grid edges cross the surface (node phi changes sign) and both edge nodes carry stress:
// [{ n0, n1, t }] with the crossing at n0 + t (n1 - n0)
export function surfaceCrossings(grid, count) {
  const [nx, ny, nz] = grid.counts;
  const sy = nx + 1;
  const sz = sy * (ny + 1);
  const crossings = [];
  const test = (n0, n1) => {
    const a = grid.phi[n0];
    const b = grid.phi[n1];
    if (count[n0] === 0 || count[n1] === 0) return;
    if ((a < 0) === (b < 0)) return;
    crossings.push({ n0, n1, t: a / (a - b) });
  };
  for (let k = 0; k <= nz; k++) {
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i <= nx; i++) {
        const n = k * sz + j * sy + i;
        if (i < nx) test(n, n + 1);
        if (j < ny) test(n, n + sy);
        if (k < nz) test(n, n + sz);
      }
    }
  }
  return crossings;
}
