'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { estimateTaskSize, buildAgenda, enforceCapacity, describeLoad } = require('../src/capacity');

const TODAY = '2026-11-04';
const RULE = { L: 1, M: 3, S: 5 };

function task(overrides = {}) {
  return {
    id: 't1',
    content: 'Tâche',
    display_title: 'Tâche',
    description: '',
    due_date: null,
    project_archived: false,
    subtask_count: 0,
    ...overrides,
  };
}

test('estime la taille à partir de la durée, des sous-tâches et de la note', () => {
  assert.equal(estimateTaskSize(task({ duration: { amount: 90, unit: 'minute' } })), 'L');
  assert.equal(estimateTaskSize(task({ duration: { amount: 1, unit: 'hour' } })), 'L');
  assert.equal(estimateTaskSize(task({ duration: { amount: 45, unit: 'minute' } })), 'M');
  assert.equal(estimateTaskSize(task({ duration: { amount: 10, unit: 'minute' } })), 'S');
  assert.equal(estimateTaskSize(task({ subtask_count: 3 })), 'L');
  assert.equal(estimateTaskSize(task({ subtask_count: 1 })), 'M');
  assert.equal(estimateTaskSize(task({ description: 'x'.repeat(700) })), 'L');
  assert.equal(estimateTaskSize(task({ description: 'x'.repeat(250) })), 'M');
  assert.equal(estimateTaskSize(task()), 'S');
});

test('buildAgenda calcule la charge et la place restante par jour', () => {
  const tasks = [
    task({ id: 'a', due_date: '2026-11-05', duration: { amount: 90, unit: 'minute' } }), // L
    task({ id: 'b', due_date: '2026-11-05' }), // S
    task({ id: 'c', due_date: '2026-11-20' }), // hors horizon
    task({ id: 'd', due_date: '2026-11-03' }), // passé
    task({ id: 'e', due_date: '2026-11-06', project_archived: true }), // archivé
  ];
  const agenda = buildAgenda({ tasks, today: TODAY, horizonDays: 5, rule: RULE });

  assert.equal(agenda.length, 5);
  assert.equal(agenda[0].date, '2026-11-04');
  const day5 = agenda.find((day) => day.date === '2026-11-05');
  assert.deepEqual(day5.load, { L: 1, M: 0, S: 1 });
  assert.deepEqual(day5.remaining, { L: 0, M: 3, S: 4 });
  assert.equal(day5.total, 2);
  assert.equal(day5.full, false);
  assert.equal(describeLoad(day5.load), '1 gros · 1 petit');
});

test('enforceCapacity refuse ce qui dépasse la place du jour', () => {
  const agenda = buildAgenda({
    tasks: [task({ id: 'busy', due_date: '2026-11-05', duration: { amount: 90, unit: 'minute' } })],
    today: TODAY,
    horizonDays: 5,
    rule: RULE,
  });

  const proposals = [
    { action: { due_date: '2026-11-05' }, size: 'L' }, // refusé : 1 gros déjà posé
    { action: { due_date: '2026-11-05' }, size: 'M' }, // accepté
    { action: { due_date: '2026-11-05' }, size: 'M' }, // accepté
    { action: { due_date: '2026-11-05' }, size: 'M' }, // accepté
    { action: { due_date: '2026-11-05' }, size: 'M' }, // refusé : plus de place en moyen
  ];

  const { accepted, rejected } = enforceCapacity(proposals, agenda, RULE);
  assert.equal(accepted.length, 3);
  assert.equal(rejected.length, 2);
});
