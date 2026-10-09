// Scalar fields of a result for display: scalars per node, color range, legend text

import { TEXT } from '../ui/text.js';

const MM = 1000;
const MPA = 1e6;
// Safety factor scale ends at this multiple of the required value (at least SAFETY_SCALE_FLOOR)
const SAFETY_SCALE_FLOOR = 3;

// mode: 'mises' | 'displacement' | 'safety'. record: { analysis, summary, required }
export function resultField(record, mode) {
  const { solve } = record.analysis;
  const nodes = solve.nodes;
  const nodeCount = nodes.count.length;
  const grid = solve.grid;
  const primary = record.summary.primaryId;
  if (mode === 'displacement') {
    const scalars = new Float32Array(nodeCount);
    let peak = 0;
    for (let n = 0; n < nodeCount; n++) {
      scalars[n] = Math.hypot(nodes.displacement_m[3 * n], nodes.displacement_m[3 * n + 1], nodes.displacement_m[3 * n + 2]) * MM;
      if (nodes.count[n] > 0 && scalars[n] > peak) peak = scalars[n];
    }
    return { nodal: { grid, scalars, present: nodes.count }, range: [0, peak], reversed: false, title: TEXT.result.modes.displacement, unit: 'мм' };
  }
  if (mode === 'safety') {
    const limit = Math.max(2 * record.required, SAFETY_SCALE_FLOOR);
    return {
      nodal: { grid, scalars: nodes.safety[primary], present: nodes.count },
      range: [0, limit],
      reversed: true,
      title: `${TEXT.result.modes.safety} (теория ${primary})`,
      unit: '',
    };
  }
  const scalars = new Float32Array(nodeCount);
  for (let n = 0; n < nodeCount; n++) scalars[n] = nodes.mises_pa[n] / MPA;
  const peak = record.summary.theories.find((t) => t.id === 'IV').peak_mpa;
  return { nodal: { grid, scalars, present: nodes.count }, range: [0, peak], reversed: false, title: `${TEXT.result.modes.mises} (теория IV)`, unit: 'МПа' };
}
