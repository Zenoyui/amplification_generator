// Support regions as node predicates. Specs are plain data produced by geometry templates:
//   { kind: 'plane', axis, coord_m }                    nodes on the plane axis = coord_m
//   { kind: 'bore', axis, center_m: [u, v], radius_m }  nodes in a thin shell around a cylindrical bore
//   { kind: 'sphere', center_m: [x, y, z], radius_m }   nodes within the radius of a point

// Plane tolerance as a fraction of the cell size along the plane normal
const PLANE_FRACTION = 0.25;
// Bore shell, in cells: from -BORE_INNER to +BORE_OUTER around the bore radius
const BORE_INNER = 0.25;
const BORE_OUTER = 0.9;

export function supportTest(spec, cell_m) {
  if (spec.kind === 'plane') {
    const tolerance_m = PLANE_FRACTION * cell_m[spec.axis];
    return (x, y, z) => Math.abs([x, y, z][spec.axis] - spec.coord_m) <= tolerance_m;
  }
  if (spec.kind === 'bore') {
    const u = (spec.axis + 1) % 3;
    const v = (spec.axis + 2) % 3;
    const h_m = Math.max(...cell_m);
    return (x, y, z) => {
      const p = [x, y, z];
      const offset_m = Math.hypot(p[u] - spec.center_m[0], p[v] - spec.center_m[1]) - spec.radius_m;
      return offset_m >= -BORE_INNER * h_m && offset_m <= BORE_OUTER * h_m;
    };
  }
  if (spec.kind === 'sphere') {
    return (x, y, z) => Math.hypot(x - spec.center_m[0], y - spec.center_m[1], z - spec.center_m[2]) <= spec.radius_m;
  }
  throw new Error(`support kind unknown (kind=${spec.kind})`);
}
