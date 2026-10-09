// Dual contouring of a signed distance function: closed triangle mesh with sharp edges kept.

// Pseudo-inverse threshold: eigenvalues below this share of the largest are dropped (keeps edges, not corners of noise)
const EIGEN_CUTOFF = 0.1;
// Newton steps that refine an edge crossing
const REFINE_STEPS = 3;
// Projections of a cell vertex onto the surface after the quadratic fit
const PROJECT_STEPS = 2;
// Normal step as a share of the cell size
const NORMAL_STEP = 0.001;
// Grid origin offset in cells, irrational-like, so that flat faces never lie on grid planes
const GRID_SHIFT = 0.371;
// Cells of margin around the bounds
const MARGIN_CELLS = 2;
const JACOBI_SWEEPS = 24;
// Distance blocks: nodes per side and the safety factor on the block reach
const BLOCK_NODES = 4;
const BLOCK_SAFETY = 1.5;

// Eigen decomposition of a symmetric 3 x 3 matrix a (row-major, 9) by Jacobi rotations: returns { eigenvalues, eigenvectors }
function eigenSymmetric3(a) {
  const m = Float64Array.from(a);
  const v = Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  for (let sweep = 0; sweep < JACOBI_SWEEPS; sweep++) {
    const off = Math.abs(m[1]) + Math.abs(m[2]) + Math.abs(m[5]);
    if (off < 1e-18 * (Math.abs(m[0]) + Math.abs(m[4]) + Math.abs(m[8]) + 1e-300)) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      const apq = m[p * 3 + q];
      if (Math.abs(apq) < 1e-300) continue;
      const theta = (m[q * 3 + q] - m[p * 3 + p]) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = m[k * 3 + p];
        const akq = m[k * 3 + q];
        m[k * 3 + p] = c * akp - s * akq;
        m[k * 3 + q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = m[p * 3 + k];
        const aqk = m[q * 3 + k];
        m[p * 3 + k] = c * apk - s * aqk;
        m[q * 3 + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k * 3 + p];
        const vkq = v[k * 3 + q];
        v[k * 3 + p] = c * vkp - s * vkq;
        v[k * 3 + q] = s * vkp + c * vkq;
      }
    }
  }
  return { eigenvalues: [m[0], m[4], m[8]], eigenvectors: v };
}

// Point minimizing sum (n_i . (x - p_i))^2 near the mass point; samples: [{ p, n }]
function solveQef(samples) {
  const c = [0, 0, 0];
  for (const s of samples) for (let a = 0; a < 3; a++) c[a] += s.p[a] / samples.length;
  const ata = new Float64Array(9);
  const atb = [0, 0, 0];
  for (const { p, n } of samples) {
    const d = n[0] * (p[0] - c[0]) + n[1] * (p[1] - c[1]) + n[2] * (p[2] - c[2]);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) ata[i * 3 + j] += n[i] * n[j];
      atb[i] += n[i] * d;
    }
  }
  const { eigenvalues, eigenvectors } = eigenSymmetric3(ata);
  const largest = Math.max(...eigenvalues.map(Math.abs));
  const x = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    if (Math.abs(eigenvalues[k]) < EIGEN_CUTOFF * largest) continue;
    const proj = eigenvectors[0 * 3 + k] * atb[0] + eigenvectors[1 * 3 + k] * atb[1] + eigenvectors[2 * 3 + k] * atb[2];
    for (let a = 0; a < 3; a++) x[a] += (proj / eigenvalues[k]) * eigenvectors[a * 3 + k];
  }
  return [c[0] + x[0], c[1] + x[1], c[2] + x[2]];
}

