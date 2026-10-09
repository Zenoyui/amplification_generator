// WebGL2 renderer: shaded triangle soup with per-vertex colors, feature edge lines, overlay triangles

import { COLORS, hexToRgb } from '../ui/tokens.js';

const SURFACE_VERTEX = `#version 300 es
in vec3 a_position;
in vec3 a_normal;
in vec3 a_color;
uniform mat4 u_view;
uniform mat4 u_projection;
out vec3 v_normal;
out vec3 v_color;
void main() {
  v_normal = mat3(u_view) * a_normal;
  v_color = a_color;
  gl_Position = u_projection * u_view * vec4(a_position, 1.0);
}`;

const SURFACE_FRAGMENT = `#version 300 es
precision highp float;
in vec3 v_normal;
in vec3 v_color;
out vec4 outColor;
void main() {
  vec3 n = normalize(v_normal);
  if (!gl_FrontFacing) n = -n;
  float key = max(dot(n, normalize(vec3(-0.35, 0.55, 0.75))), 0.0);
  float fill = max(dot(n, normalize(vec3(0.6, -0.2, 0.45))), 0.0);
  float shade = 0.55 + 0.45 * key + 0.15 * fill;
  outColor = vec4(v_color * shade, 1.0);
}`;

const LINE_VERTEX = `#version 300 es
in vec3 a_position;
uniform mat4 u_view;
uniform mat4 u_projection;
void main() {
  vec4 p = u_projection * u_view * vec4(a_position, 1.0);
  p.z -= 0.0004 * p.w;
  gl_Position = p;
}`;

