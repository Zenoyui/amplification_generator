// Binary STL writer (little endian, meters converted to millimeters)

const MILLIMETERS_PER_METER = 1000;
const HEADER_BYTES = 80;
const TRIANGLE_BYTES = 50;

// mesh: { positions: Float32Array, indices: Uint32Array }. Returns Uint8Array of the file.
export function binaryStl(mesh, name) {
  const { positions, indices } = mesh;
  const count = indices.length / 3;
  const bytes = new Uint8Array(HEADER_BYTES + 4 + count * TRIANGLE_BYTES);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < Math.min(name.length, HEADER_BYTES - 1); i++) bytes[i] = name.charCodeAt(i) & 0x7f;
  view.setUint32(HEADER_BYTES, count, true);
  let offset = HEADER_BYTES + 4;
  const v = new Float64Array(9);
  for (let t = 0; t < count; t++) {
    for (let c = 0; c < 3; c++) {
      for (let a = 0; a < 3; a++) v[3 * c + a] = positions[3 * indices[3 * t + c] + a] * MILLIMETERS_PER_METER;
    }
    const ux = v[3] - v[0];
    const uy = v[4] - v[1];
    const uz = v[5] - v[2];
    const wx = v[6] - v[0];
    const wy = v[7] - v[1];
    const wz = v[8] - v[2];
    let nx = uy * wz - uz * wy;
    let ny = uz * wx - ux * wz;
    let nz = ux * wy - uy * wx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    view.setFloat32(offset, nx, true);
    view.setFloat32(offset + 4, ny, true);
    view.setFloat32(offset + 8, nz, true);
    for (let k = 0; k < 9; k++) view.setFloat32(offset + 12 + 4 * k, v[k], true);
    view.setUint16(offset + 48, 0, true);
    offset += TRIANGLE_BYTES;
  }
  return bytes;
}