// Builds the mesh. bounds_m = { min, max }, cell_m target size. Returns { positions (Float32, 3 per vertex),
// indices (Uint32, 3 per triangle), cell_m }.
// Node distances. Blocks of BLOCK_NODES nodes farther from the surface than the block reach get the distance at their
// center: only the sign is read there (the sdf has Lipschitz constant near 1, BLOCK_SAFETY covers the excess).
function fillDistances(phi, sdf, origin, size, [nx, ny, nz]) {
  const sy = nx + 1;
  const sz = sy * (ny + 1);
  const reach = BLOCK_SAFETY * 0.5 * BLOCK_NODES * Math.hypot(...size);
  for (let bk = 0; bk <= nz; bk += BLOCK_NODES) {
    for (let bj = 0; bj <= ny; bj += BLOCK_NODES) {
      for (let bi = 0; bi <= nx; bi += BLOCK_NODES) {
        const i1 = Math.min(nx, bi + BLOCK_NODES);
        const j1 = Math.min(ny, bj + BLOCK_NODES);
        const k1 = Math.min(nz, bk + BLOCK_NODES);
        const center = sdf(origin[0] + 0.5 * (bi + i1) * size[0], origin[1] + 0.5 * (bj + j1) * size[1], origin[2] + 0.5 * (bk + k1) * size[2]);
        const far = Math.abs(center) > reach;
        for (let k = bk; k <= k1; k++) {
          for (let j = bj; j <= j1; j++) {
            for (let i = bi; i <= i1; i++) {
              phi[k * sz + j * sy + i] = far ? center : sdf(origin[0] + i * size[0], origin[1] + j * size[1], origin[2] + k * size[2]);
            }
          }
        }
      }
    }
  }
}

