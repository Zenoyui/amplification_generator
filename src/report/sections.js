// Text of the calculation document. Every function draws on a Typesetter. Style: short factual sentences.

import { THEORIES } from '../fea/criteria.js';
import { formatNumber, formatSafety, formatPercent } from '../ui/format.js';
import { FIELD_RAMP, hexToRgb } from '../ui/tokens.js';
import { BLACK } from './pdf.js';

const MM = 1000;
const MPA = 1e6;
const point = (p) => (p ? `(${p.map((v) => formatNumber(v * MM, 3)).join('; ')}) мм` : 'нет данных');
const vector = (v) => `(${v.map((c) => formatNumber(c, 3)).join('; ')})`;

const BIBLIOGRAPHY = [
  'Parvizian J., Duster A., Rank E. Finite cell method: h- and p-extension for embedded domain problems in solid mechanics. Computational Mechanics, 2007, vol. 41, no. 1, pp. 121-133.',
  'Amir O., Aage N., Lazarov B.S. On multigrid-CG for efficient topology optimization. Structural and Multidisciplinary Optimization, 2014, vol. 49, no. 5, pp. 815-829.',
  'Taylor R.L., Beresford P.J., Wilson E.L. A non-conforming element for stress analysis. International Journal for Numerical Methods in Engineering, 1976, vol. 10, pp. 1211-1219.',
  'Peterson R.E. Stress concentration factors. New York: Wiley, 1974 (пластина с круглым отверстием, коэффициент Ktn).',
  'Kirsch G. Die Theorie der Elastizitat und die Bedurfnisse der Festigkeitslehre. Zeitschrift des Vereines deutscher Ingenieure, 1898, vol. 42, pp. 797-807.',
  'Timoshenko S.P. On the correction for shear of the differential equation for transverse vibrations of prismatic bars. Philosophical Magazine, 1921, series 6, vol. 41, pp. 744-746.',
];

const STANDARDS = [
  ['ГОСТ 8.417-2002', 'Государственная система обеспечения единства измерений. Единицы величин'],
];
const DRAWING_STANDARDS = [
  ['ГОСТ 2.104-2006', 'Единая система конструкторской документации. Основные надписи'],
  ['ГОСТ 2.301-68', 'Единая система конструкторской документации. Форматы'],
  ['ГОСТ 2.302-68', 'Единая система конструкторской документации. Масштабы'],
  ['ГОСТ 2.303-68', 'Единая система конструкторской документации. Линии'],
  ['ГОСТ 2.305-2008', 'Единая система конструкторской документации. Изображения - виды, разрезы, сечения'],
  ['ГОСТ 2.307-2011', 'Единая система конструкторской документации. Нанесение размеров и предельных отклонений'],
];

const MATERIAL_STANDARDS = {
  s235: [['EN 10025-2', 'Горячекатаные изделия из конструкционных сталей. Часть 2'], ['EN 1993-1-1', 'Проектирование стальных конструкций. Общие правила']],
  steel45: [['ГОСТ 1050-2013', 'Металлопродукция из нелегированных конструкционных качественных и специальных сталей']],
  aisi304: [['ASTM A240', 'Plate, sheet, and strip of chromium and chromium-nickel stainless steel']],
  castiron30: [['ASTM A48', 'Gray iron castings']],
};

// Cover, preface and contents are drawn by cover.js; this file holds sections 1-10, appendix text and lists.

export function writeScope(ts, ctx) {
  ts.heading(1, '1', 'Область применения');
  ts.paragraph(`Документ содержит результаты статического расчета на прочность изделия "${ctx.templateName}" при заданной нагрузке: перемещения, напряжения и запасы прочности по пяти теориям прочности.`);
  if (ctx.baseline) ts.paragraph(`Расчет выполнен для исходного изделия и для изделия с усилениями. Сопоставление приведено в разделе ${ctx.section.comparison}.`);
  if (ctx.withDrawings) ts.paragraph('Приложение А содержит чертежи изделия в проекциях и в аксонометрии.');
  ts.paragraph(`Границы применимости результатов: раздел ${ctx.section.limitations}.`);
}

