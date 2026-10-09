// Camera with the navigation scheme of Autodesk Fusion (default preset):
//   pan = middle button drag, orbit = Shift + middle button drag, zoom = wheel (toward cursor) or Ctrl + Shift + middle drag,
//   fit = double middle click or F6, ViewCube click = standard views.
// World axes: X right, Y into the screen at the front view, Z up. State: target point, distance, orientation.

import { add, cross, dot, length, normalize, scale, sub } from '../math/vec3.js';

const FIELD_OF_VIEW_RAD = (30 * Math.PI) / 180;
// Orbit speed: full turn per this many viewport heights
const TURN_PER_HEIGHTS = 1;
// Zoom factor per wheel pixel (deltaY in pixels)
const WHEEL_ZOOM = 0.0015;
// Zoom factor per pixel of a Ctrl + Shift + middle drag
const DRAG_ZOOM = 0.005;
const MIN_DISTANCE_RATIO = 0.02;
const MAX_DISTANCE_RATIO = 60;
// Constrained orbit keeps the camera at least this far (rad) from the poles
const POLE_MARGIN_RAD = 0.002;
// Standard view change duration, seconds (design token view-snap)
export const SNAP_SECONDS = 0.35;
// Fit margin factor on the bounding sphere
const FIT_MARGIN = 1.15;

// Orientation as camera axes in world coordinates
function axesFromDirection(viewDirection, upHint) {
  const forward = normalize(viewDirection);
  let right = cross(forward, upHint);
  if (length(right) < 1e-6) right = cross(forward, [0, 1, 0]);
  right = normalize(right);
  const up = normalize(cross(right, forward));
  return { right, up, forward };
}

// Standard views: direction the camera looks along, and its up vector (Z up; top and bottom use Y)
export const STANDARD_VIEWS = {
  front: { forward: [0, 1, 0], up: [0, 0, 1] },
  back: { forward: [0, -1, 0], up: [0, 0, 1] },
  right: { forward: [-1, 0, 0], up: [0, 0, 1] },
  left: { forward: [1, 0, 0], up: [0, 0, 1] },
  top: { forward: [0, 0, -1], up: [0, 1, 0] },
  bottom: { forward: [0, 0, 1], up: [0, -1, 0] },
  home: { forward: normalize([-1, 1, -0.8]), up: [0, 0, 1] },
};

export class Camera {
  constructor() {
    this.target = [0, 0, 0];
    this.distance = 1;
    this.axes = axesFromDirection(STANDARD_VIEWS.home.forward, [0, 0, 1]);
    this.constrained = true;
    this.sceneRadius = 1;
    this.animation = null;
  }

  position() {
    return sub(this.target, scale(this.axes.forward, this.distance));
  }

  // Half extent of the view at the target distance
  halfHeight() {
    return this.distance * Math.tan(FIELD_OF_VIEW_RAD / 2);
  }

  fit(bounds_m) {
    const center = bounds_m.min.map((lo, a) => (lo + bounds_m.max[a]) / 2);
    const radius = 0.5 * length(bounds_m.max.map((hi, a) => hi - bounds_m.min[a]));
    this.sceneRadius = radius;
    this.target = center;
    this.distance = (FIT_MARGIN * radius) / Math.sin(FIELD_OF_VIEW_RAD / 2);
  }

  // pixels dx, dy (screen right, down) on a viewport of height heightPx
  orbit(dx, dy, heightPx) {
    const angle = (2 * Math.PI) / (TURN_PER_HEIGHTS * heightPx);
    const yaw = -dx * angle;
    const pitch = -dy * angle;
    const { right, up, forward } = this.axes;
    const axis = this.constrained ? [0, 0, 1] : up;
    const r1 = rotate(right, axis, yaw);
    const u1 = rotate(up, axis, yaw);
    const f1 = rotate(forward, axis, yaw);
    // pitch about the new camera right axis
    const pitched = {
      up: rotate(u1, r1, pitch),
      forward: rotate(f1, r1, pitch),
    };
    if (this.constrained) {
      // keep up.z non-negative: limit elevation of the view direction
      const elevation = Math.asin(Math.max(-1, Math.min(1, pitched.forward[2])));
      const limit = Math.PI / 2 - POLE_MARGIN_RAD;
      if (Math.abs(elevation) > limit) {
        const clamped = Math.sign(elevation) * limit;
        const horizontal = normalize([f1[0], f1[1], 0]);
        const forwardClamped = normalize([horizontal[0] * Math.cos(clamped), horizontal[1] * Math.cos(clamped), Math.sin(clamped)]);
        this.axes = axesFromDirection(forwardClamped, [0, 0, 1]);
        return;
      }
      this.axes = axesFromDirection(pitched.forward, [0, 0, 1]);
      return;
    }
    this.axes = reorthogonalize(r1, pitched.up, pitched.forward);
  }

