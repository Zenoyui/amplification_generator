// Ray against a signed distance field by sphere tracing

// Step is the distance scaled by this factor: round union fields are not strictly 1-Lipschitz
const STEP_SCALE = 0.7;
const MAX_STEPS = 600;

// Returns { point, distance } of the first surface hit along the ray, or null
export function traceRay(sdf, origin, direction, maxDistance_m, tolerance_m) {
  let travelled = 0;
  for (let step = 0; step < MAX_STEPS && travelled < maxDistance_m; step++) {
    const x = origin[0] + direction[0] * travelled;
    const y = origin[1] + direction[1] * travelled;
    const z = origin[2] + direction[2] * travelled;
    const d = sdf(x, y, z);
    if (d < tolerance_m) return { point: [x, y, z], distance: travelled };
    travelled += Math.max(d * STEP_SCALE, tolerance_m * 0.5);
  }
  return null;
}