export function writeReferences(ts, ctx) {
  ts.heading(1, '2', 'Нормативные ссылки');
  ts.paragraph('В настоящем документе использованы ссылки на следующие стандарты:', { indent: 12.5 });
  const list = [...STANDARDS, ...(MATERIAL_STANDARDS[ctx.material.id] ?? []), ...(ctx.withDrawings ? DRAWING_STANDARDS : [])];
  for (const [code, title] of list) ts.paragraph(`${code} ${title}`, { indent: 12.5, justify: false, after: 0.5 });
  ts.space(1.5);
}

export function writeTerms(ts) {
  ts.heading(1, '3', 'Термины и определения');
  ts.paragraph('В настоящем документе применены следующие термины с соответствующими определениями:');
  const terms = [
    ['эквивалентное напряжение', 'скалярная величина, вычисленная из главных напряжений по теории прочности и сравниваемая с предельным напряжением материала.'],
    ['предельное напряжение', 'предел текучести для пластичного материала; пределы прочности при растяжении и при сжатии для хрупкого материала.'],
    ['запас прочности', 'отношение предельного напряжения к эквивалентному напряжению в наиболее нагруженной точке.'],
    ['площадка нагрузки', 'круговая область поверхности, по которой распределена приложенная сила.'],
    ['закрепление', 'множество узлов сетки с нулевыми перемещениями.'],
    ['усиление', 'добавленный к изделию элемент формы: ребро, косынка, скругление, бобышка или бортик.'],
    ['ячейка', 'прямоугольный объем расчетной сетки, в котором определена жесткость материала.'],
  ];
  terms.forEach(([term, definition], i) => ts.paragraph(`3.${i + 1}  **${term}:** ${definition}`));
}

export function writeInput(ts, ctx) {
  ts.heading(1, '4', 'Исходные данные');
  ts.heading(2, '4.1', 'Изделие');
  ts.paragraph(`Изделие: ${ctx.templateName}. Размеры - в таблице ${ts.tableCount + 1}. Система единиц: СИ (ГОСТ 8.417-2002); размеры в миллиметрах.`);
  ts.table({
    columns: [{ width: 90 }, { width: 50, align: 'right' }, { width: 30 }],
    header: ['Размер', 'Значение', 'Единица'],
    rows: ctx.baseRows.map((r) => [r.label, r.value, r.unit]),
    caption: 'Размеры изделия',
  });
  ts.paragraph(`Масса изделия по сетке: ${formatNumber(ctx.summary.mass_kg * MM, 4)} г.`);

  ts.heading(2, '4.2', 'Материал');
  const m = ctx.material;
  ts.paragraph(`Материал: ${m.name}. Вид: ${m.kind === 'ductile' ? 'пластичный' : 'хрупкий'}.`);
  const rows = [
    ['Модуль упругости E', formatNumber(m.youngs_pa / 1e9, 4), 'ГПа'],
    ['Коэффициент Пуассона', formatNumber(m.poisson, 3), ''],
    ['Плотность', formatNumber(m.density_kgpm3, 4), 'кг/м3'],
  ];
  if (m.kind === 'ductile') rows.push(['Предел текучести (при растяжении и сжатии)', formatNumber(m.yield_pa / MPA, 4), 'МПа']);
  else rows.push(['Предел прочности при растяжении', formatNumber(m.tensile_pa / MPA, 4), 'МПа'], ['Предел прочности при сжатии', formatNumber(m.compressive_pa / MPA, 4), 'МПа']);
  ts.table({ columns: [{ width: 90 }, { width: 50, align: 'right' }, { width: 30 }], header: ['Характеристика', 'Значение', 'Единица'], rows, caption: 'Характеристики материала' });
  const basis = { min: 'минимальные значения стандарта', typical: 'типовые значения каталога, не гарантированные минимумы', estimate: 'значения заданы без источника' }[m.strengthBasis];
  ts.paragraph(`Источник прочностных характеристик: ${m.strengthSource}. Основание: ${basis}.`);
  ts.paragraph(`Источник упругих характеристик: ${m.elasticSource}.`);
  if (m.estimates.length) ts.paragraph(`Оценочные значения без найденного первоисточника: ${m.estimates.join(', ')}.`);

  ts.heading(2, '4.3', 'Нагрузки и закрепления');
  const load = ctx.load;
  const loadRows = [
    [
      'Сосредоточенная сила на круговой площадке',
      `точка ${point(load.point_m)}; радиус площадки ${formatNumber(ctx.summary.control.patch.radius_m * MM, 3)} мм`,
      `${formatNumber(load.magnitude_n, 4)} Н${load.massKg ? ` (масса ${formatNumber(load.massKg, 4)} кг, g = 9,80665 м/с2)` : ''}`,
      `вектор ${vector(load.direction)}`,
    ],
  ];
  if (ctx.selfWeight) loadRows.push(['Собственный вес', 'объем изделия', `${formatNumber(ctx.summary.mass_kg * 9.80665, 4)} Н`, 'вектор (0; 0; -1)']);
  ts.table({
    columns: [{ width: 38 }, { width: 55 }, { width: 42 }, { width: 35 }],
    header: ['Вид нагрузки', 'Место приложения', 'Величина', 'Направление'],
    rows: loadRows,
    caption: 'Нагрузки',
  });
  ts.table({
    columns: [{ width: 38 }, { width: 70 }, { width: 62 }],
    header: ['Вид связи', 'Место', 'Условие'],
    rows: ctx.supports.map((s) => ['Закрепление', s, 'нулевые перемещения узлов в трех направлениях']),
    caption: 'Закрепления',
  });

  ts.heading(2, '4.4', 'Усиления');
  if (ctx.features.length === 0) ts.paragraph('Усиления не заданы.');
  else {
    ts.table({
      columns: [{ width: 55 }, { width: 115 }],
      header: ['Усиление', 'Размеры'],
      rows: ctx.features.map((f) => [f.name, f.text]),
      caption: 'Усиления',
    });
  }
  ts.heading(2, '4.5', 'Требуемый запас прочности');
  ts.paragraph(`Требуемый запас прочности задан равным ${formatNumber(ctx.summary.requiredSafety, 3)}.`);
}

