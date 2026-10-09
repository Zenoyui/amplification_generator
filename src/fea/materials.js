// Material library. Every record names the source of its numbers.
// basis: 'min' standard minimum, 'typical' catalog typical value, 'estimate' value without a located source.

const MPA = 1e6;
const GPA = 1e9;

export const MATERIALS = [
  {
    id: 's235',
    name: 'Сталь S235 (EN 10025-2)',
    kind: 'ductile',
    youngs_pa: 210 * GPA,
    poisson: 0.3,
    density_kgpm3: 7850,
    yield_pa: 235 * MPA,
    tensile_pa: 360 * MPA,
    compressive_pa: 235 * MPA,
    strengthBasis: 'min',
    strengthSource: 'EN 10025-2: Re = 235 МПа при толщине до 16 мм; Rm = 360-510 МПа, принят минимум',
    elasticSource: 'EN 1993-1-1, п. 3.2.6: E = 210 ГПа, nu = 0,3, плотность 7850 кг/м3',
    estimates: [],
  },
  {
    id: 'steel45',
    name: 'Сталь 45, нормализация (ГОСТ 1050-2013)',
    kind: 'ductile',
    youngs_pa: 200 * GPA,
    poisson: 0.3,
    density_kgpm3: 7850,
    yield_pa: 355 * MPA,
    tensile_pa: 600 * MPA,
    compressive_pa: 355 * MPA,
    strengthBasis: 'min',
    strengthSource: 'ГОСТ 1050-2013, нормализация: предел текучести 355 МПа, временное сопротивление 600 МПа',
    elasticSource: 'E = 200 ГПа, середина диапазона 190-210 ГПа справочника TotalMateria',
    estimates: ['коэффициент Пуассона', 'плотность'],
  },
  {
    id: 'aisi304',
    name: 'Нержавеющая сталь AISI 304 (ASTM A240)',
    kind: 'ductile',
    youngs_pa: 200 * GPA,
    poisson: 0.29,
    density_kgpm3: 7900,
    yield_pa: 205 * MPA,
    tensile_pa: 515 * MPA,
    compressive_pa: 205 * MPA,
    strengthBasis: 'min',
    strengthSource: 'ASTM A240: Rp0,2 не менее 205 МПа, Rm не менее 515 МПа',
    elasticSource: 'справочные данные ATI: E около 200 ГПа, плотность 7900 кг/м3; коэффициент Пуассона 0,28-0,30',
    estimates: [],
  },
  {
    id: 'al6061t6',
    name: 'Алюминиевый сплав 6061-T6',
    kind: 'ductile',
    youngs_pa: 68.9 * GPA,
    poisson: 0.33,
    density_kgpm3: 2700,
    yield_pa: 276 * MPA,
    tensile_pa: 310 * MPA,
    compressive_pa: 276 * MPA,
    strengthBasis: 'typical',
    strengthSource: 'ASM Material Data Sheet (AA, типовые значения): 276 и 310 МПа; минимумы по другим источникам 240 и 290 МПа',
    elasticSource: 'ASM Material Data Sheet: E = 68,9 ГПа; плотность 2,70 г/см3',
    estimates: ['коэффициент Пуассона'],
  },
  {
    id: 'al7075t6',
    name: 'Алюминиевый сплав 7075-T6',
    kind: 'ductile',
    youngs_pa: 71.7 * GPA,
    poisson: 0.33,
    density_kgpm3: 2810,
    yield_pa: 503 * MPA,
    tensile_pa: 572 * MPA,
    compressive_pa: 503 * MPA,
    strengthBasis: 'typical',
    strengthSource: 'ASM Material Data Sheet (AA, типовые значения): 503 и 572 МПа; для толстых плит значения ниже',
    elasticSource: 'ASM Material Data Sheet: E = 71,7 ГПа, nu = 0,33; плотность 2,81 г/см3',
    estimates: [],
  },
  {
    id: 'ti6al4v',
    name: 'Титановый сплав Ti-6Al-4V, отожженный',
    kind: 'ductile',
    youngs_pa: 113.8 * GPA,
    poisson: 0.33,
    density_kgpm3: 4430,
    yield_pa: 880 * MPA,
    tensile_pa: 950 * MPA,
    compressive_pa: 880 * MPA,
    strengthBasis: 'typical',
    strengthSource: 'справочник поставщика (Ulbrich), отожженное состояние: Rp0,2 880 МПа, Rm 950 МПа, типовые значения',
    elasticSource: 'E = 113,8 ГПа, плотность 4,43 г/см3 (Ulbrich); коэффициент Пуассона 0,32-0,342 по разным источникам',
    estimates: ['коэффициент Пуассона'],
  },
  {
    id: 'castiron30',
    name: 'Серый чугун, класс 30 (ASTM A48)',
    kind: 'brittle',
    youngs_pa: 96.5 * GPA,
    poisson: 0.26,
    density_kgpm3: 7200,
    yield_pa: 0,
    tensile_pa: 214 * MPA,
    compressive_pa: 752 * MPA,
    strengthBasis: 'typical',
    strengthSource: 'ASTM A48 класс 30: предел прочности при растяжении 214 МПа (31 ksi), при сжатии 752 МПа (109 ksi)',
    elasticSource: 'E = 96,5 ГПа (14 Mpsi); другие источники дают до 180 ГПа',
    estimates: ['коэффициент Пуассона'],
  },
  {
    id: 'pla',
    name: 'Полилактид PLA (Ingeo 3D850, объемный образец)',
    kind: 'ductile',
    youngs_pa: 2.315 * GPA,
    poisson: 0.36,
    density_kgpm3: 1240,
    yield_pa: 51 * MPA,
    tensile_pa: 50 * MPA,
    compressive_pa: 51 * MPA,
    strengthBasis: 'typical',
    strengthSource: 'паспорт NatureWorks Ingeo 3D850 (ASTM D638, D792): предел текучести 51 МПа, E = 2315 МПа, плотность 1240 кг/м3',
    elasticSource: 'печатный образец анизотропен, его прочность вдоль слоев ниже; значения даны для объемного материала',
    estimates: ['коэффициент Пуассона'],
  },
  {
    id: 'abs',
    name: 'Сополимер ABS (литьевой, BADALAC ABS 20)',
    kind: 'ductile',
    youngs_pa: 2.3 * GPA,
    poisson: 0.35,
    density_kgpm3: 1050,
    yield_pa: 45 * MPA,
    tensile_pa: 45 * MPA,
    compressive_pa: 45 * MPA,
    strengthBasis: 'typical',
    strengthSource: 'паспорт BADALAC ABS 20 (ISO 527): предел текучести 45 МПа, модуль растяжения 2300 МПа',
    elasticSource: 'плотность и коэффициент Пуассона не найдены в паспорте',
    estimates: ['коэффициент Пуассона', 'плотность'],
  },
];

export function findMaterial(id) {
  const material = MATERIALS.find((m) => m.id === id);
  if (!material) throw new Error(`material unknown (id=${id})`);
  return material;
}

// Limit stresses used by theories: tension limit and compression limit, Pa
export function limitStresses(material) {
  if (material.kind === 'ductile') return { tension_pa: material.yield_pa, compression_pa: material.yield_pa };
  return { tension_pa: material.tensile_pa, compression_pa: material.compressive_pa };
}

// Range checks for user-entered materials; returns list of messages, empty when acceptable
export function checkMaterial(material) {
  const problems = [];
  const positive = (key, label) => {
    if (!(material[key] > 0) || !Number.isFinite(material[key])) problems.push(`${label}: требуется число больше нуля`);
  };
  positive('youngs_pa', 'модуль упругости');
  positive('density_kgpm3', 'плотность');
  positive('tensile_pa', 'предел прочности при растяжении');
  positive('compressive_pa', 'предел прочности при сжатии');
  if (material.kind === 'ductile') positive('yield_pa', 'предел текучести');
  if (!(material.poisson > 0 && material.poisson < 0.5)) problems.push('коэффициент Пуассона: требуется значение от 0 до 0,5');
  return problems;
}
