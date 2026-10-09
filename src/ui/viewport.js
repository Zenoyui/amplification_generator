// 3D viewport: renderer, camera with Fusion navigation, view cube, load marker, picking, result coloring

import { Renderer, arrowGeometry } from '../render/gl.js';
import { Camera, STANDARD_VIEWS } from '../render/camera.js';
import { ViewCube } from '../render/viewcube.js';
import { fieldColors } from '../render/colors.js';
import { COLORS, FIELD_RAMP, hexToRgb } from './tokens.js';
import { traceRay } from '../geometry/pick.js';
import { gradientNormal } from '../geometry/sdf.js';
import { el } from './dom.js';
import { TEXT } from './text.js';

// Click drift above this many pixels is a drag, not a pick
const CLICK_DRIFT_PX = 4;
// Two middle clicks within this many ms fit the view
const DOUBLE_CLICK_MS = 350;
const PICK_TOLERANCE_RATIO = 1e-4;
const NORMAL_STEP_M = 1e-5;

export class Viewport {
  constructor(container, onPick) {
    this.container = container;
    this.onPick = onPick;
    this.canvas = el('canvas', { class: 'scene', tabindex: '0', 'aria-label': 'Трехмерная модель' });
    container.append(this.canvas);
    this.renderer = new Renderer(this.canvas);
    this.camera = new Camera();
    this.cubeCanvas = el('canvas', { class: 'cube', 'aria-label': 'Куб видов' });
    container.append(this.cubeCanvas);
    this.cube = new ViewCube(this.cubeCanvas, this.camera, (action) => this.#cubeAction(action));
    this.#buildToolbar();
    container.append(el('div', { class: 'navhint' }, TEXT.hint));
    this.legend = el('div', { class: 'legend', hidden: true });
    container.append(this.legend);
    this.display = null;
    this.model = null;
    this.pickMode = false;
    this.marker = null;
    this.field = null;
    this.drag = null;
    this.lastMiddleClick = 0;
    this.pointers = new Map();
    this.#bind();
    new ResizeObserver(() => this.redraw()).observe(container);
    this.redraw();
  }

  #buildToolbar() {
    const toolbar = el('div', { class: 'toolbar' });
    this.fitButton = el('button', { type: 'button', onclick: () => this.fit() }, TEXT.buttons.fit);
    this.orbitButton = el('button', { type: 'button', onclick: () => this.#toggleOrbit() }, TEXT.buttons.orbitConstrained);
    toolbar.append(this.fitButton, this.orbitButton);
    this.container.append(toolbar);
  }

  #toggleOrbit() {
    this.camera.constrained = !this.camera.constrained;
    this.orbitButton.textContent = this.camera.constrained ? TEXT.buttons.orbitConstrained : TEXT.buttons.orbitFree;
  }

  #cubeAction(action) {
    if (action === 'home') this.home();
    else this.redraw();
  }

  home() {
    if (this.display) this.camera.fit(this.display.bounds_m);
    this.camera.snapTo(STANDARD_VIEWS.home.forward, STANDARD_VIEWS.home.up, performance.now() / 1000);
    this.redraw();
  }

  fit() {
    if (this.display) this.camera.fit(this.display.bounds_m);
    this.redraw();
  }