export function writeModel(ts, ctx) {
  ts.heading(1, '5', 'Расчетная модель');
  ts.heading(2, '5.1', 'Метод');
  ts.paragraph('Метод конечных элементов, линейная упругость, малые перемещения, статическое нагружение. Элемент: прямоугольный восьмиузловой с девятью несогласованными модами (Taylor, Beresford, Wilson [3]), регулярная сетка из одинаковых ячеек.');
  ts.paragraph('Граница изделия не совпадает с гранями ячеек: ячейка, пересеченная поверхностью, интегрируется по 64 подъячейкам с долей материала в каждой (метод конечных ячеек, Parvizian, Duster, Rank [1]). К пересеченным ячейкам добавлена жесткость 0,1 % от жесткости целой ячейки, чтобы узлы в пустоте оставались связанными.');
  ts.paragraph('Система уравнений решена методом сопряженных градиентов с геометрическим многосеточным предобусловливателем (Amir, Aage, Lazarov [2]); на грубейшем уровне применено прямое разложение.');
  ts.heading(2, '5.2', 'Сетка и решение');
  const c = ctx.summary.control;
  ts.table({
    columns: [{ width: 105 }, { width: 65, align: 'right' }],
    header: ['Показатель', 'Значение'],
    rows: [
      ['Размер ячейки, мм', c.cell_mm.map((h) => formatNumber(h, 3)).join(' x ')],
      ['Ячеек с материалом', String(c.cells)],
      ['Степеней свободы', String(c.dofs)],
      ['Уровней многосеточного решателя', String(c.levels)],
      ['Узлов закрепления', String(c.supportNodes)],
      ['Узлов площадки нагрузки', String(c.patch.nodes)],
      ['Итераций сопряженных градиентов', String(c.iterations)],
      ['Относительная невязка', c.residual.toExponential(1).replace('.', ',')],
    ],
    caption: 'Сетка и решение',
  });
  ts.heading(2, '5.3', 'Допущения');
  ts.list([
    'материал изотропный и однородный;',
    'перемещения малы, геометрия не меняется при нагружении;',
    'закрепление абсолютно жесткое, контакт и трение не учтены;',
    'сила распределена по круговой площадке с законом cos^2 от радиуса;',
    'собственный вес распределен по объему, направление: вниз по оси Z.',
  ]);
}

