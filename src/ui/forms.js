// Form rows built from parameter specs

import { el, uniqueId } from './dom.js';
import { unitLabel } from './format.js';

// Text input row: label, input, unit, error line. Returns { row, input, setError }.
export function inputRow({ label, unit, text, onInput, wide = false, hint = null, inputMode = 'decimal' }) {
  const id = uniqueId('field');
  const errorLine = el('p', { class: 'field-error', hidden: true, id: `${id}-error` });
  const input = el('input', { type: 'text', id, value: text, inputmode: inputMode, autocomplete: 'off', 'aria-describedby': `${id}-error` });
  input.addEventListener('input', () => onInput(input.value));
  const row = el(
    'div',
    { class: wide ? 'field wide' : 'field' },
    el('label', { for: id }, label),
    input,
    wide ? null : el('span', { class: 'unit' }, unitLabel(unit)),
    errorLine,
  );
  if (hint) row.after(el('p', { class: 'hint' }, hint));
  return {
    row,
    input,
    setError(message) {
      errorLine.hidden = !message;
      errorLine.textContent = message || '';
      input.setAttribute('aria-invalid', message ? 'true' : 'false');
    },
  };
}

// Select row. options: [{ value, label }]
export function selectRow({ label, options, selected, onChange }) {
  const id = uniqueId('select');
  const select = el('select', { id }, options.map((o) => el('option', { value: o.value, selected: o.value === selected }, o.label)));
  select.addEventListener('change', () => onChange(select.value));
  return { row: el('div', { class: 'field wide' }, el('label', { for: id }, label), select), select };
}

export function checkRow({ label, checked, onChange }) {
  const id = uniqueId('check');
  const input = el('input', { type: 'checkbox', id, checked });
  input.addEventListener('change', () => onChange(input.checked));
  return { row: el('div', { class: 'check' }, input, el('label', { for: id }, label)), input };
}

export function radioList({ name, options, selected, onChange }) {
  const group = el('fieldset', { class: 'choice-list' });
  for (const option of options) {
    const input = el('input', { type: 'radio', name, value: option.value, checked: option.value === selected });
    input.addEventListener('change', () => input.checked && onChange(option.value));
    group.append(el('label', {}, input, el('span', {}, option.label)));
  }
  return group;
}