  #ndc(e) {
    const rect = this.canvas.getBoundingClientRect();
    return [((e.clientX - rect.left) / rect.width) * 2 - 1, 1 - ((e.clientY - rect.top) / rect.height) * 2, rect];
  }

  #bind() {
    const canvas = this.canvas;
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [x, y, rect] = this.#ndc(e);
      const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
      this.camera.zoomAt(this.camera.wheelFactor(e.deltaY * unit), [x, y], rect.width / rect.height);
      this.redraw();
    }, { passive: false });
    canvas.addEventListener('pointerdown', (e) => this.#down(e));
    canvas.addEventListener('pointermove', (e) => this.#move(e));
    canvas.addEventListener('pointerup', (e) => this.#up(e));
    canvas.addEventListener('pointercancel', (e) => this.pointers.delete(e.pointerId));
    window.addEventListener('keydown', (e) => {
      if (e.key === 'F6') {
        e.preventDefault();
        this.fit();
      }
    });
  }

  #down(e) {
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.focus();
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (e.button === 1) e.preventDefault();
    this.drag = { button: e.button, x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, moved: false, touch: e.pointerType === 'touch' };
    if (this.pointers.size === 2) this.drag.pinch = this.#pinchState();
  }

  #pinchState() {
    const [a, b] = [...this.pointers.values()];
    return { distance: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  }

  #move(e) {
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const drag = this.drag;
    if (!drag) return;
    const rect = this.canvas.getBoundingClientRect();
    if (this.pointers.size >= 2 && drag.pinch) {
      const now = this.#pinchState();
      this.camera.zoomAt(drag.pinch.distance / Math.max(1, now.distance), [((now.cx - rect.left) / rect.width) * 2 - 1, 1 - ((now.cy - rect.top) / rect.height) * 2], rect.width / rect.height);
      this.camera.pan(now.cx - drag.pinch.cx, now.cy - drag.pinch.cy, rect.height);
      drag.pinch = now;
      drag.moved = true;
      this.redraw();
      return;
    }
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > CLICK_DRIFT_PX) drag.moved = true;
    if (!drag.moved) return;
    // Fusion: middle drag = pan, Shift + middle = orbit, Ctrl + Shift + middle = zoom.
    // Added for devices without a middle button: Shift + left = orbit, Ctrl + left = pan, one finger = orbit.
    const middle = drag.button === 1;
    const left = drag.button === 0;
    if (middle && e.shiftKey && e.ctrlKey) {
      this.camera.zoomAt(this.camera.dragZoomFactor(dy), [0, 0], rect.width / rect.height);
    } else if ((middle && e.shiftKey) || (left && e.shiftKey) || (left && drag.touch)) {
      this.camera.orbit(dx, dy, rect.height);
    } else if (middle || (left && e.ctrlKey)) {
      this.camera.pan(dx, dy, rect.height);
    }
    this.redraw();
  }

  #up(e) {
    const drag = this.drag;
    this.pointers.delete(e.pointerId);
    this.drag = this.pointers.size > 0 ? this.drag : null;
    if (!drag || drag.moved) return;
    if (drag.button === 1) {
      const now = performance.now();
      if (now - this.lastMiddleClick < DOUBLE_CLICK_MS) this.fit();
      this.lastMiddleClick = now;
      return;
    }
    if (drag.button === 0 && this.pickMode && this.model) this.#pick(e);
  }

  #pick(e) {
    const [x, y, rect] = this.#ndc(e);
    const ray = this.camera.ray([x, y], rect.width / rect.height);
    const hit = traceRay(this.model.sdf, ray.origin, ray.direction, this.camera.distance + 4 * this.camera.sceneRadius, PICK_TOLERANCE_RATIO * this.camera.sceneRadius);
    if (!hit) return;
    this.onPick({ point_m: hit.point, outwardNormal: gradientNormal(this.model.sdf, hit.point, NORMAL_STEP_M) });
  }

  setPickMode(active) {
    this.pickMode = active;
    this.canvas.style.cursor = active ? 'crosshair' : 'default';
  }

  setModel(model) {
    this.model = model;
  }

  // display: worker result { positions, normals, flags, edges, bounds_m }
  setDisplay(display, keepCamera) {
    this.display = display;
    this.renderer.setSurface(display.positions, display.normals, this.#baseColors(display));
    this.renderer.setEdges(display.edges);
    this.field = null;
    this.legend.hidden = true;
    if (!keepCamera) {
      this.camera.fit(display.bounds_m);
      this.camera.setView(STANDARD_VIEWS.home.forward, STANDARD_VIEWS.home.up);
    }
    this.redraw();
  }

  #baseColors(display) {
    const count = display.positions.length / 3;
    const colors = new Float32Array(count * 3);
    const model = hexToRgb(COLORS.model);
    const reinforcement = hexToRgb(COLORS.reinforcement);
    const support = hexToRgb(COLORS.support);
    for (let v = 0; v < count; v++) {
      const flag = display.flags[v];
      const color = flag & 2 ? support : flag & 1 ? reinforcement : model;
      colors.set(color, 3 * v);
    }
    return colors;
  }

  clearField() {
    if (!this.display) return;
    this.renderer.setColors(this.#baseColors(this.display));
    this.field = null;
    this.legend.hidden = true;
    this.redraw();
  }

  // Colors the surface by a nodal scalar. nodal: { scalars (Float32 per node), present (Uint8 per node), grid }.
  // range: [low, high]; reversed puts low values in the hot color (safety factor).
  showField(nodal, range, reversed, title, unit) {
    this.renderer.setColors(fieldColors(this.display.positions, nodal, range, reversed, hexToRgb(COLORS.model)));
    this.field = { range, reversed, title, unit };
    this.#drawLegend();
    this.redraw();
  }

  #drawLegend() {
    const { range, reversed, title, unit } = this.field;
    const stops = reversed ? [...FIELD_RAMP].reverse() : FIELD_RAMP;
    this.legend.hidden = false;
    this.legend.replaceChildren();
    const colorBar = el('div', { class: 'bar' });
    colorBar.style.background = `linear-gradient(to right, ${stops.join(', ')})`;
    const format = (level) => level.toLocaleString('ru-RU', { maximumFractionDigits: 3, maximumSignificantDigits: 3 });
    this.legend.append(el('div', {}, `${title}, ${unit}`), colorBar, el('div', { class: 'scale' }, el('span', {}, format(range[0])), el('span', {}, format(range[1]))));
  }

  // load marker: point, outward normal, force direction; null clears
  setLoadMarker(load) {
    if (!load || !this.display) {
      this.renderer.setOverlay(new Float32Array(0), new Float32Array(0), new Float32Array(0));
      this.redraw();
      return;
    }
    const length_m = this.camera.sceneRadius * 0.45;
    const arrow = arrowGeometry(load.point_m, load.direction, length_m, length_m * 0.09);
    const colors = new Float32Array(arrow.positions.length);
    const red = hexToRgb(COLORS.load);
    for (let i = 0; i < colors.length; i += 3) colors.set(red, i);
    this.renderer.setOverlay(arrow.positions, arrow.normals, colors);
    this.redraw();
  }

  redraw() {
    if (this.frame) return;
    this.frame = requestAnimationFrame((time) => {
      this.frame = null;
      const rect = this.container.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      this.renderer.resize(Math.max(1, Math.floor(rect.width * ratio)), Math.max(1, Math.floor(rect.height * ratio)));
      const running = this.camera.update(time / 1000);
      this.renderer.draw(this.camera);
      this.cube.draw();
      if (running) this.redraw();
    });
  }
}
