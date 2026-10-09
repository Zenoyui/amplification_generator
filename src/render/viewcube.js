// ViewCube: a small cube that shows the camera orientation. Click on a face, edge or corner sets a standard view,
// drag rotates the camera, the home button returns to the home view (behavior of the Fusion ViewCube).

import { COLORS, FONT_FAMILY } from '../ui/tokens.js';
import { add, dot, normalize, scale } from '../math/vec3.js';

const FACES = [
  { id: 'right', label: 'СПРАВА', normal: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
  { id: 'left', label: 'СЛЕВА', normal: [-1, 0, 0], u: [0, -1, 0], v: [0, 0, 1] },
  { id: 'back', label: 'СЗАДИ', normal: [0, 1, 0], u: [-1, 0, 0], v: [0, 0, 1] },
  { id: 'front', label: 'СПЕРЕДИ', normal: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { id: 'top', label: 'ВЕРХ', normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { id: 'bottom', label: 'НИЗ', normal: [0, 0, -1], u: [1, 0, 0], v: [0, -1, 0] },
];
// Face coordinates beyond this value (of 1) belong to an edge or corner zone
const ZONE_LIMIT = 0.55;
const SIZE_PX = 132;
const CUBE_SCALE = 0.26;

// Screen position of world point p: x right, y down, in canvas pixels
function toScreen(axes, p) {
  return [SIZE_PX / 2 + dot(p, axes.right) * SIZE_PX * CUBE_SCALE, SIZE_PX / 2 - dot(p, axes.up) * SIZE_PX * CUBE_SCALE];
}

// Corner positions of a face in world space, order matching (u, v) = (-1,-1), (1,-1), (1,1), (-1,1)
function faceCorners(face) {
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => add(face.normal, add(scale(face.u, a), scale(face.v, b))));
}

// Zone hit at canvas point (x, y) for camera axes, or null. Returns { face, direction } where direction is the
// vector from the cube center to the zone (the camera goes there).
function hitTest(axes, x, y) {
  const visible = FACES.filter((f) => -dot(f.normal, axes.forward) > 1e-6).sort((a, b) => dot(a.normal, axes.forward) - dot(b.normal, axes.forward));
  for (const face of visible) {
    const corners = faceCorners(face).map((p) => toScreen(axes, p));
    // solve for (a, b) in face coordinates by affine map from corner 0, 1 and 3
    const [c0, c1, , c3] = corners;
    const ex = [(c1[0] - c0[0]) / 2, (c1[1] - c0[1]) / 2];
    const ey = [(c3[0] - c0[0]) / 2, (c3[1] - c0[1]) / 2];
    const det = ex[0] * ey[1] - ex[1] * ey[0];
    if (Math.abs(det) < 1e-9) continue;
    const dx = x - c0[0];
    const dy = y - c0[1];
    const a = (dx * ey[1] - dy * ey[0]) / det - 1;
    const b = (ex[0] * dy - ex[1] * dx) / det - 1;
    if (Math.abs(a) > 1 || Math.abs(b) > 1) continue;
    const su = Math.abs(a) > ZONE_LIMIT ? Math.sign(a) : 0;
    const sv = Math.abs(b) > ZONE_LIMIT ? Math.sign(b) : 0;
    const direction = add(face.normal, add(scale(face.u, su), scale(face.v, sv)));
    return { face, direction: normalize(direction), zone: { a: su, b: sv } };
  }
  return null;
}

export class ViewCube {
  constructor(canvas, camera, onChange) {
    this.canvas = canvas;
    this.camera = camera;
    this.onChange = onChange;
    this.hover = null;
    this.dragging = null;
    this.home = { x: 6, y: 6, size: 22 };
    canvas.width = SIZE_PX * (window.devicePixelRatio || 1);
    canvas.height = SIZE_PX * (window.devicePixelRatio || 1);
    canvas.style.width = `${SIZE_PX}px`;
    canvas.style.height = `${SIZE_PX}px`;
    canvas.addEventListener('pointerdown', (e) => this.#down(e));
    canvas.addEventListener('pointermove', (e) => this.#move(e));
    canvas.addEventListener('pointerup', (e) => this.#up(e));
    canvas.addEventListener('pointerleave', () => {
      this.hover = null;
      this.draw();
    });
  }

  #local(e) {
    const rect = this.canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  #overHome(x, y) {
    const h = this.home;
    return x >= h.x && x <= h.x + h.size && y >= h.y && y <= h.y + h.size;
  }

  #down(e) {
    const [x, y] = this.#local(e);
    this.canvas.setPointerCapture(e.pointerId);
    this.dragging = { x, y, moved: false, startX: x, startY: y };
  }

  #move(e) {
    const [x, y] = this.#local(e);
    if (this.dragging) {
      const dx = x - this.dragging.x;
      const dy = y - this.dragging.y;
      if (Math.hypot(x - this.dragging.startX, y - this.dragging.startY) > 3) this.dragging.moved = true;
      if (this.dragging.moved) {
        this.camera.orbit(dx * 2.2, dy * 2.2, SIZE_PX);
        this.onChange();
      }
      this.dragging.x = x;
      this.dragging.y = y;
      return;
    }
    this.hover = this.#overHome(x, y) ? { home: true } : hitTest(this.camera.axes, x, y);
    this.draw();
  }

  #up(e) {
    const drag = this.dragging;
    this.dragging = null;
    if (!drag || drag.moved) return;
    const [x, y] = this.#local(e);
    if (this.#overHome(x, y)) {
      this.onChange('home');
      return;
    }
    const hit = hitTest(this.camera.axes, x, y);
    if (!hit) return;
    const forward = scale(hit.direction, -1);
    const up = Math.abs(hit.direction[2]) > 0.95 ? [0, hit.direction[2] > 0 ? 1 : -1, 0] : [0, 0, 1];
    this.camera.snapTo(forward, up, performance.now() / 1000);
    this.onChange('snap');
  }

  draw() {
    const ctx = this.canvas.getContext('2d');
    const ratio = window.devicePixelRatio || 1;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, SIZE_PX, SIZE_PX);
    const axes = this.camera.axes;
    const visible = FACES.filter((f) => -dot(f.normal, axes.forward) > 1e-6);
    for (const face of visible) {
      const corners = faceCorners(face).map((p) => toScreen(axes, p));
      ctx.beginPath();
      corners.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      ctx.closePath();
      ctx.fillStyle = COLORS.paper;
      ctx.fill();
      if (this.hover && this.hover.face === face) {
        this.#highlight(ctx, axes, face, this.hover.zone);
      }
      ctx.lineWidth = 1;
      ctx.strokeStyle = COLORS.inkMuted;
      ctx.stroke();
      this.#label(ctx, axes, face);
    }
    this.#drawHome(ctx);
  }

  #highlight(ctx, axes, face, zone) {
    const lo = (s) => (s < 0 ? -1 : s > 0 ? ZONE_LIMIT : -ZONE_LIMIT);
    const hi = (s) => (s < 0 ? -ZONE_LIMIT : s > 0 ? 1 : ZONE_LIMIT);
    const pts = [[lo(zone.a), lo(zone.b)], [hi(zone.a), lo(zone.b)], [hi(zone.a), hi(zone.b)], [lo(zone.a), hi(zone.b)]].map(([a, b]) =>
      toScreen(axes, add(face.normal, add(scale(face.u, a), scale(face.v, b)))),
    );
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
    ctx.fillStyle = COLORS.accent;
    ctx.globalAlpha = 0.35;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  #label(ctx, axes, face) {
    const origin = toScreen(axes, face.normal);
    const ux = toScreen(axes, add(face.normal, face.u));
    const vy = toScreen(axes, add(face.normal, face.v));
    ctx.save();
    const ratio = window.devicePixelRatio || 1;
    ctx.setTransform(ratio * (ux[0] - origin[0]), ratio * (ux[1] - origin[1]), ratio * (origin[0] - vy[0]), ratio * (origin[1] - vy[1]), ratio * origin[0], ratio * origin[1]);
    ctx.fillStyle = COLORS.ink;
    ctx.font = `bold 0.34px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(face.label, 0, 0);
    ctx.restore();
  }

  #drawHome(ctx) {
    const { x, y, size } = this.home;
    ctx.fillStyle = this.hover && this.hover.home ? COLORS.accent : COLORS.paper;
    ctx.strokeStyle = COLORS.inkMuted;
    ctx.lineWidth = 1;
    ctx.fillRect(x, y, size, size);
    ctx.strokeRect(x + 0.5, y + 0.5, size, size);
    ctx.beginPath();
    ctx.moveTo(x + size * 0.2, y + size * 0.52);
    ctx.lineTo(x + size * 0.5, y + size * 0.22);
    ctx.lineTo(x + size * 0.8, y + size * 0.52);
    ctx.moveTo(x + size * 0.3, y + size * 0.48);
    ctx.lineTo(x + size * 0.3, y + size * 0.78);
    ctx.lineTo(x + size * 0.7, y + size * 0.78);
    ctx.lineTo(x + size * 0.7, y + size * 0.48);
    ctx.strokeStyle = this.hover && this.hover.home ? COLORS.paper : COLORS.ink;
    ctx.stroke();
  }
}
