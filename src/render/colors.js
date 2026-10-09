// Vertex colors of a surface from a nodal scalar field

import { rampColor } from '../ui/tokens.js';
import { sampleNodal } from './field.js';

// positions: Float32Array (3 per vertex). nodal: { grid, scalars, present }. range: [low, high].
// reversed puts low values at the hot end of the ramp. missing: rgb for vertices without data.
export function fieldColors(positions, nodal, range, reversed, missing) {
  const count = positions.length / 3;
  const colors = new Float32Array(count * 3);
  const out = new Float64Array(1);
  const point = [0, 0, 0];
  for (let v = 0; v < count; v++) {
    point[0] = positions[3 * v];
    point[1] = positions[3 * v + 1];
    point[2] = positions[3 * v + 2];
    if (!sampleNodal(nodal.grid, nodal.scalars, 1, nodal.present, point, out)) {
      colors.set(missing, 3 * v);
      continue;
    }
    let t = (out[0] - range[0]) / (range[1] - range[0]);
    if (reversed) t = 1 - t;
    colors.set(rampColor(t), 3 * v);
  }
  return colors;
}
