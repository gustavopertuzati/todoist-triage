'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseChecklist,
  descriptionWithoutChecklist,
  buildProposals,
  normalizeDueDate,
} = require('../src/proposals');

const TODAY = '2026-11-04';
const LIMITS = { maxPerType: 15, maxTotal: 40, dueOffsetDays: 7 };

function task(overrides = {}) {
  return {
    id: 't1',
    content: 'Tâche',
    display_title: 'Tâche',
    description: '',
    project_id: 'p1',
    project_name: 'Projet',
    section_id: null,
    priority: 1,
    due_date: null,
    is_overdue: false,
    days_overdue: null,
    is_old: false,
    age_days: 10,
    is_due_today: false,
    project_archived: false,
    ...overrides,
  };
}

function project(overrides = {}) {
  return {
    id: 'p1',
    name: 'Projet',
    is_archived: false,
    is_inbox: false,
    diagnosis: { verdict: 'healthy', score: 0 },
    stats: { tasks: 3 },
    ...overrides,
  };
}

test('parseChecklist reconnaît les listes à puces et à cases', () => {
  const description = 'Contexte\n- premier\n* deuxième\n- [ ] troisième\n- [x] quatrième\ntexte';
  assert.deepEqual(parseChecklist(description), ['premier', 'deuxième', 'troisième', 'quatrième']);
  assert.equal(descriptionWithoutChecklist(description), 'Contexte\ntexte');
});

test('normalizeDueDate accepte une date ISO valide et rejette le reste', () => {
  assert.equal(normalizeDueDate('2026-11-05'), '2026-11-05');
  assert.equal(normalizeDueDate('2026-02-30'), null);
  assert.equal(normalizeDueDate('demain'), null);
  assert.equal(normalizeDueDate(42), null);
});

test('propose de reporter une tâche en retard à aujourd’hui', () => {
  const { items } = buildProposals({
    projects: [project()],
    tasks: [task({ is_overdue: true, days_overdue: 4, due_date: '2026-10-31' })],
    today: TODAY,
    limits: LIMITS,
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].type, 'reschedule_overdue');
  assert.equal(items[0].action.due_date, TODAY);
  assert.equal(items[0].target.kind, 'task');
  assert.ok(items[0].editable.includes('due_date'));
});

test('propose une échéance pour une tâche ancienne sans date', () => {
  const { items } = buildProposals({
    projects: [project()],
    tasks: [task({ is_old: true, age_days: 300 })],
    today: TODAY,
    limits: LIMITS,
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].type, 'set_due_date');
  assert.equal(items[0].action.due_date, '2026-11-11'); // today + 7
});

test('propose d’archiver un projet vide mais jamais l’Inbox', () => {
  const { items } = buildProposals({
    projects: [
      project({ id: 'p1', name: 'Vide', diagnosis: { verdict: 'empty', score: 50 }, stats: { tasks: 0 } }),
      project({ id: 'p2', name: 'Inbox', is_inbox: true, diagnosis: { verdict: 'dormant', score: 35 } }),
      project({ id: 'p3', name: 'Sain', diagnosis: { verdict: 'healthy', score: 0 } }),
    ],
    tasks: [],
    today: TODAY,
    limits: LIMITS,
  });
  const archiveNames = items.filter((i) => i.type === 'archive_project').map((i) => i.target.name);
  assert.deepEqual(archiveNames, ['Vide']);
});

test('propose de scinder une tâche dont la description contient une liste', () => {
  const { items } = buildProposals({
    projects: [project()],
    tasks: [task({ description: 'Préparer :\n- billet\n- passeport' })],
    today: TODAY,
    limits: LIMITS,
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].type, 'split_task');
  assert.deepEqual(items[0].action.subtasks, ['billet', 'passeport']);
  assert.equal(items[0].action.remaining_description, 'Préparer :');
});

test('trie par gravité et respecte les plafonds', () => {
  const manyOld = Array.from({ length: 5 }, (_, i) =>
    task({ id: `old${i}`, is_old: true, age_days: 200 + i })
  );
  const overdue = task({ id: 'late', is_overdue: true, days_overdue: 2, due_date: '2026-11-02' });
  const { items, summary } = buildProposals({
    projects: [project()],
    tasks: [...manyOld, overdue],
    today: TODAY,
    limits: { maxPerType: 3, maxTotal: 40, dueOffsetDays: 7 },
  });

  // Le report des retards passe en premier.
  assert.equal(items[0].type, 'reschedule_overdue');
  assert.equal(items.filter((i) => i.type === 'set_due_date').length, 3);
  assert.equal(summary.truncated.set_due_date, 2);
  assert.equal(summary.total, 4);
});

test('les identifiants sont stables et le résumé compte par type', () => {
  const input = {
    projects: [project()],
    tasks: [task({ is_old: true, age_days: 200 })],
    today: TODAY,
    limits: LIMITS,
  };
  const first = buildProposals(input);
  const second = buildProposals(input);
  assert.equal(first.items[0].id, second.items[0].id);
  assert.deepEqual(first.summary.by_type, { set_due_date: 1 });
});