const LINE_FRAGMENT = `#version 300 es
precision highp float;
uniform vec3 u_color;
out vec4 outColor;
void main() {
  outColor = vec4(u_color, 1.0);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`shader: compile failed (log=${gl.getShaderInfoLog(shader)})`);
  }
  return shader;
}

function link(gl, vertexSource, fragmentSource) {
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`program: link failed (log=${gl.getProgramInfoLog(program)})`);
  }
  return program;
}

export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: true, preserveDrawingBuffer: true, alpha: false });
    if (!gl) throw new Error('webgl2: context unavailable');
    this.canvas = canvas;
    this.gl = gl;
    this.surface = link(gl, SURFACE_VERTEX, SURFACE_FRAGMENT);
    this.line = link(gl, LINE_VERTEX, LINE_FRAGMENT);
    this.layers = { surface: null, edges: null, overlay: null };
    this.background = hexToRgb(COLORS.paper);
    this.edgeColor = hexToRgb(COLORS.modelEdge);
  }

  // positions, normals, colors: Float32Array, 3 per vertex
  setSurface(positions, normals, colors) {
    this.#release(this.layers.surface);
    this.layers.surface = this.#surfaceBuffers(positions, normals, colors);
  }

  setOverlay(positions, normals, colors) {
    this.#release(this.layers.overlay);
    this.layers.overlay = positions.length ? this.#surfaceBuffers(positions, normals, colors) : null;
  }

  // Replaces vertex colors of the surface layer
  setColors(colors) {
    const layer = this.layers.surface;
    if (!layer) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, layer.color);
    gl.bufferData(gl.ARRAY_BUFFER, colors, gl.DYNAMIC_DRAW);
  }

  setEdges(segments) {
    this.#release(this.layers.edges);
    if (!segments.length) {
      this.layers.edges = null;
      return;
    }
    const gl = this.gl;
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, segments, gl.STATIC_DRAW);
    this.layers.edges = { buffer, count: segments.length / 3 };
  }

  #surfaceBuffers(positions, normals, colors) {
    const gl = this.gl;
    const make = (array, usage) => {
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, array, usage);
      return buffer;
    };
    return {
      position: make(positions, gl.STATIC_DRAW),
      normal: make(normals, gl.STATIC_DRAW),
      color: make(colors, gl.DYNAMIC_DRAW),
      count: positions.length / 3,
    };
  }

  #release(layer) {
    if (!layer) return;
    const gl = this.gl;
    for (const key of ['position', 'normal', 'color', 'buffer']) if (layer[key]) gl.deleteBuffer(layer[key]);
  }

  resize(width, height) {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  draw(camera) {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(...this.background, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    const view = Float32Array.from(camera.viewMatrix());
    const projection = Float32Array.from(camera.projectionMatrix(this.canvas.width / this.canvas.height));
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1, 1);
    for (const layer of [this.layers.surface, this.layers.overlay]) {
      if (!layer) continue;
      gl.useProgram(this.surface);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.surface, 'u_view'), false, view);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.surface, 'u_projection'), false, projection);
      this.#bind(this.surface, 'a_position', layer.position);
      this.#bind(this.surface, 'a_normal', layer.normal);
      this.#bind(this.surface, 'a_color', layer.color);
      gl.drawArrays(gl.TRIANGLES, 0, layer.count);
    }
    gl.disable(gl.POLYGON_OFFSET_FILL);
    if (this.layers.edges) {
      gl.useProgram(this.line);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.line, 'u_view'), false, view);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.line, 'u_projection'), false, projection);
      gl.uniform3fv(gl.getUniformLocation(this.line, 'u_color'), this.edgeColor);
      this.#bind(this.line, 'a_position', this.layers.edges.buffer);
      gl.drawArrays(gl.LINES, 0, this.layers.edges.count);
    }
  }

  #bind(program, name, buffer) {
    const gl = this.gl;
    const location = gl.getAttribLocation(program, name);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 3, gl.FLOAT, false, 0, 0);
  }

  // RGBA pixels of the current frame, top row first
  readPixels() {
    const gl = this.gl;
    const { width, height } = this.canvas;
    const raw = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    const flipped = new Uint8Array(raw.length);
    const row = width * 4;
    for (let y = 0; y < height; y++) flipped.set(raw.subarray((height - 1 - y) * row, (height - y) * row), y * row);
    return { width, height, rgba: flipped };
  }
}

// Arrow along direction ending at tip, as triangle soup: { positions, normals }
export function arrowGeometry(tip_m, direction, length_m, radius_m) {
  const positions = [];
  const normals = [];
  const d = direction;
  const sideAxis = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = normalizeVec([d[1] * sideAxis[2] - d[2] * sideAxis[1], d[2] * sideAxis[0] - d[0] * sideAxis[2], d[0] * sideAxis[1] - d[1] * sideAxis[0]]);
  const v = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
  const base = tip_m.map((c, a) => c - d[a] * length_m);
  const headLength = length_m * 0.35;
  const neck = tip_m.map((c, a) => c - d[a] * headLength);
  const sides = 14;
  const ring = (center, r, angle) => center.map((c, a) => c + r * (Math.cos(angle) * u[a] + Math.sin(angle) * v[a]));
  const push = (p, n) => {
    positions.push(...p);
    normals.push(...n);
  };
  for (let i = 0; i < sides; i++) {
    const a0 = (2 * Math.PI * i) / sides;
    const a1 = (2 * Math.PI * (i + 1)) / sides;
    const nrm = (angle) => ring([0, 0, 0], 1, angle);
    const shaftR = radius_m * 0.35;
    // shaft
    push(ring(base, shaftR, a0), nrm(a0));
    push(ring(neck, shaftR, a0), nrm(a0));
    push(ring(neck, shaftR, a1), nrm(a1));
    push(ring(base, shaftR, a0), nrm(a0));
    push(ring(neck, shaftR, a1), nrm(a1));
    push(ring(base, shaftR, a1), nrm(a1));
    // head
    push(ring(neck, radius_m, a0), nrm(a0));
    push(tip_m, d);
    push(ring(neck, radius_m, a1), nrm(a1));
    // head base
    push(ring(neck, radius_m, a0), d.map((c) => -c));
    push(ring(neck, radius_m, a1), d.map((c) => -c));
    push(neck, d.map((c) => -c));
  }
  return { positions: Float32Array.from(positions), normals: Float32Array.from(normals) };
}

function normalizeVec(a) {
  const len = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / len, a[1] / len, a[2] / len];
}