export function writeCriteria(ts, ctx) {
  const m = ctx.material;
  const tension = m.kind === 'ductile' ? m.yield_pa : m.tensile_pa;
  const compression = m.kind === 'ductile' ? m.yield_pa : m.compressive_pa;
  ts.heading(1, '6', 'Критерии прочности');
  ts.paragraph(`Главные напряжения s1 >= s2 >= s3. Предельное напряжение при растяжении ${formatNumber(tension / MPA, 4)} МПа, при сжатии ${formatNumber(compression / MPA, 4)} МПа. Для пластичного материала расчетными приняты теории III и IV, для хрупкого - I, II и V.`);
  ts.table({
    columns: [{ width: 20 }, { width: 75 }, { width: 55 }, { width: 20 }],
    header: ['Теория', 'Название', 'Эквивалентное напряжение', 'Роль'],
    rows: THEORIES.map((t) => [t.id, t.name, t.formula, ctx.summary.theories.find((x) => x.id === t.id).role]),
    caption: 'Теории прочности',
  });
  ts.paragraph(`Запас прочности по теориям II, III, IV и V: предельное напряжение при растяжении, деленное на эквивалентное. По теории I: меньшее из отношений предела при растяжении к s1 и предела при сжатии к |s3|. Определяющая теория для вывода: ${ctx.summary.primaryId}.`);
}

export function writeResults(ts, ctx, figures) {
  const s = ctx.summary;
  ts.heading(1, '7', 'Результаты расчета');
  ts.heading(2, '7.1', 'Основные результаты');
  const rows = [
    ['Максимальное перемещение', `${formatNumber(s.maxDisplacement_mm, 4)} мм в точке ${point(s.displacementPoint_m)}`],
    [`Наибольшее эквивалентное напряжение (теория ${s.primaryId})`, `${formatNumber(s.peakStress_mpa, 4)} МПа в точке ${point(s.peakPoint_m)}`],
    ['Запас прочности', formatSafety(s.safety)],
  ];
  if (s.rawAbove) {
    rows.push(['Напряжение (теория IV) у закрепления или площадки без исключения зоны', `${formatNumber(s.rawPeak_mpa, 4)} МПа в точке ${point(s.rawPeakPoint_m)}`]);
    rows.push(['Запас по этому напряжению', s.rawSafety === null ? 'нет данных' : formatSafety(s.rawSafety)]);
  }
  rows.push(['Требуемый запас прочности', formatNumber(s.requiredSafety, 3)]);
  ts.table({ columns: [{ width: 85 }, { width: 85 }], header: ['Показатель', 'Значение'], rows, caption: 'Основные результаты' });
  if (!s.valid) ts.paragraph(`Вывод о прочности не сформирован: ${s.invalidReason}.`);
  else ts.paragraph(`Условие прочности по теории ${s.primaryId}: запас ${formatSafety(s.safety)} при требуемом ${formatNumber(s.requiredSafety, 3)} - **${s.passes ? 'выполнено.' : 'не выполнено.'}**`);
  ts.heading(2, '7.2', 'Поля перемещений, напряжений и запаса прочности');
  ts.paragraph('Поля приведены на поверхности изделия. Область вокруг закрепления и площадки нагрузки (один слой ячеек) исключена из определения наибольшего напряжения.');
  for (const figure of figures) {
    ts.figure({ image: figure.image, widthMm: figure.widthMm, heightMm: figure.heightMm, caption: figure.caption, overlay: figure.overlay });
  }
  ts.heading(2, '7.3', 'Сопоставление теорий прочности');
  ts.table({
    columns: [{ width: 18 }, { width: 42, align: 'right' }, { width: 30, align: 'right' }, { width: 40 }, { width: 40 }],
    header: ['Теория', 'Наибольшее эквивалентное напряжение, МПа', 'Запас прочности', 'Условие при требуемом запасе', 'Роль'],
    rows: s.theories.map((t) => [t.id, formatNumber(t.peak_mpa, 4), formatSafety(t.safety), t.passes ? 'выполнено' : 'не выполнено', t.role]),
    caption: 'Результаты по теориям прочности',
  });
  ts.heading(2, '7.4', 'Расхождения теорий');
  if (s.contradictions.length === 0) ts.paragraph('Расхождений, влияющих на вывод или превышающих 15 %, нет.');
  else ts.list(s.contradictions);
  ts.paragraph('Теории III и IV различаются в одноосном состоянии на 0 %, в чистом сдвиге на 15,5 %: теория III дает меньший запас.');
}

