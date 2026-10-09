// Symmetric 3x3 tensor helpers (stress, strain)

// Relative size of the off-diagonal part below which the tensor is treated as diagonal
const DIAGONAL_REL = 1e-14;

// Principal values, descending: [s1, s2, s3]. Closed form (Smith 1961), cos form.
export function principalValues(sxx, syy, szz, sxy, syz, sxz) {
  const off2 = sxy * sxy + syz * syz + sxz * sxz;
  const trace3 = (sxx + syy + szz) / 3;
  const scaleSq = sxx * sxx + syy * syy + szz * szz + 2 * off2;
  if (off2 <= DIAGONAL_REL * DIAGONAL_REL * scaleSq) {
    return [sxx, syy, szz].sort((a, b) => b - a);
  }
  const dx = sxx - trace3;
  const dy = syy - trace3;
  const dz = szz - trace3;
  const p = Math.sqrt((dx * dx + dy * dy + dz * dz + 2 * off2) / 6);
  // B = (A - q I) / p, det(B) / 2 = r
  const bxx = dx / p;
  const byy = dy / p;
  const bzz = dz / p;
  const bxy = sxy / p;
  const byz = syz / p;
  const bxz = sxz / p;
  const detB =
    bxx * (byy * bzz - byz * byz) - bxy * (bxy * bzz - byz * bxz) + bxz * (bxy * byz - byy * bxz);
  const r = Math.min(1, Math.max(-1, detB / 2));
  const phi = Math.acos(r) / 3;
  const s1 = trace3 + 2 * p * Math.cos(phi);
  const s3 = trace3 + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
  const s2 = 3 * trace3 - s1 - s3;
  return [s1, s2, s3];
}

