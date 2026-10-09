// Parameter specs: ranges, defaults, conversion of display units to meters

import { Quantity } from '../si/units.js';

// Spec: { key, label, unit, default, min, max } for numbers (display unit, usually mm),
// or { key, label, type: 'enum', options: [{ value, label }], default } for choices.
// Keys of numeric specs end with _m: resolved values are meters.

export function numberSpec(key, label, defaultValue, min, max, unit = 'mm') {
  return { key, label, unit, default: defaultValue, min, max };
}

export function enumSpec(key, label, options, defaultValue) {
  return { key, label, type: 'enum', options, default: defaultValue };
}

// Resolves raw values (display units) into SI values. Missing keys take defaults.
// Returns { values, errors } where errors list { key, label, message }.
export function resolveParams(specs, raw) {
  const values = {};
  const errors = [];
  for (const spec of specs) {
    const given = raw && Object.prototype.hasOwnProperty.call(raw, spec.key) ? raw[spec.key] : spec.default;
    if (spec.type === 'enum') {
      if (!spec.options.some((o) => o.value === given)) {
        errors.push({ key: spec.key, label: spec.label, message: 'значение вне списка' });
        values[spec.key] = spec.default;
        continue;
      }
      values[spec.key] = given;
      continue;
    }
    const amount = Number(given);
    if (!Number.isFinite(amount)) {
      errors.push({ key: spec.key, label: spec.label, message: 'требуется число' });
      values[spec.key] = Quantity.of(spec.default, spec.unit).in('m');
      continue;
    }
    if (amount < spec.min || amount > spec.max) {
      errors.push({
        key: spec.key,
        label: spec.label,
        message: `значение вне диапазона ${spec.min}-${spec.max} ${spec.unit}`,
      });
    }
    values[spec.key] = Quantity.of(amount, spec.unit).in('m');
  }
  return { values, errors };
}

// Display-unit defaults for the UI
export function defaultsOf(specs) {
  return Object.fromEntries(specs.map((spec) => [spec.key, spec.default]));
}

// Meters back to the display unit of a spec
export function toDisplay(spec, value_m) {
  return Quantity.of(value_m, 'm').in(spec.unit);
}