export function writeComparison(ts, ctx) {
  ts.heading(1, String(ctx.section.comparison), 'Сравнение с изделием без усилений');
  const a = ctx.baseline;
  const b = ctx.summary;
  const rows = [
    ['Масса, г', formatNumber(a.mass_kg * MM, 4), formatNumber(b.mass_kg * MM, 4)],
    ['Максимальное перемещение, мм', formatNumber(a.maxDisplacement_mm, 4), formatNumber(b.maxDisplacement_mm, 4)],
    [`Наибольшее эквивалентное напряжение (теория ${b.primaryId}), МПа`, formatNumber(a.peakStress_mpa, 4), formatNumber(b.peakStress_mpa, 4)],
    ['Запас прочности', formatSafety(a.safety), formatSafety(b.safety)],
    ['Напряжение у закрепления без исключения зоны (теория IV), МПа', formatNumber(a.rawPeak_mpa, 4), formatNumber(b.rawPeak_mpa, 4)],
  ].map(([name, x, y], i) => {
    const before = [a.mass_kg, a.maxDisplacement_mm, a.peakStress_mpa, a.safety, a.rawPeak_mpa][i];
    const after = [b.mass_kg, b.maxDisplacement_mm, b.peakStress_mpa, b.safety, b.rawPeak_mpa][i];
    const change = Number.isFinite(before) && Number.isFinite(after) ? formatPercent((after - before) / before) : 'нет данных';
    return [name, x, y, change];
  });
  ts.table({
    columns: [{ width: 75 }, { width: 32, align: 'right' }, { width: 32, align: 'right' }, { width: 31, align: 'right' }],
    header: ['Показатель', 'Без усилений', 'С усилениями', 'Изменение'],
    rows,
    caption: 'Сравнение вариантов',
  });
  ts.paragraph(`Усиления добавляют ${formatPercent(b.mass_kg / a.mass_kg - 1)} к массе. Условие прочности для варианта с усилениями: ${b.valid ? (b.passes ? 'выполнено' : 'не выполнено') : 'вывод не сформирован'}.`);
}

export function writeReliability(ts, ctx) {
  const c = ctx.summary.control;
  ts.heading(1, String(ctx.section.reliability), 'Достоверность результата');
  ts.heading(2, `${ctx.section.reliability}.1`, 'Контроль решения');
  const rows = [
    ['Невязка равновесия: сумма реакций и приложенных сил, отнесенная к приложенной силе', c.equilibrium.toExponential(1).replace('.', ',')],
    ['Приложенная сила, Н (x; y; z)', `(${c.applied_n.map((v) => formatNumber(v, 4)).join('; ')})`],
    ['Реакции закрепления, Н (x; y; z)', `(${c.reaction_n.map((v) => formatNumber(v, 4)).join('; ')})`],
    ['Работа внешних сил, Дж', formatNumber(c.work_j, 4)],
    ['Ячеек на наименьшую толщину', formatNumber(c.cellsAcrossThinnest, 3)],
    ['Ячеек на наименьший радиус', c.cellsPerSmallestRadius === null ? 'радиусов нет' : formatNumber(c.cellsPerSmallestRadius, 3)],
  ];
  if (c.convergence) {
    rows.push([`Изменение перемещения при укрупнении ячейки в ${formatNumber(c.convergence.ratio, 2)} раза`, formatPercent(c.convergence.displacementChange)]);
    rows.push([`Изменение пикового напряжения при укрупнении ячейки в ${formatNumber(c.convergence.ratio, 2)} раза`, formatPercent(c.convergence.stressChange)]);
  }
  ts.table({ columns: [{ width: 120 }, { width: 50, align: 'right' }], header: ['Показатель', 'Значение'], rows, caption: 'Контроль решения' });
  if (ctx.summary.notes.length) {
    ts.paragraph('Замечания к результату:', { indent: 12.5 });
    ts.list(ctx.summary.notes.map((n) => n.text));
  } else ts.paragraph('Замечаний к решению нет.');
  ts.heading(2, `${ctx.section.reliability}.2`, 'Проверка метода на эталонных задачах');
  ts.table({
    columns: [{ width: 62 }, { width: 58 }, { width: 50 }],
    header: ['Задача', 'Эталон', 'Отклонение метода'],
    rows: [
      ['Консольный брус, сила через площадку на торце, L/h = 20, грани по линиям сетки, 3-8 ячеек по высоте', 'Эйлер-Бернулли с поправкой Тимошенко [6]', 'от -1,6 до -0,8 % по прогибу'],
      ['Тот же брус, грани не совпадают с линиями сетки, 3-8 ячеек по высоте', 'то же', 'от -3,3 до -1,1 % по прогибу'],
      ['Брус под собственным весом', 'w L^4 / (8 E I)', 'до 3 % по прогибу'],
      ['Пластина с отверстием, 2,7 ячейки на радиус', 'Ktn по Peterson [4]; для бесконечной пластины 3 по Kirsch [5]', '-26 % по пиковому напряжению'],
      ['Пластина с отверстием, 4,3 ячейки на радиус', 'Ktn по Peterson [4]', '-17 % по пиковому напряжению'],
      ['Пластина с отверстием, 6,4 ячейки на радиус', 'Ktn по Peterson [4]', '-3,4 % по пиковому напряжению'],
    ],
    caption: 'Эталонные задачи',
  });
  ts.paragraph('Пиковое напряжение на криволинейной границе занижено при радиусе менее 6 ячеек; перемещения сходятся быстрее. Острый внутренний угол дает неограниченно растущее напряжение при измельчении ячейки (сингулярность): значение зависит от размера ячейки.');
}

