// One multigrid level on a sparse voxel set: only cells with material and their nodes are stored.
// Vectors have 3 values per stored node. Full cells of the finest level share the reference element times a
// weight; cut cells and all cells of coarser levels own element matrices (packed upper triangle, slot >= 0).

import { buildElement, cutElement, NODE_DOFS } from './element.js';
import { WEIGHT_CUTOFF } from './grid.js';

// Packed upper triangle of a 24 x 24 symmetric matrix
export const TRI_LENGTH = (NODE_DOFS * (NODE_DOFS + 1)) / 2;
export const TRI_OFFSET = Int32Array.from({ length: NODE_DOFS }, (_, r) => NODE_DOFS * r - (r * (r - 1)) / 2);

// Node offsets of the 8 corners relative to the lowest corner, in grid node index units
function cornerOffsets(counts) {
  const sy = counts[0] + 1;
  const sz = sy * (counts[1] + 1);
  return [0, 1, sy, sy + 1, sz, sz + 1, sz + sy, sz + sy + 1];
}

export class Level {
  // fields: counts, cell_m, cellGrid (grid cell index per stored cell), cellNodes (8 per cell),
  // gridNode (grid node index per stored node), free (1 per free node), slot (matrix index per cell or -1),
  // weights (scalar weight per cell, used when slot is -1), tri (matrices), element (reference, finest level)
  constructor(fields) {
    Object.assign(this, fields);
    this.cellCount = this.cellGrid.length;
    this.nodeCount = this.gridNode.length;
    this.nodeDims = [this.counts[0] + 1, this.counts[1] + 1, this.counts[2] + 1];
    const blocked = [];
    let freeNodes = 0;
    for (let n = 0; n < this.nodeCount; n++) {
      if (this.free[n]) freeNodes++;
      else blocked.push(n);
    }
    this.blockedNodes = Int32Array.from(blocked);
    this.freeDofCount = 3 * freeNodes;
    this.diagonal = this.#diagonal();
  }

  #diagonal() {
    const diag = new Float64Array(3 * this.nodeCount);
    for (let q = 0; q < this.cellCount; q++) {
      for (let a = 0; a < 8; a++) {
        const base = 3 * this.cellNodes[8 * q + a];
        for (let comp = 0; comp < 3; comp++) {
          const local = 3 * a + comp;
          diag[base + comp] += this.slot[q] < 0
            ? this.weights[q] * this.element.ke[local * NODE_DOFS + local]
            : this.tri[this.slot[q] * TRI_LENGTH + TRI_OFFSET[local]];
        }
      }
    }
    for (const n of this.blockedNodes) {
      diag[3 * n] = 1;
      diag[3 * n + 1] = 1;
      diag[3 * n + 2] = 1;
    }
    return diag;
  }

  // y = A x with zero rows and columns at blocked nodes; x must hold zeros there
  apply(x, y) {
    y.fill(0);
    const xe = new Float64Array(NODE_DOFS);
    const ye = new Float64Array(NODE_DOFS);
    const nodes = this.cellNodes;
    const ke = this.element ? this.element.ke : null;
    const tri = this.tri;
    for (let q = 0; q < this.cellCount; q++) {
      gather(x, nodes, q, xe);
      const slot = this.slot[q];
      if (slot < 0) {
        const w = this.weights[q];
        for (let r = 0; r < NODE_DOFS; r++) {
          const row = r * NODE_DOFS;
          let acc = 0;
          for (let col = 0; col < NODE_DOFS; col++) acc += ke[row + col] * xe[col];
          ye[r] = w * acc;
        }
      } else {
        ye.fill(0);
        const base = slot * TRI_LENGTH;
        for (let r = 0; r < NODE_DOFS; r++) {
          const row = base + TRI_OFFSET[r] - r;
          const xr = xe[r];
          let acc = tri[row + r] * xr;
          for (let col = r + 1; col < NODE_DOFS; col++) {
            const k = tri[row + col];
            acc += k * xe[col];
            ye[col] += k * xr;
          }
          ye[r] += acc;
        }
      }
      scatter(y, nodes, q, ye);
    }
    this.zeroBlocked(y);
  }

  // Product without masking blocked rows (reaction recovery). x may hold values at blocked nodes.
  applyUnmasked(x, y) {
    const saved = this.blockedNodes;
    this.blockedNodes = new Int32Array(0);
    this.apply(x, y);
    this.blockedNodes = saved;
  }

  zeroBlocked(x) {
    const blocked = this.blockedNodes;
    for (let q = 0; q < blocked.length; q++) {
      const n = blocked[q];
      x[3 * n] = 0;
      x[3 * n + 1] = 0;
      x[3 * n + 2] = 0;
    }
  }

  // Element matrix of stored cell q as a full 24 x 24 array
  cellMatrix(q, out) {
    const slot = this.slot[q];
    if (slot < 0) {
      const ke = this.element.ke;
      const w = this.weights[q];
      for (let i = 0; i < NODE_DOFS * NODE_DOFS; i++) out[i] = w * ke[i];
      return;
    }
    const base = slot * TRI_LENGTH;
    for (let r = 0; r < NODE_DOFS; r++) {
      for (let c = r; c < NODE_DOFS; c++) {
        const k = this.tri[base + TRI_OFFSET[r] + c - r];
        out[r * NODE_DOFS + c] = k;
        out[c * NODE_DOFS + r] = k;
      }
    }
  }
}

