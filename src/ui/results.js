// Result section: tables, verdict, notes

import { el } from './dom.js';
import { TEXT } from './text.js';
import { formatNumber, formatSafety } from './format.js';

const point = (p) => (p ? `(${p.map((v) => formatNumber(v * 1000, 3)).join('; ')}) мм` : 'нет данных');

export function renderResult(container, summary, comparison) {
  container.replaceChildren();
  const rows = [
    [TEXT.result.rows.mass, `${formatNumber(summary.mass_kg * 1000, 4)} г`],
    [TEXT.result.rows.displacement, `${formatNumber(summary.maxDisplacement_mm, 3)} мм, точка ${point(summary.displacementPoint_m)}`],
    [`${TEXT.result.rows.stress} (теория ${summary.primaryId})`, `${formatNumber(summary.peakStress_mpa, 3)} МПа, точка ${point(summary.peakPoint_m)}`],
    [TEXT.result.rows.safety, formatSafety(summary.safety)],
    [TEXT.result.rows.required, formatNumber(summary.requiredSafety, 3)],
  ];
  container.append(
    el('div', { class: `verdict ${summary.passes ? 'ok' : 'fail'}` }, `${summary.passes ? TEXT.result.passed : TEXT.result.failed}`),
    el('table', {}, el('tbody', {}, rows.map(([name, text]) => el('tr', {}, el('th', {}, name), el('td', {}, text))))),
  );
  if (comparison) container.append(renderComparison(comparison));

  container.append(el('h3', {}, TEXT.result.theories), theoryTable(summary));
  container.append(el('h3', {}, TEXT.result.contradictions));
  if (summary.contradictions.length === 0) container.append(el('p', {}, TEXT.result.noContradictions));
  else container.append(el('ul', { class: 'notes' }, summary.contradictions.map((text) => el('li', { class: 'warn' }, text))));

  container.append(el('h3', {}, TEXT.result.control), controlTable(summary.control));
  if (summary.notes.length > 0) container.append(el('ul', { class: 'notes' }, summary.notes.map((n) => el('li', { class: n.level }, n.text))));
}

function theoryTable(summary) {
  return el(
    'table',
    {},
    el('thead', {}, el('tr', {}, el('th', {}, 'Теория'), el('th', { class: 'number' }, 'Пик, МПа'), el('th', { class: 'number' }, 'Запас'), el('th', {}, 'Роль'))),
    el(
      'tbody',
      {},
      summary.theories.map((t) =>
        el('tr', {}, el('td', { title: t.name }, t.id), el('td', { class: 'number' }, formatNumber(t.peak_mpa, 3)), el('td', { class: 'number' }, formatSafety(t.safety)), el('td', {}, t.role)),
      ),
    ),
  );
}

function controlTable(control) {
  const conv = control.convergence;
  const rows = [
    ['Ячеек с материалом', String(control.cells)],
    ['Размер ячейки, мм', control.cell_mm.map((h) => formatNumber(h, 3)).join(' x ')],
    ['Степеней свободы', String(control.dofs)],
    ['Итераций сопряженных градиентов', String(control.iterations)],
    ['Относительная невязка', control.residual.toExponential(1).replace('.', ',')],
    ['Невязка равновесия реакций', control.equilibrium.toExponential(1).replace('.', ',')],
  ];
  if (conv) {
    rows.push(['Изменение перемещения при укрупнении ячейки в 1,5 раза', `${formatNumber(conv.displacementChange * 100, 2)} %`]);
    rows.push(['Изменение пикового напряжения при укрупнении ячейки в 1,5 раза', `${formatNumber(conv.stressChange * 100, 2)} %`]);
  }
  return el('table', {}, el('tbody', {}, rows.map(([name, text]) => el('tr', {}, el('th', {}, name), el('td', {}, text)))));
}

function renderComparison(comparison) {
  const rows = [
    ['Масса, г', comparison.before.mass_kg * 1000, comparison.after.mass_kg * 1000, formatNumber],
    ['Максимальное перемещение, мм', comparison.before.maxDisplacement_mm, comparison.after.maxDisplacement_mm, formatNumber],
    ['Максимальное напряжение, МПа', comparison.before.peakStress_mpa, comparison.after.peakStress_mpa, formatNumber],
    ['Запас прочности', comparison.before.safety, comparison.after.safety, formatSafety],
  ];
  return el(
    'div',
    {},
    el('h3', {}, TEXT.reinforcement.compare),
    el(
      'table',
      {},
      el('thead', {}, el('tr', {}, el('th', {}, ''), el('th', { class: 'number' }, TEXT.reinforcement.before), el('th', { class: 'number' }, TEXT.reinforcement.after), el('th', { class: 'number' }, TEXT.reinforcement.change))),
      el(
        'tbody',
        {},
        rows.map(([name, a, b, format]) =>
          el('tr', {}, el('th', {}, name), el('td', { class: 'number' }, format(a)), el('td', { class: 'number' }, format(b)), el('td', { class: 'number' }, Number.isFinite(a) && Number.isFinite(b) ? `${formatNumber(((b - a) / a) * 100, 3)} %` : 'нет данных')),
        ),
      ),
    ),
  );
}
