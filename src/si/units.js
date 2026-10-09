// SI dimensions, quantities, unit table, text parser

export class SiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'SiError';
    this.details = details;
  }
}

const BASE_SYMBOLS = ['m', 'kg', 's', 'A', 'K', 'mol', 'cd'];

class Dim {
  constructor(exponents) {
    if (exponents.length !== BASE_SYMBOLS.length || !exponents.every(Number.isInteger)) {
      throw new SiError('bad dim (need 7 integer exponents)', { exponents });
    }
    this.exponents = Object.freeze([...exponents]);
  }

  times(other) {
    return new Dim(this.exponents.map((e, i) => e + other.exponents[i]));
  }

  over(other) {
    return new Dim(this.exponents.map((e, i) => e - other.exponents[i]));
  }

  pow(n) {
    return new Dim(this.exponents.map((e) => e * n));
  }

  equals(other) {
    return this.exponents.every((e, i) => e === other.exponents[i]);
  }

  toString() {
    const named = NAMED_DIMS.find((entry) => entry.dim.equals(this));
    if (named) return named.name;
    const parts = this.exponents
      .map((e, i) => (e === 0 ? '' : e === 1 ? BASE_SYMBOLS[i] : `${BASE_SYMBOLS[i]}^${e}`))
      .filter(Boolean);
    return parts.length ? parts.join('*') : '1';
  }
}

const dimOf = (m, kg, s) => new Dim([m, kg, s, 0, 0, 0, 0]);

export const DIM = Object.freeze({
  NONE: dimOf(0, 0, 0),
  LENGTH: dimOf(1, 0, 0),
  MASS: dimOf(0, 1, 0),
  TIME: dimOf(0, 0, 1),
  AREA: dimOf(2, 0, 0),
  VOLUME: dimOf(3, 0, 0),
  FORCE: dimOf(1, 1, -2),
  PRESSURE: dimOf(-1, 1, -2),
  ACCELERATION: dimOf(1, 0, -2),
  DENSITY: dimOf(-3, 1, 0),
  ENERGY: dimOf(2, 1, -2),
});

const NAMED_DIMS = [
  { name: 'length', dim: DIM.LENGTH },
  { name: 'mass', dim: DIM.MASS },
  { name: 'time', dim: DIM.TIME },
  { name: 'area', dim: DIM.AREA },
  { name: 'volume', dim: DIM.VOLUME },
  { name: 'force', dim: DIM.FORCE },
  { name: 'pressure', dim: DIM.PRESSURE },
  { name: 'acceleration', dim: DIM.ACCELERATION },
  { name: 'density', dim: DIM.DENSITY },
  { name: 'energy', dim: DIM.ENERGY },
  { name: 'dimensionless', dim: DIM.NONE },
];

// Standard gravity, 3rd CGPM 1901
export const STANDARD_GRAVITY_MPS2 = 9.80665;