export function dualContour(sdf, bounds_m, cell_m) {
  const lengths = bounds_m.max.map((hi, a) => hi - bounds_m.min[a]);
  const counts = lengths.map((len) => Math.max(1, Math.ceil(len / cell_m)) + 2 * MARGIN_CELLS);
  const size = counts.map((n, a) => (lengths[a] / (n - 2 * MARGIN_CELLS)));
  const origin = bounds_m.min.map((lo, a) => lo - (MARGIN_CELLS + GRID_SHIFT) * size[a]);
  const [nx, ny, nz] = counts;
  const sy = nx + 1;
  const sz = sy * (ny + 1);
  const phi = new Float32Array((nx + 1) * (ny + 1) * (nz + 1));
  fillDistances(phi, sdf, origin, size, [nx, ny, nz]);
  const step = NORMAL_STEP * Math.min(...size);
  const position = (i, j, k) => [origin[0] + i * size[0], origin[1] + j * size[1], origin[2] + k * size[2]];
  // forward differences against the known distance at pt
  const normalAt = (pt, distance) => {
    const gx = sdf(pt[0] + step, pt[1], pt[2]) - distance;
    const gy = sdf(pt[0], pt[1] + step, pt[2]) - distance;
    const gz = sdf(pt[0], pt[1], pt[2] + step) - distance;
    const len = Math.hypot(gx, gy, gz) || 1;
    return [gx / len, gy / len, gz / len];
  };
  // crossing on the edge from node (i, j, k) along axis: fixed-slope Newton steps on the sdf, exact for planar faces
  const crossingCache = new Map();
  const crossing = (i, j, k, axis) => {
    const key = 3 * (k * sz + j * sy + i) + axis;
    const cached = crossingCache.get(key);
    if (cached) return cached;
    const a = position(i, j, k);
    const na = phi[k * sz + j * sy + i];
    const nb = phi[(k + (axis === 2 ? 1 : 0)) * sz + (j + (axis === 1 ? 1 : 0)) * sy + i + (axis === 0 ? 1 : 0)];
    const slope = nb - na;
    let t = na / (na - nb);
    const at = (u) => {
      const q = [...a];
      q[axis] += u * size[axis];
      return q;
    };
    for (let s = 0; s < REFINE_STEPS; s++) {
      const q = at(t);
      const distance = sdf(q[0], q[1], q[2]);
      t = Math.min(1, Math.max(0, t - distance / slope));
    }
    const point = at(t);
    const crossed = { p: point, n: normalAt(point, sdf(point[0], point[1], point[2])) };
    crossingCache.set(key, crossed);
    return crossed;
  };

  // cell vertices
  const cellVertex = new Int32Array(nx * ny * nz).fill(-1);
  const positions = [];
  const corner = (i, j, k, c) => phi[(k + ((c >> 2) & 1)) * sz + (j + ((c >> 1) & 1)) * sy + i + (c & 1)];
  const EDGES = [
    [0, 1, 0], [2, 3, 0], [4, 5, 0], [6, 7, 0],
    [0, 2, 1], [1, 3, 1], [4, 6, 1], [5, 7, 1],
    [0, 4, 2], [1, 5, 2], [2, 6, 2], [3, 7, 2],
  ];
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const samples = [];
        for (const [c0, c1, axis] of EDGES) {
          if ((corner(i, j, k, c0) < 0) === (corner(i, j, k, c1) < 0)) continue;
          samples.push(crossing(i + (c0 & 1), j + ((c0 >> 1) & 1), k + ((c0 >> 2) & 1), axis));
        }
        if (samples.length === 0) continue;
        const vertex = solveQef(samples);
        for (let s = 0; s < PROJECT_STEPS; s++) {
          const distance = sdf(vertex[0], vertex[1], vertex[2]);
          const normal = normalAt(vertex, distance);
          for (let a = 0; a < 3; a++) vertex[a] -= distance * normal[a];
        }
        for (let a = 0; a < 3; a++) {
          const lo = origin[a] + [i, j, k][a] * size[a];
          vertex[a] = Math.min(lo + size[a], Math.max(lo, vertex[a]));
        }
        cellVertex[(k * ny + j) * nx + i] = positions.length / 3;
        positions.push(vertex[0], vertex[1], vertex[2]);
      }
    }
  }

  // one quad per sign-changing interior edge
  const indices = [];
  const vertexIn = (i, j, k) => cellVertex[(k * ny + j) * nx + i];
  const emit = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    const quad = flip ? [a, d, c, b] : [a, b, c, d];
    const dist = (u, v) => Math.hypot(positions[3 * u] - positions[3 * v], positions[3 * u + 1] - positions[3 * v + 1], positions[3 * u + 2] - positions[3 * v + 2]);
    if (dist(quad[0], quad[2]) <= dist(quad[1], quad[3])) indices.push(quad[0], quad[1], quad[2], quad[0], quad[2], quad[3]);
    else indices.push(quad[0], quad[1], quad[3], quad[1], quad[2], quad[3]);
  };
  for (let k = 1; k < nz; k++) {
    for (let j = 1; j < ny; j++) {
      for (let i = 1; i < nx; i++) {
        const here = phi[k * sz + j * sy + i] < 0;
        // x edge from (i, j, k) to (i + 1, j, k): cells around it share y and z neighbours
        if (i < nx && here !== (phi[k * sz + j * sy + i + 1] < 0)) {
          emit(vertexIn(i, j - 1, k - 1), vertexIn(i, j, k - 1), vertexIn(i, j, k), vertexIn(i, j - 1, k), !here);
        }
        if (j < ny && here !== (phi[k * sz + (j + 1) * sy + i] < 0)) {
          emit(vertexIn(i - 1, j, k - 1), vertexIn(i - 1, j, k), vertexIn(i, j, k), vertexIn(i, j, k - 1), !here);
        }
        if (k < nz && here !== (phi[(k + 1) * sz + j * sy + i] < 0)) {
          emit(vertexIn(i - 1, j - 1, k), vertexIn(i, j - 1, k), vertexIn(i, j, k), vertexIn(i - 1, j, k), !here);
        }
      }
    }
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices), cell_m: size };
}

