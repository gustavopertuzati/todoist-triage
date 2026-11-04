'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  listDayTasks,
  priorityOrder,
  buildDayOrderDigest,
  buildOrderPrompt,
  validateOrderResponse,
} = require('../src/dayOrder');

const TODAY = '2026-11-05';

function task(overrides = {}) {
  return {
    id: 't1',
    content: 'Tâche',
    display_title: 'Tâche',
    description: '',
    parent_id: null,
    due_date: TODAY,
    is_overdue: false,
    priority: 1,
    priority_label: 'P4',
    labels: [],
    project_archived: false,
    subtask_count: 0,
    ...overrides,
  };
}

function snapshot(tasks) {
  return { meta: { today: TODAY, timezone: 'Europe/Paris' }, tasks };
}

test('listDayTasks garde les tâches du jour, les préparations et les retards', () => {
  const parent = task({ id: 'p', display_title: 'Parent' });
  const prep = task({
    id: 'prep',
    display_title: '1. Préparation',
    parent_id: 'p',
    description: 'Préparation créée par Triage',
  });
  const normalSub = task({
    id: 'sub',
    display_title: '2. Découpe',
    parent_id: 'p',
    description: '',
    due_date: null,
  });
  const overdue = task({
    id: 'late',
    display_title: 'En retard',
    due_date: '2026-11-03',
    is_overdue: true,
    priority: 4,
    priority_label: 'P1',
  });

  const tasks = listDayTasks(snapshot([parent, prep, normalSub, overdue]), TODAY);
  assert.deepEqual(tasks.map((item) => item.id).sort(), ['late', 'p', 'prep']);
  const prepMeta = tasks.find((item) => item.id === 'prep');
  assert.equal(prepMeta.is_prep, true);
  assert.equal(prepMeta.parent_title, 'Parent');
});

test('priorityOrder trie P1 d’abord puis les retards', () => {
  const tasks = [
    { id: 'a', title: 'B', priority: 1, priority_label: 'P4', overdue: false },
    { id: 'b', title: 'A', priority: 4, priority_label: 'P1', overdue: false },
    { id: 'c', title: 'C', priority: 3, priority_label: 'P2', overdue: true },
  ];
  assert.deepEqual(priorityOrder(tasks).map((item) => item.id), ['b', 'c', 'a']);
});

test('buildDayOrderDigest expose les infos utiles à l’IA', () => {
  const tasks = listDayTasks(
    snapshot([
      task({ id: 'p', display_title: 'Parent', priority: 4, priority_label: 'P1' }),
      task({
        id: 'prep',
        display_title: '1. Préparation',
        parent_id: 'p',
        description: 'Préparation créée par Triage',
        priority: 2,
        priority_label: 'P3',
      }),
    ]),
    TODAY
  );
  const digest = buildDayOrderDigest(tasks, TODAY);
  assert.equal(digest.date, TODAY);
  const prep = digest.tasks.find((item) => item.id === 'prep');
  assert.equal(prep.is_preparation, true);
  assert.equal(prep.parent, 'Parent');
  assert.match(buildOrderPrompt(digest), /préparations.*avant la tâche parente/i);
});

test('validateOrderResponse applique l’ordre et complète les oublis', () => {
  const tasks = [
    { id: 'a', title: 'A', priority: 1, priority_label: 'P4', overdue: false },
    { id: 'b', title: 'B', priority: 4, priority_label: 'P1', overdue: false },
  ];
  const { execution, summary } = validateOrderResponse(
    { summary: 'Priorité haute d’abord.', order: [{ id: 'b', why: 'urgent' }] },
    tasks
  );
  assert.deepEqual(execution, [
    { id: 'b', why: 'urgent' },
    { id: 'a', why: null },
  ]);
  assert.match(summary, /Priorité/);
});

test('validateOrderResponse ignore les inconnus et les doublons', () => {
  const tasks = [
    { id: 'a', title: 'A', priority: 1, priority_label: 'P4', overdue: false },
    { id: 'b', title: 'B', priority: 2, priority_label: 'P3', overdue: false },
  ];
  const { execution } = validateOrderResponse(
    { order: [{ id: 'ghost' }, { id: 'a' }, { id: 'a' }, 'b'] },
    tasks
  );
  assert.deepEqual(execution, [
    { id: 'a', why: null },
    { id: 'b', why: null },
  ]);
});