// factor: multiplier to SI; aliases: written forms accepted by the parser
const UNIT_TABLE = [
  { symbol: 'm', dim: DIM.LENGTH, factor: 1, aliases: ['m', 'м'] },
  { symbol: 'mm', dim: DIM.LENGTH, factor: 1e-3, aliases: ['mm', 'мм'] },
  { symbol: 'cm', dim: DIM.LENGTH, factor: 1e-2, aliases: ['cm', 'см'] },
  { symbol: 'kg', dim: DIM.MASS, factor: 1, aliases: ['kg', 'кг'] },
  { symbol: 'g', dim: DIM.MASS, factor: 1e-3, aliases: ['g', 'г'] },
  { symbol: 't', dim: DIM.MASS, factor: 1e3, aliases: ['t', 'т'] },
  { symbol: 'N', dim: DIM.FORCE, factor: 1, aliases: ['N', 'Н'] },
  { symbol: 'kN', dim: DIM.FORCE, factor: 1e3, aliases: ['kN', 'кН'] },
  { symbol: 'kgf', dim: DIM.FORCE, factor: STANDARD_GRAVITY_MPS2, aliases: ['kgf', 'кгс'] },
  { symbol: 'Pa', dim: DIM.PRESSURE, factor: 1, aliases: ['Pa', 'Па'] },
  { symbol: 'kPa', dim: DIM.PRESSURE, factor: 1e3, aliases: ['kPa', 'кПа'] },
  { symbol: 'MPa', dim: DIM.PRESSURE, factor: 1e6, aliases: ['MPa', 'МПа'] },
  { symbol: 'GPa', dim: DIM.PRESSURE, factor: 1e9, aliases: ['GPa', 'ГПа'] },
  { symbol: 's', dim: DIM.TIME, factor: 1, aliases: ['s', 'с'] },
  { symbol: 'm/s2', dim: DIM.ACCELERATION, factor: 1, aliases: ['m/s2', 'м/с2'] },
  { symbol: 'kg/m3', dim: DIM.DENSITY, factor: 1, aliases: ['kg/m3', 'кг/м3'] },
  { symbol: 'g/cm3', dim: DIM.DENSITY, factor: 1e3, aliases: ['g/cm3', 'г/см3'] },
  { symbol: 'J', dim: DIM.ENERGY, factor: 1, aliases: ['J', 'Дж'] },
  { symbol: 'rad', dim: DIM.NONE, factor: 1, aliases: ['rad', 'рад'] },
  { symbol: 'deg', dim: DIM.NONE, factor: Math.PI / 180, aliases: ['deg', 'град'] },
];

const UNIT_BY_ALIAS = new Map();
for (const unit of UNIT_TABLE) {
  for (const alias of unit.aliases) UNIT_BY_ALIAS.set(alias, unit);
}

function findUnit(text) {
  const unit = UNIT_BY_ALIAS.get(text);
  if (!unit) throw new SiError(`unit unknown (text=${text})`, { text });
  return unit;
}

export class Quantity {
  // siValue: number in SI base units
  constructor(siValue, dim) {
    if (!Number.isFinite(siValue)) throw new SiError('quantity not finite', { siValue });
    this.si = siValue;
    this.dim = dim;
  }

  static of(amount, unitText) {
    const unit = findUnit(unitText);
    return new Quantity(amount * unit.factor, unit.dim);
  }

  plus(other) {
    this.#sameDim(other);
    return new Quantity(this.si + other.si, this.dim);
  }

  minus(other) {
    this.#sameDim(other);
    return new Quantity(this.si - other.si, this.dim);
  }

  times(other) {
    if (typeof other === 'number') return new Quantity(this.si * other, this.dim);
    return new Quantity(this.si * other.si, this.dim.times(other.dim));
  }

  over(other) {
    if (typeof other === 'number') return new Quantity(this.si / other, this.dim);
    return new Quantity(this.si / other.si, this.dim.over(other.dim));
  }

  pow(n) {
    return new Quantity(this.si ** n, this.dim.pow(n));
  }

  // amount in the given unit; throws when dimensions differ
  in(unitText) {
    const unit = findUnit(unitText);
    if (!unit.dim.equals(this.dim)) {
      throw new SiError(`unit mismatch (want=${unit.dim}, got=${this.dim})`, {
        want: unit.dim.toString(),
        got: this.dim.toString(),
      });
    }
    return this.si / unit.factor;
  }

  #sameDim(other) {
    if (!this.dim.equals(other.dim)) {
      throw new SiError(`unit mismatch (want=${this.dim}, got=${other.dim})`);
    }
  }
}

const NUMBER_PATTERN = /^\s*([+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:[eE][+-]?\d+)?)\s*(\S*)\s*$/;

// Parses "12.5 mm", "12,5мм", "50 кг". A bare number takes defaultUnit.
export function parseQuantity(text, defaultUnit) {
  const match = NUMBER_PATTERN.exec(String(text));
  if (!match) throw new SiError(`number expected (text=${String(text).slice(0, 32)})`);
  const amount = Number(match[1].replace(',', '.'));
  return Quantity.of(amount, match[2] === '' ? defaultUnit : match[2]);
}