// Triangle soup with per-vertex normals: a vertex normal averages the face normals of the faces around it that
// lie within creaseAngle_rad of the face itself, so flat faces stay flat and curved faces shade smoothly.
export function shadedSoup(mesh, creaseAngle_rad) {
  const { positions, indices } = mesh;
  const triangleCount = indices.length / 3;
  const faceNormals = new Float32Array(3 * triangleCount);
  const incident = new Map();
  for (let t = 0; t < triangleCount; t++) {
    const [a, b, c] = [indices[3 * t], indices[3 * t + 1], indices[3 * t + 2]];
    const ux = positions[3 * b] - positions[3 * a];
    const uy = positions[3 * b + 1] - positions[3 * a + 1];
    const uz = positions[3 * b + 2] - positions[3 * a + 2];
    const vx = positions[3 * c] - positions[3 * a];
    const vy = positions[3 * c + 1] - positions[3 * a + 1];
    const vz = positions[3 * c + 2] - positions[3 * a + 2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    faceNormals.set([nx, ny, nz], 3 * t);
    for (const v of [a, b, c]) {
      if (!incident.has(v)) incident.set(v, []);
      incident.get(v).push(t);
    }
  }
  const cosLimit = Math.cos(creaseAngle_rad);
  const outPositions = new Float32Array(9 * triangleCount);
  const outNormals = new Float32Array(9 * triangleCount);
  for (let t = 0; t < triangleCount; t++) {
    for (let corner = 0; corner < 3; corner++) {
      const v = indices[3 * t + corner];
      let nx = 0;
      let ny = 0;
      let nz = 0;
      for (const u of incident.get(v)) {
        const dotValue = faceNormals[3 * u] * faceNormals[3 * t] + faceNormals[3 * u + 1] * faceNormals[3 * t + 1] + faceNormals[3 * u + 2] * faceNormals[3 * t + 2];
        if (dotValue >= cosLimit) {
          nx += faceNormals[3 * u];
          ny += faceNormals[3 * u + 1];
          nz += faceNormals[3 * u + 2];
        }
      }
      const len = Math.hypot(nx, ny, nz) || 1;
      const o = 9 * t + 3 * corner;
      outPositions.set([positions[3 * v], positions[3 * v + 1], positions[3 * v + 2]], o);
      outNormals.set([nx / len, ny / len, nz / len], o);
    }
  }
  return { positions: outPositions, normals: outNormals, triangleCount };
}

// Edge statistics for closed-surface checks: edges shared by other than two triangles
export function edgeReport(mesh) {
  const counts = new Map();
  const { indices } = mesh;
  for (let t = 0; t < indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = indices[t + e];
      const b = indices[t + ((e + 1) % 3)];
      const key = a < b ? a * 4294967296 + b : b * 4294967296 + a;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  let open = 0;
  let overshared = 0;
  for (const c of counts.values()) {
    if (c === 1) open++;
    else if (c > 2) overshared++;
  }
  return { edges: counts.size, open, overshared };
}

// Volume enclosed by the mesh (divergence theorem), m3
export function meshVolume(mesh) {
  const { positions, indices } = mesh;
  let volume = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = 3 * indices[t];
    const b = 3 * indices[t + 1];
    const c = 3 * indices[t + 2];
    volume +=
      (positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1]) -
        positions[a + 1] * (positions[b] * positions[c + 2] - positions[b + 2] * positions[c]) +
        positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c])) /
      6;
  }
  return volume;
}

// Sharp edges of the mesh: edges between two triangles whose normals differ by more than angle_rad.
// Returns Float32Array of segment end points (6 numbers per segment).
export function featureEdges(mesh, angle_rad) {
  const { positions, indices } = mesh;
  const triangleCount = indices.length / 3;
  const normals = new Float32Array(3 * triangleCount);
  for (let t = 0; t < triangleCount; t++) {
    const a = 3 * indices[3 * t];
    const b = 3 * indices[3 * t + 1];
    const c = 3 * indices[3 * t + 2];
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    normals.set([nx / len, ny / len, nz / len], 3 * t);
  }
  const owner = new Map();
  const segments = [];
  const cosLimit = Math.cos(angle_rad);
  for (let t = 0; t < triangleCount; t++) {
    for (let e = 0; e < 3; e++) {
      const a = indices[3 * t + e];
      const b = indices[3 * t + ((e + 1) % 3)];
      const key = a < b ? a * 4294967296 + b : b * 4294967296 + a;
      const other = owner.get(key);
      if (other === undefined) {
        owner.set(key, t);
        continue;
      }
      const dotValue = normals[3 * t] * normals[3 * other] + normals[3 * t + 1] * normals[3 * other + 1] + normals[3 * t + 2] * normals[3 * other + 2];
      if (dotValue < cosLimit) {
        segments.push(positions[3 * a], positions[3 * a + 1], positions[3 * a + 2], positions[3 * b], positions[3 * b + 1], positions[3 * b + 2]);
      }
    }
  }
  return Float32Array.from(segments);
}
