// Derived values and texts of an analysis result, shared by the page and the PDF document

import { THEORIES } from '../fea/criteria.js';
import { WARNINGS } from '../ui/text.js';
import { formatNumber, formatPercent, formatSafety } from '../ui/format.js';

const MM_PER_M = 1000;
const MPA = 1e6;
// Cells per smallest radius below which the peak stress is reported as under-resolved
export const RADIUS_CELLS_LIMIT = 5;
// Cells across the thinnest feature below which the stiffness is reported as under-resolved
export const THICKNESS_CELLS_LIMIT = 3;
// Relative change of the peak stress between two cell sizes above which it is reported as not converged
export const STRESS_CONVERGENCE_LIMIT = 0.1;
// Raw peak above the reported peak by this ratio is reported
const RAW_PEAK_RATIO = 1.1;

export const primaryTheory = (material) => (material.kind === 'ductile' ? 'IV' : 'V');

const pointText = (point_m) => (point_m ? `(${point_m.map((v) => formatNumber(v * MM_PER_M, 3)).join('; ')}) мм` : 'нет данных');

// analysis: result of analyze(); material: record; requiredSafety: number
export function summarize(analysis, material, requiredSafety) {
  const { solve, convergence, resolution } = analysis;
  const s = solve.summary;
  const primary = primaryTheory(material);
  const primaryEntry = s.theories[primary];
  const safety = primaryEntry.minSafety;
  const theories = THEORIES.map((theory) => {
    const entry = s.theories[theory.id];
    const governing = s.governing.includes(theory.id);
    return {
      id: theory.id,
      name: theory.name,
      formula: theory.formula,
      role: governing ? 'расчетная' : 'справочная',
      peak_mpa: entry.peakEquivalent_pa / MPA,
      safety: entry.minSafety,
      passes: entry.minSafety >= requiredSafety,
      point_m: entry.point_m,
    };
  });

  const notes = [];
  if (!solve.status.converged) {
    notes.push({ level: 'fail', text: `Решение не сошлось: относительная невязка ${solve.status.relativeResidual.toExponential(1).replace('.', ',')} за ${solve.status.iterations} итераций. Результаты ненадежны.` });
  }
  for (const warning of s.warnings) notes.push({ level: 'warn', text: WARNINGS[warning.code](warning) });
  if (resolution.cellsPerSmallestRadius !== null && resolution.cellsPerSmallestRadius < RADIUS_CELLS_LIMIT) {
    notes.push({
      level: 'warn',
      text: `Наименьший радиус занимает ${formatNumber(resolution.cellsPerSmallestRadius, 2)} ячейки. При 4-6 ячейках на радиус пиковое напряжение занижено на 3-17 процентов (проверка на пластине с отверстием). Выбрать качество выше.`,
    });
  }
  if (resolution.cellsAcrossThinnest < THICKNESS_CELLS_LIMIT) {
    notes.push({ level: 'warn', text: `Наименьшая толщина занимает ${formatNumber(resolution.cellsAcrossThinnest, 2)} ячейки. Выбрать качество выше.` });
  }
  if (convergence && Math.abs(convergence.stressChange) > STRESS_CONVERGENCE_LIMIT) {
    notes.push({ level: 'warn', text: `Пиковое напряжение изменилось на ${formatPercent(convergence.stressChange)} при укрупнении ячейки в 1,5 раза: по сетке не сошлось. Ближайшая причина: острый внутренний угол или радиус меньше 5 ячеек.` });
  }
  if (s.rawPeakMises_pa > RAW_PEAK_RATIO * s.theories.IV.peakEquivalent_pa) {
    notes.push({ level: 'warn', text: `У закрепления или площадки нагрузки напряжение по теории IV достигает ${formatNumber(s.rawPeakMises_pa / MPA, 3)} МПа в точке ${pointText(s.rawPeakPoint_m)}; зона в один слой ячеек исключена из определения пика.` });
  }
  return {
    primaryId: primary,
    mass_kg: s.mass_kg,
    maxDisplacement_mm: s.maxDisplacement_m * MM_PER_M,
    displacementPoint_m: s.maxDisplacementPoint_m,
    peakStress_mpa: primaryEntry.peakEquivalent_pa / MPA,
    peakPoint_m: primaryEntry.peakPoint_m,
    safety,
    requiredSafety,
    passes: safety >= requiredSafety,
    theories,
    contradictions: s.contradictions.map((c) => describeContradiction(c, requiredSafety)),
    notes,
    control: {
      converged: solve.status.converged,
      iterations: solve.status.iterations,
      residual: solve.status.relativeResidual,
      equilibrium: s.equilibriumError,
      cells: s.activeCells,
      dofs: s.freeDofs,
      levels: s.levels,
      cell_mm: resolution.cell_m.map((h) => h * MM_PER_M),
      cellsAcrossThinnest: resolution.cellsAcrossThinnest,
      cellsPerSmallestRadius: resolution.cellsPerSmallestRadius,
      convergence,
      applied_n: s.applied_n,
      reaction_n: s.reaction_n,
      work_j: s.work_j,
      patch: s.patches[0],
      supportNodes: s.supportNodes,
    },
  };
}

function describeContradiction(c, requiredSafety) {
  const na = formatSafety(c.na);
  const nb = formatSafety(c.nb);
  if (c.kind === 'verdict') {
    return `Теории ${c.a} и ${c.b} дают разные выводы при требуемом запасе ${formatNumber(requiredSafety, 3)}: запасы ${na} и ${nb}.`;
  }
  const spread = Math.abs(c.na - c.nb) / Math.min(c.na, c.nb);
  return `Запасы по теориям ${c.a} и ${c.b} различаются на ${formatPercent(spread)}: ${na} и ${nb}.`;
}