  pan(dx, dy, heightPx) {
    const perPixel = (2 * this.halfHeight()) / heightPx;
    this.target = add(this.target, add(scale(this.axes.right, -dx * perPixel), scale(this.axes.up, dy * perPixel)));
  }

  // Dolly by factor (>1 moves away). Cursor in normalized device coordinates ([-1, 1], y up); keeps the point
  // under the cursor fixed on screen.
  zoomAt(factor, cursorNdc, aspect) {
    const clamped = Math.min(MAX_DISTANCE_RATIO * this.sceneRadius, Math.max(MIN_DISTANCE_RATIO * this.sceneRadius, this.distance * factor));
    const s = clamped / this.distance;
    const half = this.halfHeight();
    const point = add(this.target, add(scale(this.axes.right, cursorNdc[0] * half * aspect), scale(this.axes.up, cursorNdc[1] * half)));
    this.target = add(point, scale(sub(this.target, point), s));
    this.distance = clamped;
  }

  wheelFactor(deltaY) {
    return Math.exp(deltaY * WHEEL_ZOOM);
  }

  dragZoomFactor(dy) {
    return Math.exp(dy * DRAG_ZOOM);
  }

  // Immediate change of orientation
  setView(forward, up) {
    this.axes = axesFromDirection(forward, up);
    this.animation = null;
  }

  // Animated change to a standard view or direction; fit keeps target and distance
  snapTo(forward, up, now_s) {
    this.animation = { from: this.axes, to: axesFromDirection(forward, up), start: now_s };
  }

  // Advances the animation; returns true while it runs
  update(now_s) {
    if (!this.animation) return false;
    const { from, to, start } = this.animation;
    const raw = Math.min(1, (now_s - start) / SNAP_SECONDS);
    const eased = raw < 0.5 ? 2 * raw * raw : 1 - (-2 * raw + 2) ** 2 / 2;
    const forward = slerp(from.forward, to.forward, eased);
    const upMix = slerp(from.up, to.up, eased);
    this.axes = axesFromDirection(forward, upMix);
    if (raw >= 1) {
      this.axes = to;
      this.animation = null;
      return false;
    }
    return true;
  }

  viewMatrix() {
    const { right, up, forward } = this.axes;
    const eye = this.position();
    // column-major
    return Float64Array.from([
      right[0], up[0], -forward[0], 0,
      right[1], up[1], -forward[1], 0,
      right[2], up[2], -forward[2], 0,
      -dot(right, eye), -dot(up, eye), dot(forward, eye), 1,
    ]);
  }

  projectionMatrix(aspect) {
    const near = Math.max(this.distance - this.sceneRadius * 2, this.distance * 0.01, 1e-6);
    const far = this.distance + this.sceneRadius * 3;
    const f = 1 / Math.tan(FIELD_OF_VIEW_RAD / 2);
    return Float64Array.from([
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) / (near - far), -1,
      0, 0, (2 * far * near) / (near - far), 0,
    ]);
  }

  // World-space ray through cursor (ndc, y up): { origin, direction }
  ray(cursorNdc, aspect) {
    const half = Math.tan(FIELD_OF_VIEW_RAD / 2);
    const direction = normalize(
      add(this.axes.forward, add(scale(this.axes.right, cursorNdc[0] * half * aspect), scale(this.axes.up, cursorNdc[1] * half))),
    );
    return { origin: this.position(), direction };
  }
}

function rotate(v, axisUnit, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = cross(axisUnit, v);
  const d = dot(axisUnit, v) * (1 - c);
  return [
    v[0] * c + k[0] * s + axisUnit[0] * d,
    v[1] * c + k[1] * s + axisUnit[1] * d,
    v[2] * c + k[2] * s + axisUnit[2] * d,
  ];
}

function reorthogonalize(right, up, forward) {
  const f = normalize(forward);
  const r = normalize(cross(f, up));
  const u = normalize(cross(r, f));
  return { right: r, up: u, forward: f };
}

// Spherical interpolation of unit vectors; falls back to a linear mix near opposite vectors
function slerp(a, b, t) {
  const d = Math.max(-1, Math.min(1, dot(a, b)));
  const omega = Math.acos(d);
  if (omega < 1e-6) return normalize(add(scale(a, 1 - t), scale(b, t)));
  if (Math.abs(Math.PI - omega) < 1e-3) {
    // opposite: rotate about an axis perpendicular to a
    const axis = normalize(cross(a, Math.abs(a[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]));
    return rotate(a, axis, Math.PI * t);
  }
  const s = Math.sin(omega);
  return add(scale(a, Math.sin((1 - t) * omega) / s), scale(b, Math.sin(t * omega) / s));
}
