// Signed distance functions in meters, negative inside. All shapes are 1-Lipschitz except round union
// (gradient length up to sqrt(2) in the blend zone).

const AXES = { x: 0, y: 1, z: 2 };

// Box with center and half sizes (3-vectors)
function box(center_m, half_m) {
  const [cx, cy, cz] = center_m;
  const [hx, hy, hz] = half_m;
  return (x, y, z) => {
    const dx = Math.abs(x - cx) - hx;
    const dy = Math.abs(y - cy) - hy;
    const dz = Math.abs(z - cz) - hz;
    const ox = dx > 0 ? dx : 0;
    const oy = dy > 0 ? dy : 0;
    const oz = dz > 0 ? dz : 0;
    return Math.sqrt(ox * ox + oy * oy + oz * oz) + Math.min(Math.max(dx, dy, dz), 0);
  };
}

// Box from min and max corners
export function boxFromCorners(min_m, max_m) {
  return box(
    [(min_m[0] + max_m[0]) / 2, (min_m[1] + max_m[1]) / 2, (min_m[2] + max_m[2]) / 2],
    [(max_m[0] - min_m[0]) / 2, (max_m[1] - min_m[1]) / 2, (max_m[2] - min_m[2]) / 2],
  );
}

// Cylinder along axis 'x' | 'y' | 'z' through center, radius and half length along the axis
export function cylinder(axis, center_m, radius_m, halfLength_m) {
  const a = AXES[axis];
  const u = (a + 1) % 3;
  const v = (a + 2) % 3;
  return (x, y, z) => {
    const p = [x, y, z];
    const radial = Math.hypot(p[u] - center_m[u], p[v] - center_m[v]) - radius_m;
    const along = Math.abs(p[a] - center_m[a]) - halfLength_m;
    const ro = radial > 0 ? radial : 0;
    const ao = along > 0 ? along : 0;
    return Math.sqrt(ro * ro + ao * ao) + Math.min(Math.max(radial, along), 0);
  };
}

// 2D polygon distance (vertices in order, either winding) at point (px, py)
export function polygonDistance(vertices, px, py) {
  const n = vertices.length;
  let dist2 = Infinity;
  let sign = 1;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ex = vertices[j][0] - vertices[i][0];
    const ey = vertices[j][1] - vertices[i][1];
    const wx = px - vertices[i][0];
    const wy = py - vertices[i][1];
    const t = Math.min(1, Math.max(0, (wx * ex + wy * ey) / (ex * ex + ey * ey)));
    const bx = wx - ex * t;
    const by = wy - ey * t;
    const d2 = bx * bx + by * by;
    if (d2 < dist2) dist2 = d2;
    const c1 = py >= vertices[i][1];
    const c2 = py < vertices[j][1];
    const c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) sign = -sign;
  }
  return sign * Math.sqrt(dist2);
}

// Extrusion of a polygon given in the plane of axes (u, v) along the third axis.
// plane: 'xy' (extrude z), 'yz' (extrude x), 'zx' (extrude y); vertices are [u, v]; range_m = [lo, hi] along extrusion axis
export function extrudePolygon(plane, vertices, range_m) {
  const mapping = { xy: [0, 1, 2], yz: [1, 2, 0], zx: [2, 0, 1] }[plane];
  const mid = (range_m[0] + range_m[1]) / 2;
  const half = (range_m[1] - range_m[0]) / 2;
  const [u, v, w] = mapping;
  return (x, y, z) => {
    const coordinate = (axis) => (axis === 0 ? x : axis === 1 ? y : z);
    const d2 = polygonDistance(vertices, coordinate(u), coordinate(v));
    const dz = Math.abs(coordinate(w) - mid) - half;
    const o2 = d2 > 0 ? d2 : 0;
    const oz = dz > 0 ? dz : 0;
    return Math.sqrt(o2 * o2 + oz * oz) + Math.min(Math.max(d2, dz), 0);
  };
}

// Rotates the query point about the z axis through (cx, cy) by angle_rad before evaluating shape
export function rotatedAboutZ(shape, cx, cy, angle_rad) {
  const c = Math.cos(angle_rad);
  const s = Math.sin(angle_rad);
  return (x, y, z) => {
    const dx = x - cx;
    const dy = y - cy;
    return shape(cx + c * dx + s * dy, cy - s * dx + c * dy, z);
  };
}

export const union = (a, b) => (x, y, z) => Math.min(a(x, y, z), b(x, y, z));
export const unionAll = (shapes) => (x, y, z) => {
  let best = Infinity;
  for (const shape of shapes) {
    const d = shape(x, y, z);
    if (d < best) best = d;
  }
  return best;
};
export const subtract = (a, b) => (x, y, z) => Math.max(a(x, y, z), -b(x, y, z));
export const intersect = (a, b) => (x, y, z) => Math.max(a(x, y, z), b(x, y, z));

// Union with a circular fillet of radius r in concave junctions (inside negative)
export function roundUnion(a, b, radius_m) {
  return (x, y, z) => {
    const da = a(x, y, z);
    const db = b(x, y, z);
    const ua = radius_m - da;
    const ub = radius_m - db;
    const oa = ua > 0 ? ua : 0;
    const ob = ub > 0 ? ub : 0;
    return Math.max(radius_m, Math.min(da, db)) - Math.sqrt(oa * oa + ob * ob);
  };
}

// Union with fillets of radius r, applied only inside `zone` (a signed distance field). A round union also
// thickens coplanar faces and convex corners where the bodies overlap, so the added material is cut to the zone
// that contains the intended concave junction.
export function joinWithFillet(a, b, radius_m, zone) {
  if (!(radius_m > 0)) return union(a, b);
  return union(union(a, b), intersect(roundUnion(a, b, radius_m), zone));
}

// Region of a revolved rectangle: points whose (radial distance from the z axis, z) lie in the 2D box
export function revolvedBox(radialMin_m, radialMax_m, zMin_m, zMax_m) {
  const cr = (radialMin_m + radialMax_m) / 2;
  const cz = (zMin_m + zMax_m) / 2;
  const hr = (radialMax_m - radialMin_m) / 2;
  const hz = (zMax_m - zMin_m) / 2;
  return (x, y, z) => {
    const dr = Math.abs(Math.hypot(x, y) - cr) - hr;
    const dz = Math.abs(z - cz) - hz;
    const or = dr > 0 ? dr : 0;
    const oz = dz > 0 ? dz : 0;
    return Math.sqrt(or * or + oz * oz) + Math.min(Math.max(dr, dz), 0);
  };
}

// Outward unit normal by central differences (step in meters)
export function gradientNormal(shape, point_m, step_m) {
  const [x, y, z] = point_m;
  const gx = shape(x + step_m, y, z) - shape(x - step_m, y, z);
  const gy = shape(x, y + step_m, z) - shape(x, y - step_m, z);
  const gz = shape(x, y, z + step_m) - shape(x, y, z - step_m);
  const len = Math.hypot(gx, gy, gz);
  return len > 0 ? [gx / len, gy / len, gz / len] : [0, 0, 1];
}

export function mergeBounds(list) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const b of list) {
    for (let a = 0; a < 3; a++) {
      if (b.min[a] < min[a]) min[a] = b.min[a];
      if (b.max[a] > max[a]) max[a] = b.max[a];
    }
  }
  return { min, max };
}
