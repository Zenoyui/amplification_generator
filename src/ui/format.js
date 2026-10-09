// Number formatting for user-visible text: decimal comma, no digit grouping

export function formatNumber(amount, digits = 3) {
  if (!Number.isFinite(amount)) return amount > 0 ? 'более 100' : 'нет данных';
  if (Math.abs(amount) < Number.MIN_VALUE * 1e10) return '0';
  const magnitude = Math.abs(amount);
  if (magnitude >= 1e5 || magnitude < 1e-3) return amount.toExponential(Math.max(0, digits - 1)).replace('.', ',');
  const decimals = Math.max(0, digits - 1 - Math.floor(Math.log10(magnitude)));
  return amount.toFixed(Math.min(decimals, 6)).replace('.', ',');
}

export const formatPercent = (ratio) => `${(ratio * 100).toFixed(1).replace('.', ',')} %`;

// Safety factors above this are shown as a bound
const SAFETY_DISPLAY_LIMIT = 100;
export const formatSafety = (n) => (n > SAFETY_DISPLAY_LIMIT ? 'более 100' : formatNumber(n, 3));

// Display text of unit symbols used in parameter specs
const UNIT_LABELS = { mm: 'мм', kg: 'кг', N: 'Н', MPa: 'МПа', GPa: 'ГПа' };
export const unitLabel = (symbol) => UNIT_LABELS[symbol] ?? symbol;
