// Signed distance field of a closed triangle mesh on a regular grid: exact distance in a band around the surface,
// sign by ray parity along x, trilinear interpolation between nodes.

// Band half width in cells: nodes farther from the surface hold the clamped distance
const BAND_CELLS = 3;
// Cells of margin around the bounding box
const MARGIN_CELLS = 4;
// Offsets of the parity rays from node columns, in cells, so that rays miss vertices and edges
const RAY_OFFSET = [0.3183098861, 0.1234567891];
const MAX_NODES = 18e6;

// Closest point distance from p to triangle abc (Ericson, Real-Time Collision Detection 5.1.5)
function distanceToTriangle(px, py, pz, a, b, c) {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const acx = c[0] - a[0];
  const acy = c[1] - a[1];
  const acz = c[2] - a[2];
  const apx = px - a[0];
  const apy = py - a[1];
  const apz = pz - a[2];
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  let qx;
  let qy;
  let qz;
  if (d1 <= 0 && d2 <= 0) [qx, qy, qz] = a;
  else {
    const bpx = px - b[0];
    const bpy = py - b[1];
    const bpz = pz - b[2];
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    const cpx = px - c[0];
    const cpy = py - c[1];
    const cpz = pz - c[2];
    const d5 = abx * cpx + aby * cpy + abz * cpz;
    const d6 = acx * cpx + acy * cpy + acz * cpz;
    const vc = d1 * d4 - d3 * d2;
    const vb = d5 * d2 - d1 * d6;
    const va = d3 * d6 - d5 * d4;
    if (d3 >= 0 && d4 <= d3) [qx, qy, qz] = b;
    else if (d6 >= 0 && d5 <= d6) [qx, qy, qz] = c;
    else if (vc <= 0 && d1 >= 0 && d3 <= 0) {
      const v = d1 / (d1 - d3);
      [qx, qy, qz] = [a[0] + v * abx, a[1] + v * aby, a[2] + v * abz];
    } else if (vb <= 0 && d2 >= 0 && d6 <= 0) {
      const w = d2 / (d2 - d6);
      [qx, qy, qz] = [a[0] + w * acx, a[1] + w * acy, a[2] + w * acz];
    } else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
      const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
      [qx, qy, qz] = [b[0] + w * (c[0] - b[0]), b[1] + w * (c[1] - b[1]), b[2] + w * (c[2] - b[2])];
    } else {
      const denom = 1 / (va + vb + vc);
      const v = vb * denom;
      const w = vc * denom;
      [qx, qy, qz] = [a[0] + abx * v + acx * w, a[1] + aby * v + acy * w, a[2] + abz * v + acz * w];
    }
  }
  return Math.hypot(px - qx, py - qy, pz - qz);
}

