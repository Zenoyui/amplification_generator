// Offscreen renders of the result for the document

import { Renderer, arrowGeometry } from '../render/gl.js';
import { Camera, STANDARD_VIEWS } from '../render/camera.js';
import { fieldColors } from '../render/colors.js';
import { COLORS, hexToRgb } from '../ui/tokens.js';
import { resultField } from './fields.js';

export const FIGURE_PIXELS = [2400, 1426];
// Margin around the drawn model as a fraction of its larger side, and legend strip height as a fraction of the width
const CROP_MARGIN = 0.04;
const LEGEND_STRIP = 0.085;

// Bounding box of pixels that differ from the corner pixel
function contentBox(rgba, width, height) {
  const same = (i) => rgba[i] === rgba[0] && rgba[i + 1] === rgba[1] && rgba[i + 2] === rgba[2];
  let x0 = width;
  let x1 = -1;
  let y0 = height;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (same(4 * (y * width + x))) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return { x0: 0, y0: 0, x1: width - 1, y1: height - 1 };
  const margin = Math.round(CROP_MARGIN * Math.max(x1 - x0, y1 - y0));
  return { x0: Math.max(0, x0 - margin), y0: Math.max(0, y0 - margin), x1: Math.min(width - 1, x1 + margin), y1: Math.min(height - 1, y1 + margin) };
}

// RGB bytes of the box with a strip of the background color added below
function cropRgb(rgba, width, box) {
  const w = box.x1 - box.x0 + 1;
  const h = box.y1 - box.y0 + 1;
  const strip = Math.round(LEGEND_STRIP * w);
  const rgb = new Uint8Array(w * (h + strip) * 3);
  for (let i = 0; i < rgb.length; i += 3) {
    rgb[i] = rgba[0];
    rgb[i + 1] = rgba[1];
    rgb[i + 2] = rgba[2];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const from = 4 * ((box.y0 + y) * width + box.x0 + x);
      const to = 3 * (y * w + x);
      rgb[to] = rgba[from];
      rgb[to + 1] = rgba[from + 1];
      rgb[to + 2] = rgba[from + 2];
    }
  }
  return { rgb, width: w, height: h + strip };
}

// Renders the three result fields. display: worker display mesh; record: result record; load: resolved load.
// Returns [{ mode, rgb, width, height, range, reversed, title, unit }]
export function renderFigures(display, record, load, modes) {
  const canvas = document.createElement('canvas');
  canvas.width = FIGURE_PIXELS[0];
  canvas.height = FIGURE_PIXELS[1];
  const renderer = new Renderer(canvas);
  const camera = new Camera();
  camera.fit(display.bounds_m);
  camera.setView(STANDARD_VIEWS.home.forward, STANDARD_VIEWS.home.up);
  renderer.setEdges(display.edges);
  const length_m = camera.sceneRadius * 0.45;
  const arrow = arrowGeometry(load.point_m, load.direction, length_m, length_m * 0.09);
  const red = hexToRgb(COLORS.load);
  const arrowColors = new Float32Array(arrow.positions.length);
  for (let i = 0; i < arrowColors.length; i += 3) arrowColors.set(red, i);
  renderer.setOverlay(arrow.positions, arrow.normals, arrowColors);
  const figures = [];
  let box = null;
  const gray = hexToRgb(COLORS.model);
  for (const mode of modes) {
    const field = resultField(record, mode);
    renderer.setSurface(display.positions, display.normals, fieldColors(display.positions, field.nodal, field.range, field.reversed, gray));
    renderer.draw(camera);
    const { width, height, rgba } = renderer.readPixels();
    box ??= contentBox(rgba, width, height);
    const cropped = cropRgb(rgba, width, box);
    figures.push({ mode, rgb: cropped.rgb, width: cropped.width, height: cropped.height, range: field.range, reversed: field.reversed, title: field.title, unit: field.unit });
  }
  renderer.gl.getExtension('WEBGL_lose_context')?.loseContext();
  return figures;
}