export function writeLimitations(ts, ctx) {
  ts.heading(1, String(ctx.section.limitations), 'Ограничения');
  ts.list([
    'Расчет линейный: пластическое течение, потеря устойчивости, контакт, усталость, удар, температура и ползучесть не учтены.',
    'Нагрузка одна, статическая; собственный вес направлен вниз по оси Z.',
    'Материал изотропный. Печатные пластики анизотропны: прочность поперек слоев ниже указанной.',
    'Значения материала с основанием "типовое" не являются гарантированными минимумами.',
    'Закрепление идеально жесткое; в реальном соединении напряжения у болтов и сварных швов отличаются.',
    'Усиления заданы геометрически; технологические правила (уклоны, утонения, радиусы инструмента) не проверены.',
    'Напряжение вблизи закрепления и площадки нагрузки зависит от размера ячейки и исключено из определения пика на один слой ячеек.',
    'Результат не заменяет испытание изделия и экспертизу.',
  ]);
  if (ctx.uploaded) {
    ts.list([
      `Геометрия принята по поверхностной сетке файла STL (${ctx.uploaded.triangles} треугольников). Поле расстояний строится на сетке с ячейкой вдвое меньше расчетной; скругления и фаски меньше двух ячеек сглажены.`,
      `Наименьшая толщина стенки ${formatNumber(ctx.uploaded.thickness_m * MM, 3)} мм оценена лучами из центров граней; радиусы скруглений по файлу не определяются, достаточность сетки у них оценивается проверкой сходимости (раздел ${ctx.section.reliability}).`,
    ]);
  }
  if (ctx.withDrawings) {
    ts.list([
      'Чертежи построены по поверхностной сетке; разрезы и сечения не построены.',
      'Рамка и основная надпись приняты по общему виду формы 1 (185 x 55 мм); размеры граф основной надписи не сверены с текстом стандарта.',
    ]);
  }
}

export function writeBibliography(ts) {
  ts.heading(1, '', 'Библиография', { center: true, record: false });
  BIBLIOGRAPHY.forEach((entry, i) => ts.paragraph(`[${i + 1}]  ${entry}`, { indent: 0, justify: false, after: 1 }));
}

// Legend drawn over a figure: color bar with end values
export function legendOverlay(fonts, title, range, reversed, formatter) {
  return (page, box) => {
    const barWidth = box.width * 0.42;
    const x = box.x + box.width - barWidth - 5;
    const y = box.y + box.height - 12;
    const stops = reversed ? [...FIELD_RAMP].reverse() : FIELD_RAMP;
    const steps = 48;
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) / steps;
      const position = t * (stops.length - 1);
      const lo = Math.min(stops.length - 2, Math.floor(position));
      const a = hexToRgb(stops[lo]);
      const b = hexToRgb(stops[lo + 1]);
      const f = position - lo;
      page.fill(a.map((v, k) => v + (b[k] - v) * f));
      page.rect(x + (i * barWidth) / steps, y, barWidth / steps + 0.05, 3.2, 'fill');
    }
    page.lineWidth(0.2);
    page.stroke(BLACK);
    page.rect(x, y, barWidth, 3.2);
    page.text(title, x, y - 1.4, { font: fonts.regular, size: 8 });
    page.text(formatter(range[0]), x, y + 6.6, { font: fonts.regular, size: 8 });
    page.text(formatter(range[1]), x + barWidth, y + 6.6, { font: fonts.regular, size: 8, align: 'right' });
  };
}

