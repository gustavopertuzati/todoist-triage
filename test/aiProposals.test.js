'use strict';

// Doit être défini avant de charger la configuration.
process.env.OPENROUTER_API_KEY = 'test-key';
process.env.AI_MODEL = 'deepseek/deepseek-v4.1-flash';
process.env.AI_MAX_PROPOSALS = '5';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseJsonLoose } = require('../src/ai');
const {
  buildDayDigest,
  validateDayResponse,
  dayInfo,
  generateDayProposals,
  findAiProposal,
  removeAiProposal,
  clearAiCache,
} = require('../src/aiProposals');
const { buildAgenda } = require('../src/capacity');

const TODAY = '2026-11-04';
const DAY = '2026-11-05';
const RULE = { L: 1, M: 3, S: 5 };

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
    subtask_count: 0,
    project_archived: false,
    ...overrides,
  };
}

function snapshotWith(tasks) {
  return {
    meta: { today: TODAY, timezone: 'Europe/Zurich' },
    tasks,
    capacity: {
      horizon_days: 14,
      rule: RULE,
      days: buildAgenda({ tasks, today: TODAY, horizonDays: 14, rule: RULE }),
    },
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

test('dayInfo liste les tâches déjà prévues avec leur taille', () => {
  const snapshot = snapshotWith([
    task({ id: 'a', due_date: DAY, duration: { amount: 90, unit: 'minute' } }),
    task({ id: 'b', due_date: DAY }),
    task({ id: 'c', due_date: null }),
  ]);
  const info = dayInfo(snapshot, DAY);

  assert.equal(info.total, 2);
  assert.deepEqual(info.load, { L: 1, M: 0, S: 1 });
  assert.deepEqual(info.remaining, { L: 0, M: 3, S: 4 });
  assert.equal(info.planned[0].size_label, 'Gros');
});

test('buildDayDigest est déterministe et porte la place restante', () => {
  const snapshot = snapshotWith([task({ id: 'a' }), task({ id: 'b' })]);
  const digest = buildDayDigest(snapshot, DAY);
  assert.deepEqual(digest, buildDayDigest(snapshot, DAY));
  assert.equal(digest.date, DAY);
  assert.deepEqual(digest.remaining, RULE);
  assert.equal(digest.tasks.length, 2);
});

test('validateDayResponse ne garde que la journée visée et respecte la place', () => {
  const snapshot = snapshotWith([
    task({ id: 't1' }),
    task({ id: 't2' }),
    task({ id: 't3' }),
    task({ id: 't4' }),
  ]);
  const digest = buildDayDigest(snapshot, DAY);

  const { items } = validateDayResponse(
    {
      summary: 'Journée test',
      proposals: [
        { task_id: 't1', due_date: DAY, size: 'L', reason: 'ok' },
        { task_id: 't2', due_date: '2026-11-06', size: 'S', reason: 'mauvais jour' }, // écarté
        { task_id: 't3', due_date: DAY, size: 'L', reason: 'dépasse le gros' }, // écarté
        { task_id: 't4', due_date: DAY, size: 'S', reason: 'ok' },
        { task_id: 'inconnu', due_date: DAY, size: 'S', reason: 'inconnu' }, // écarté
      ],
    },
    snapshot,
    DAY,
    digest
  );

  const ids = items.map((item) => item.target.id).sort();
  assert.deepEqual(ids, ['t1', 't4']);
  assert.ok(items.every((item) => item.action.due_date === DAY));
  assert.equal(items.find((item) => item.target.id === 't1').size_label, 'Gros');
});

test('validateDayResponse accepte une scission proposée par l’IA', () => {
  const snapshot = snapshotWith([task({ id: 't1' })]);
  const digest = buildDayDigest(snapshot, DAY);

  const { splits } = validateDayResponse(
    {
      proposals: [],
      splits: [{ task_id: 't1', reason: 'fourre-tout', subtasks: ['Étape un', 'Étape deux'] }],
    },
    snapshot,
    DAY,
    digest
  );

  assert.equal(splits.length, 1);
  assert.equal(splits[0].type, 'split_task');
  assert.equal(splits[0].action.update_description, false);
});

test('validateDayResponse refuse tout si la place est nulle', () => {
  const snapshot = snapshotWith([
    task({ id: 'busy', due_date: DAY, duration: { amount: 90, unit: 'minute' } }), // L plein
    task({ id: 'busy2', due_date: DAY, duration: { amount: 90, unit: 'minute' } }), // L plein aussi
    task({ id: 't1' }),
  ]);
  // Occupe les 3 moyens et 5 petits.
  const fillers = [];
  for (let i = 0; i < 3; i += 1) fillers.push(task({ id: `m${i}`, due_date: DAY, duration: { amount: 45, unit: 'minute' } }));
  for (let i = 0; i < 5; i += 1) fillers.push(task({ id: `s${i}`, due_date: DAY, duration: { amount: 10, unit: 'minute' } }));
  snapshot.tasks = [...snapshot.tasks, ...fillers];
  snapshot.capacity.days = buildAgenda({ tasks: snapshot.tasks, today: TODAY, horizonDays: 14, rule: RULE });

  const digest = buildDayDigest(snapshot, DAY);
  assert.deepEqual(digest.remaining, { L: 0, M: 0, S: 0 });

  const { items } = validateDayResponse(
    { proposals: [{ task_id: 't1', due_date: DAY, size: 'S', reason: 'non' }] },
    snapshot,
    DAY,
    digest
  );
  assert.equal(items.length, 0);
});

test('un lot de jour reste résolvable et une proposition retirée ne casse pas les autres', async () => {
  clearAiCache();
  const snapshot = snapshotWith([task({ id: 't1' }), task({ id: 't2' })]);
  const originalFetch = global.fetch;

  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        model: 'fake',
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: 'journée de test',
                proposals: [
                  { task_id: 't1', due_date: DAY, size: 'M', reason: 'prioritaire', group: 'Admin' },
                  { task_id: 't2', due_date: DAY, size: 'S', reason: 'plus tard', group: 'Maison' },
                ],
              }),
            },
          },
        ],
        usage: { total_tokens: 10 },
      }),
  });

  try {
    const result = await generateDayProposals(snapshot, DAY, { force: true });
    assert.equal(result.items.length, 2);

    const first = result.items[0];
    const second = result.items[1];
    assert.ok(findAiProposal(first.id));
    assert.ok(findAiProposal(second.id));

    removeAiProposal(first.id);
    assert.equal(findAiProposal(first.id), null);
    assert.ok(findAiProposal(second.id));
  } finally {
    global.fetch = originalFetch;
    clearAiCache();
  }
});
