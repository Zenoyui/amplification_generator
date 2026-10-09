// Sampling of nodal fields on the solver grid at arbitrary points

// field: typed array with `stride` values per node; present: Uint8Array, nonzero where the node holds data.
// grid: { counts, cell_m, min_m }. Returns the trilinear blend of present corner nodes, or NaN with no data.
export function sampleNodal(grid, field, stride, present, point_m, out) {
  const [nx, ny, nz] = grid.counts;
  const f = [0, 1, 2].map((a) => (point_m[a] - grid.min_m[a]) / grid.cell_m[a]);
  const cell = [Math.min(nx - 1, Math.max(0, Math.floor(f[0]))), Math.min(ny - 1, Math.max(0, Math.floor(f[1]))), Math.min(nz - 1, Math.max(0, Math.floor(f[2])))];
  const t = [f[0] - cell[0], f[1] - cell[1], f[2] - cell[2]].map((v) => Math.min(1, Math.max(0, v)));
  out.fill(0);
  let total = 0;
  for (let corner = 0; corner < 8; corner++) {
    const i = cell[0] + (corner & 1);
    const j = cell[1] + ((corner >> 1) & 1);
    const k = cell[2] + ((corner >> 2) & 1);
    const node = (k * (ny + 1) + j) * (nx + 1) + i;
    if (!present[node]) continue;
    const w = ((corner & 1) ? t[0] : 1 - t[0]) * (((corner >> 1) & 1) ? t[1] : 1 - t[1]) * (((corner >> 2) & 1) ? t[2] : 1 - t[2]);
    for (let c = 0; c < stride; c++) out[c] += w * field[stride * node + c];
    total += w;
  }
  if (!(total > 0)) {
    out.fill(NaN);
    return false;
  }
  for (let c = 0; c < stride; c++) out[c] /= total;
  return true;
}
