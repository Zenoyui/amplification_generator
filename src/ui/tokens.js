// Closed list of visual design tokens. styles/tokens.css repeats the same values.

export const COLORS = Object.freeze({
  paper: '#FFFFFF',
  panel: '#F2F2F2',
  rule: '#BFBFBF',
  ink: '#1E1E1E',
  inkMuted: '#595959',
  accent: '#2F5496',
  accentDark: '#1F3864',
  ok: '#2E7D32',
  warn: '#9C5700',
  fail: '#C00000',
  model: '#B0B0B0',
  modelEdge: '#404040',
  reinforcement: '#C55A11',
  support: '#2F5496',
  load: '#C00000',
  print: '#000000',
});

export const FONT_FAMILY = 'Arial, "Liberation Sans", Helvetica, sans-serif';

// Nine-stop ramp for result fields, low to high
export const FIELD_RAMP = Object.freeze(['#313695', '#4575B4', '#74ADD1', '#ABD9E9', '#FFFFBF', '#FEE090', '#FDAE61', '#F46D43', '#A50026']);

export const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

const RAMP_RGB = FIELD_RAMP.map(hexToRgb);

// Color of the ramp at t in [0, 1]
export function rampColor(t) {
  const clamped = Math.min(1, Math.max(0, t));
  const position = clamped * (RAMP_RGB.length - 1);
  const lo = Math.min(RAMP_RGB.length - 2, Math.floor(position));
  const f = position - lo;
  return RAMP_RGB[lo].map((c, k) => c + (RAMP_RGB[lo + 1][k] - c) * f);
}
