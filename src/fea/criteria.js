// Strength theories I-V (equivalent stress and safety factor) on principal stresses.
// Tension limit sT and compression limit sC come from the material (yield for ductile, ultimate for brittle).

import { principalValues } from '../math/sym3.js';
import { limitStresses } from './materials.js';

// Equivalent stresses at or below this fraction of the limit stress give safety factor 'unbounded'
const UNBOUNDED_RATIO = 1e-9;
export const SAFETY_UNBOUNDED = Infinity;

export const THEORIES = [
  { id: 'I', name: 'Первая теория (наибольших нормальных напряжений)', formula: 'sigma_экв = sigma_1; при сжатии |sigma_3| сравнивается с пределом при сжатии' },
  { id: 'II', name: 'Вторая теория (наибольших линейных деформаций)', formula: 'sigma_экв = sigma_1 - nu (sigma_2 + sigma_3)' },
  { id: 'III', name: 'Третья теория (наибольших касательных напряжений, Треска)', formula: 'sigma_экв = sigma_1 - sigma_3' },
  { id: 'IV', name: 'Четвертая теория (энергии формоизменения, Мизес)', formula: 'sigma_экв = sqrt(((s1 - s2)^2 + (s2 - s3)^2 + (s3 - s1)^2) / 2)' },
  { id: 'V', name: 'Теория Мора', formula: 'sigma_экв = sigma_1 - (sigma_р / sigma_с) sigma_3' },
];

// Which theories govern: ductile materials III and IV, brittle materials I, II and V
export function governingTheories(material) {
  return material.kind === 'ductile' ? ['III', 'IV'] : ['I', 'II', 'V'];
}

const ratio = (limit_pa, equivalent_pa) => (equivalent_pa > UNBOUNDED_RATIO * limit_pa ? limit_pa / equivalent_pa : SAFETY_UNBOUNDED);

// Equivalent stress (Pa) of every theory from principal values s1 >= s2 >= s3
export function equivalentStresses(s1, s2, s3, material) {
  const { tension_pa, compression_pa } = limitStresses(material);
  const mises = Math.sqrt(0.5 * ((s1 - s2) ** 2 + (s2 - s3) ** 2 + (s3 - s1) ** 2));
  return {
    I: s1,
    II: s1 - material.poisson * (s2 + s3),
    III: s1 - s3,
    IV: mises,
    V: s1 - (tension_pa / compression_pa) * s3,
  };
}

// Safety factors of every theory (limit stress over equivalent stress)
export function safetyFactors(s1, s2, s3, material) {
  const { tension_pa, compression_pa } = limitStresses(material);
  const eq = equivalentStresses(s1, s2, s3, material);
  const tension = s1 > 0 ? tension_pa / s1 : SAFETY_UNBOUNDED;
  const compression = s3 < 0 ? compression_pa / -s3 : SAFETY_UNBOUNDED;
  return {
    I: Math.min(tension, compression),
    II: ratio(tension_pa, eq.II),
    III: ratio(tension_pa, eq.III),
    IV: ratio(tension_pa, eq.IV),
    V: ratio(tension_pa, eq.V),
  };
}

const THEORY_IDS = THEORIES.map((t) => t.id);

// Principal values of the tensor stored at offset o of stress_pa, or of the blend (1 - t) A + t B
function principalAt(stress_pa, o0, o1, t) {
  const c = (k) => (o1 < 0 ? stress_pa[o0 + k] : (1 - t) * stress_pa[o0 + k] + t * stress_pa[o1 + k]);
  return principalValues(c(0), c(1), c(2), c(3), c(4), c(5));
}

// Peak search is limited to candidates: nodes inside the material and points where grid edges cross the surface
// (stress interpolated between the edge nodes). Summary per theory: minimum safety factor and peak equivalent stress,
// excluding nodes flagged in `excluded` (around supports and load patches); rawPeak ignores the exclusion.
// stress_pa: 6 per node (xx yy zz xy yz xz); count: nonzero where stress exists; surface: [{ n0, n1, t }]
export function evaluateFields(stress_pa, count, excluded, inside, surface, material, requiredSafety) {
  const nodeCount = count.length;
  const safety = Object.fromEntries(THEORY_IDS.map((id) => [id, new Float32Array(nodeCount).fill(SAFETY_UNBOUNDED)]));
  const mises_pa = new Float32Array(nodeCount);
  const summary = Object.fromEntries(
    THEORY_IDS.map((id) => [id, { minSafety: SAFETY_UNBOUNDED, where: null, peakEquivalent_pa: 0, peakWhere: null }]),
  );
  const rawPeak = { mises_pa: 0, where: null };
  const consider = (principals, where, isExcluded) => {
    const [s1, s2, s3] = principals;
    const n_k = safetyFactors(s1, s2, s3, material);
    const eq = equivalentStresses(s1, s2, s3, material);
    if (eq.IV > rawPeak.mises_pa) {
      rawPeak.mises_pa = eq.IV;
      rawPeak.where = where;
    }
    if (isExcluded) return;
    for (const id of THEORY_IDS) {
      const entry = summary[id];
      if (n_k[id] < entry.minSafety) {
        entry.minSafety = n_k[id];
        entry.where = where;
      }
      if (eq[id] > entry.peakEquivalent_pa) {
        entry.peakEquivalent_pa = eq[id];
        entry.peakWhere = where;
      }
    }
  };
  for (let n = 0; n < nodeCount; n++) {
    if (count[n] === 0) continue;
    const principals = principalAt(stress_pa, 6 * n, -1, 0);
    const n_k = safetyFactors(principals[0], principals[1], principals[2], material);
    mises_pa[n] = equivalentStresses(principals[0], principals[1], principals[2], material).IV;
    for (const id of THEORY_IDS) safety[id][n] = n_k[id];
    if (inside[n]) consider(principals, { n }, excluded[n]);
  }
  for (const { n0, n1, t } of surface) {
    consider(principalAt(stress_pa, 6 * n0, 6 * n1, t), { n0, n1, t }, excluded[n0] || excluded[n1]);
  }
  return { mises_pa, safety, summary, rawPeak, contradictions: findContradictions(summary, material, requiredSafety) };
}

// Disagreements between theories: different verdicts against requiredSafety, or safety factors that differ
// by more than SPREAD_LIMIT relative to the smaller value
const SPREAD_LIMIT = 0.15;

export function findContradictions(summary, material, requiredSafety) {
  const found = [];
  const ids = THEORIES.map((t) => t.id);
  const governing = governingTheories(material);
  const verdict = (id) => summary[id].minSafety >= requiredSafety;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i];
      const b = ids[j];
      if (!governing.includes(a) && !governing.includes(b)) continue;
      const na = summary[a].minSafety;
      const nb = summary[b].minSafety;
      if (!Number.isFinite(na) || !Number.isFinite(nb)) continue;
      if (verdict(a) !== verdict(b)) found.push({ a, b, kind: 'verdict', na, nb });
      else if (Math.abs(na - nb) / Math.min(na, nb) > SPREAD_LIMIT) found.push({ a, b, kind: 'spread', na, nb });
    }
  }
  return found;
}