// mesh: { positions: Float64Array, indices: Uint32Array } in meters; cell_m: target grid cell.
// Returns { sdf, cell_m, counts, nodes } where sdf(x, y, z) is negative inside.
export function buildMeshField(mesh, bounds_m, cell_m) {
  const size = bounds_m.max.map((hi, a) => hi - bounds_m.min[a]);
  let h = cell_m;
  const nodeCount = (hh) => size.reduce((product, len) => product * (Math.ceil(len / hh) + 2 * MARGIN_CELLS + 1), 1);
  while (nodeCount(h) > MAX_NODES) h *= 1.1;
  const counts = size.map((len) => Math.ceil(len / h) + 2 * MARGIN_CELLS);
  const origin = bounds_m.min.map((lo) => lo - MARGIN_CELLS * h);
  const [nx, ny, nz] = counts;
  const sy = nx + 1;
  const sz = sy * (ny + 1);
  const band_m = BAND_CELLS * h;
  const distance = new Float32Array((nx + 1) * (ny + 1) * (nz + 1)).fill(band_m);
  const { positions, indices } = mesh;
  const triangleCount = indices.length / 3;
  const vertex = (v) => [positions[3 * v], positions[3 * v + 1], positions[3 * v + 2]];

  // exact distances in the band
  for (let t = 0; t < triangleCount; t++) {
    const a = vertex(indices[3 * t]);
    const b = vertex(indices[3 * t + 1]);
    const c = vertex(indices[3 * t + 2]);
    const lo = [0, 1, 2].map((k) => Math.max(0, Math.ceil((Math.min(a[k], b[k], c[k]) - band_m - origin[k]) / h)));
    const hi = [0, 1, 2].map((k) => Math.min(counts[k], Math.floor((Math.max(a[k], b[k], c[k]) + band_m - origin[k]) / h)));
    for (let k = lo[2]; k <= hi[2]; k++) {
      const z = origin[2] + k * h;
      for (let j = lo[1]; j <= hi[1]; j++) {
        const y = origin[1] + j * h;
        for (let i = lo[0]; i <= hi[0]; i++) {
          const d = distanceToTriangle(origin[0] + i * h, y, z, a, b, c);
          const n = k * sz + j * sy + i;
          if (d < distance[n]) distance[n] = d;
        }
      }
    }
  }

  // parity of crossings along x for every (j, k) column
  const columns = (ny + 1) * (nz + 1);
  const crossingCount = new Uint32Array(columns + 1);
  const rayY = (j) => origin[1] + (j + RAY_OFFSET[0]) * h;
  const rayZ = (k) => origin[2] + (k + RAY_OFFSET[1]) * h;
  const forEachCrossing = (visit) => {
    for (let t = 0; t < triangleCount; t++) {
      const a = vertex(indices[3 * t]);
      const b = vertex(indices[3 * t + 1]);
      const c = vertex(indices[3 * t + 2]);
      const area = (b[1] - a[1]) * (c[2] - a[2]) - (c[1] - a[1]) * (b[2] - a[2]);
      if (Math.abs(area) < 1e-300) continue;
      const jLo = Math.max(0, Math.ceil((Math.min(a[1], b[1], c[1]) - origin[1]) / h - RAY_OFFSET[0]));
      const jHi = Math.min(ny, Math.floor((Math.max(a[1], b[1], c[1]) - origin[1]) / h - RAY_OFFSET[0]));
      const kLo = Math.max(0, Math.ceil((Math.min(a[2], b[2], c[2]) - origin[2]) / h - RAY_OFFSET[1]));
      const kHi = Math.min(nz, Math.floor((Math.max(a[2], b[2], c[2]) - origin[2]) / h - RAY_OFFSET[1]));
      for (let k = kLo; k <= kHi; k++) {
        const z = rayZ(k);
        for (let j = jLo; j <= jHi; j++) {
          const y = rayY(j);
          const wb = ((y - a[1]) * (c[2] - a[2]) - (c[1] - a[1]) * (z - a[2])) / area;
          const wc = ((b[1] - a[1]) * (z - a[2]) - (y - a[1]) * (b[2] - a[2])) / area;
          if (wb < 0 || wc < 0 || wb + wc > 1) continue;
          visit(k * (ny + 1) + j, a[0] + wb * (b[0] - a[0]) + wc * (c[0] - a[0]));
        }
      }
    }
  };
  forEachCrossing((column) => {
    crossingCount[column + 1]++;
  });
  for (let column = 0; column < columns; column++) crossingCount[column + 1] += crossingCount[column];
  const crossings = new Float64Array(crossingCount[columns]);
  const filled = new Uint32Array(columns);
  forEachCrossing((column, x) => {
    crossings[crossingCount[column] + filled[column]++] = x;
  });
  for (let column = 0; column < columns; column++) {
    const from = crossingCount[column];
    const to = crossingCount[column + 1];
    const xs = crossings.subarray(from, to).sort();
    const k = Math.floor(column / (ny + 1));
    const j = column % (ny + 1);
    let passed = 0;
    for (let i = 0; i <= nx; i++) {
      const x = origin[0] + i * h;
      while (passed < xs.length && xs[passed] < x) passed++;
      if (passed % 2 === 1) distance[k * sz + j * sy + i] = -distance[k * sz + j * sy + i];
    }
  }

  const far = (nx + 1) * h;
  const sdf = (x, y, z) => {
    const fx = (x - origin[0]) / h;
    const fy = (y - origin[1]) / h;
    const fz = (z - origin[2]) / h;
    if (fx < 0 || fy < 0 || fz < 0 || fx >= nx || fy >= ny || fz >= nz) return far;
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const k = Math.floor(fz);
    const u = fx - i;
    const v = fy - j;
    const w = fz - k;
    const n = k * sz + j * sy + i;
    const d00 = distance[n] * (1 - u) + distance[n + 1] * u;
    const d10 = distance[n + sy] * (1 - u) + distance[n + sy + 1] * u;
    const d01 = distance[n + sz] * (1 - u) + distance[n + sz + 1] * u;
    const d11 = distance[n + sz + sy] * (1 - u) + distance[n + sz + sy + 1] * u;
    return (d00 * (1 - v) + d10 * v) * (1 - w) + (d01 * (1 - v) + d11 * v) * w;
  };
  return { sdf, cell_m: h, counts, nodes: distance.length };
}