function gather(x, nodes, q, xe) {
  for (let a = 0; a < 8; a++) {
    const base = 3 * nodes[8 * q + a];
    xe[3 * a] = x[base];
    xe[3 * a + 1] = x[base + 1];
    xe[3 * a + 2] = x[base + 2];
  }
}

function scatter(y, nodes, q, ye) {
  for (let a = 0; a < 8; a++) {
    const base = 3 * nodes[8 * q + a];
    y[base] += ye[3 * a];
    y[base + 1] += ye[3 * a + 1];
    y[base + 2] += ye[3 * a + 2];
  }
}

// Finest level from the sampled grid (weights, cut cells) and blockedGrid (Uint8 per grid node)
export function buildFinestLevel(grid, blockedGrid, poisson) {
  const { counts, cell_m, weight } = grid;
  const [nx, ny, nz] = counts;
  const element = buildElement(cell_m, poisson);
  const offsets = cornerOffsets(counts);
  const nodeMap = new Int32Array((nx + 1) * (ny + 1) * (nz + 1)).fill(-1);
  const cellGrid = [];
  const cellWeights = [];
  const slots = [];
  const matrices = [];
  const cellNodes = [];
  const gridNode = [];
  const sy = nx + 1;
  const sz = sy * (ny + 1);
  const full = new Float64Array(NODE_DOFS * NODE_DOFS);
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const cell = (k * ny + j) * nx + i;
        if (weight[cell] < WEIGHT_CUTOFF) continue;
        const cutIndex = grid.cut.index[cell];
        let slot = -1;
        if (cutIndex >= 0) {
          const cut = cutElement(element, grid.cut.alpha[cutIndex]);
          if (cut === null) continue;
          slot = matrices.length;
          full.set(cut.ke);
          matrices.push(packUpper(full));
        }
        cellGrid.push(cell);
        cellWeights.push(weight[cell]);
        slots.push(slot);
        const n0 = k * sz + j * sy + i;
        for (let a = 0; a < 8; a++) {
          const g = n0 + offsets[a];
          if (nodeMap[g] < 0) {
            nodeMap[g] = gridNode.length;
            gridNode.push(g);
          }
          cellNodes.push(nodeMap[g]);
        }
      }
    }
  }
  const free = new Uint8Array(gridNode.length);
  for (let n = 0; n < gridNode.length; n++) free[n] = blockedGrid[gridNode[n]] ? 0 : 1;
  const tri = new Float64Array(matrices.length * TRI_LENGTH);
  matrices.forEach((m, idx) => tri.set(m, idx * TRI_LENGTH));
  const level = new Level({
    counts,
    cell_m,
    cellGrid: Int32Array.from(cellGrid),
    cellNodes: Int32Array.from(cellNodes),
    gridNode: Int32Array.from(gridNode),
    free,
    weights: Float32Array.from(cellWeights),
    slot: Int32Array.from(slots),
    tri,
    element,
  });
  level.nodeMap = nodeMap;
  return level;
}

function packUpper(full) {
  const packed = new Float64Array(TRI_LENGTH);
  for (let r = 0; r < NODE_DOFS; r++) {
    for (let c = r; c < NODE_DOFS; c++) packed[TRI_OFFSET[r] + c - r] = full[r * NODE_DOFS + c];
  }
  return packed;
}
