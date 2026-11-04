'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseJsonLoose } = require('../src/ai');
const { validateResponse, buildDigest, signatureFor } = require('../src/aiProposals');
const { mergeProposalLists } = require('../src/proposals');

const TODAY = '2026-11-04';

function task(overrides = {}) {
  return {
    id: 't1',
    content: 'Tâche',
    display_title: 'Tâche',
    description: '',
    project_id: 'p1',
    project_name: 'Projet',
    labels: [],
    priority: 1,
    priority_label: 'P4',
    due_date: null,
    is_overdue: false,
    days_overdue: null,
    age_days: 200,
    is_old: true,
    project_archived: false,
    ...overrides,
  };
}

function snapshotWith(tasks) {
  return {
    meta: { today: TODAY, timezone: 'Europe/Zurich' },
    tasks,
    projects: [
      { id: 'p1', name: 'Projet', is_archived: false, stats: { tasks: tasks.length, overdue: 0, no_due: tasks.length, completed_lookback: 0 } },
    ],
  };
}

test('parseJsonLoose tolère les balises de code et le texte autour', () => {
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonLoose('Voici : {"a":2} voilà'), { a: 2 });
  assert.equal(parseJsonLoose('pas de json ici'), null);
});

test('buildDigest est déterministe et compact', () => {
  const snapshot = snapshotWith([task({ id: 't1' }), task({ id: 't2' })]);
  const a = buildDigest(snapshot);
  const b = buildDigest(snapshot);
  assert.deepEqual(a, b);
  assert.equal(signatureFor(a), signatureFor(b));
  assert.equal(a.tasks.length, 2);
  assert.equal(a.tasks[0].id, 't1');
  assert.equal(a.today, TODAY);
});

test('validateResponse ne garde que des propositions sûres', () => {
  const snapshot = snapshotWith([task({ id: 't1' })]);
  const digest = { today: TODAY, tasks: [{ id: 't1' }] };

  const items = validateResponse(
    {
      summary: 'Stratégie test',
      proposals: [
        { task_id: 't1', due_date: '2026-11-10', reason: 'Petite tâche, à faire vite.', group: 'Admin' },
        { task_id: 'inconnu', due_date: '2026-11-10', reason: 'inconnue' },
        { task_id: 't1', due_date: '2026-11-10', reason: 'doublon' },
      ],
    },
    snapshot,
    digest
  );

  assert.equal(items.length, 1);
  assert.equal(items[0].source, 'ai');
  assert.equal(items[0].type, 'set_due_date');
  assert.equal(items[0].action.due_date, '2026-11-10');
  assert.equal(items[0].ai_group, 'Admin');
  assert.equal(items[0].target.id, 't1');
});

test('validateResponse rejette les dates hors bornes ou invalides', () => {
  const snapshot = snapshotWith([task({ id: 't1', due_date: '2026-11-20' })]);
  const digest = { today: TODAY, tasks: [{ id: 't1' }] };

  const items = validateResponse(
    {
      proposals: [
        { task_id: 't1', due_date: '2026-11-03' }, // avant aujourd'hui
        { task_id: 't1', due_date: '2027-12-31' }, // au-delà de l'horizon
        { task_id: 't1', due_date: 'demain' }, // invalide
        { task_id: 't1', due_date: '2026-11-20' }, // identique à l'existant
      ],
    },
    snapshot,
    digest
  );

  assert.equal(items.length, 0);
});

test('mergeProposalLists laisse l’IA remplacer la règle de datation', () => {
  const rule = [
    { id: 'r1', type: 'set_due_date', score: 30, target: { id: 't1' } },
    { id: 'r2', type: 'set_due_date', score: 30, target: { id: 't2' } },
    { id: 'r3', type: 'archive_project', score: 60, target: { id: 'p1' } },
  ];
  const ai = [
    { id: 'a1', type: 'set_due_date', score: 55, target: { id: 't1' } },
  ];

  const merged = mergeProposalLists(rule, ai, { maxTotal: 40 });
  const ids = merged.items.map((p) => p.id).sort();
  // r1 et r2 (datation) sont retirés ; seul a1 subsiste + archive r3.
  assert.deepEqual(ids, ['a1', 'r3']);
  assert.equal(merged.summary.by_type.set_due_date, 1);
  assert.equal(merged.summary.by_type.archive_project, 1);
  assert.equal(merged.items[0].id, 'r3'); // score 60 avant 55
});

test('mergeProposalLists respecte le plafond total', () => {
  const rule = Array.from({ length: 5 }, (_, i) => ({
    id: `r${i}`,
    type: 'archive_project',
    score: 60 - i,
    target: { id: `p${i}` },
  }));
  const merged = mergeProposalLists(rule, [], { maxTotal: 3 });
  assert.equal(merged.items.length, 3);
  assert.equal(merged.summary.truncated.total, 2);
});
