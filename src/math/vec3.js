// 3-vectors as plain arrays [x, y, z]; used in geometry and UI, not in solver loops

export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a) => Math.hypot(a[0], a[1], a[2]);

// Lengths below this count as the zero vector
const ZERO_LENGTH = 1e-300;

// Unit vector; throws on zero length
export function normalize(a) {
  const len = length(a);
  if (len < ZERO_LENGTH) throw new RangeError('normalize: zero vector');
  return [a[0] / len, a[1] / len, a[2] / len];
}

