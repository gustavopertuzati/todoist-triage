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
  describeDay,
  generateDayProposals,
  findAiProposal,
  removeAiProposal,
  clearAiCache,
  rememberItems,
} = require('../src/aiProposals');
const { buildAgenda } = require('../src/capacity');

const TODAY = '2026-11-04';
const DAY = '2026-11-05';
const LATER = '2026-11-10';
const RULE = { L: 1, M: 3, S: 5 };

// Check-in « en forme » : la charge complète est autorisée.
const GOOD = { energy: 'high', health: 'great', time: 'allday', want: 'mix', mood: 'great' };
// Check-in « malade » : journée allégée.
const SICK = { energy: 'exhausted', health: 'sick', time: 'lt1h', want: 'short', mood: 'overwhelmed' };

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
  assert.equal(info.planned[0].size_label, 'Gros');
});

test('describeDay réduit la charge autorisée si l’on est malade', () => {
  const snapshot = snapshotWith([task({ id: 'a' })]);
  const normal = describeDay(snapshot, DAY, GOOD);
  const sick = describeDay(snapshot, DAY, SICK);

  assert.deepEqual(normal.allowed, RULE);
  assert.ok(sick.allowed.L === 0);
  assert.ok(sick.allowed.L + sick.allowed.M + sick.allowed.S < RULE.L + RULE.M + RULE.S);
  assert.match(sick.label, /allégée/i);
});

test('buildDayDigest est déterministe et expose la place pour ajouter', () => {
  const snapshot = snapshotWith([task({ id: 'a' }), task({ id: 'b' })]);
  const digest = buildDayDigest(snapshot, DAY, GOOD);
  assert.deepEqual(digest, buildDayDigest(snapshot, DAY, GOOD));
  assert.equal(digest.date, DAY);
  assert.deepEqual(digest.can_add, RULE);
  assert.equal(digest.max_proposals, 5);
});

test('validateDayResponse ne garde que la journée visée et respecte la charge', () => {
  const snapshot = snapshotWith([task({ id: 't1' }), task({ id: 't2' }), task({ id: 't3' }), task({ id: 't4' })]);
  const digest = buildDayDigest(snapshot, DAY, GOOD);

  const { items } = validateDayResponse(
    {
      proposals: [
        { task_id: 't1', due_date: DAY, size: 'L', reason: 'ok' },
        { task_id: 't2', due_date: '2026-11-06', size: 'S', reason: 'mauvais jour' },
        { task_id: 't3', due_date: DAY, size: 'L', reason: 'dépasse le gros' },
        { task_id: 't4', due_date: DAY, size: 'S', reason: 'ok' },
        { task_id: 'inconnu', due_date: DAY, size: 'S', reason: 'inconnu' },
      ],
    },
    snapshot,
    DAY,
    digest
  );

  const ids = items.map((item) => item.target.id).sort();
  assert.deepEqual(ids, ['t1', 't4']);
  assert.ok(items.every((item) => item.action.due_date === DAY));
});

test('validateDayResponse propose de reporter quand la journée est trop chargée', () => {
  const busy = task({ id: 'busy', due_date: DAY, duration: { amount: 90, unit: 'minute' } }); // gros
  const snapshot = snapshotWith([busy, task({ id: 'free' })]);
  const digest = buildDayDigest(snapshot, DAY, SICK);

  // Malade : gros autorisé = 0 → il faut retirer le gros.
  assert.equal(digest.allowed.L, 0);
  assert.ok(digest.to_remove.L >= 1);

  const { items } = validateDayResponse(
    {
      proposals: [],
      defer: [{ task_id: 'busy', due_date: LATER, reason: 'trop lourd aujourd’hui' }],
    },
    snapshot,
    DAY,
    digest
  );

  assert.equal(items.length, 1);
  assert.equal(items[0].move, true);
  assert.equal(items[0].type_label, 'Reporter');
  assert.equal(items[0].action.due_date, LATER);
});

test('validateDayResponse refuse un report vers un jour sans place', () => {
  const busy = task({ id: 'busy', due_date: DAY, duration: { amount: 90, unit: 'minute' } });
  const filler = task({ id: 'f', due_date: LATER, duration: { amount: 90, unit: 'minute' } });
  const snapshot = snapshotWith([busy, filler]);
  const digest = buildDayDigest(snapshot, DAY, SICK);

  const { items } = validateDayResponse(
    { defer: [{ task_id: 'busy', due_date: LATER, reason: 'plein' }] },
    snapshot,
    DAY,
    digest
  );
  assert.equal(items.length, 0);
});

test('validateDayResponse accepte une scission proposée par l’IA', () => {
  const snapshot = snapshotWith([task({ id: 't1' })]);
  const digest = buildDayDigest(snapshot, DAY, GOOD);

  const { splits } = validateDayResponse(
    { proposals: [], splits: [{ task_id: 't1', reason: 'fourre-tout', subtasks: ['Étape un', 'Étape deux'] }] },
    snapshot,
    DAY,
    digest
  );

  assert.equal(splits.length, 1);
  assert.equal(splits[0].type, 'split_task');
  assert.equal(splits[0].action.update_description, false);
});

test('les parents (avec sous-tâches) ne sont pas proposés, seules les feuilles le sont', () => {
  const parent = task({ id: 'parent', content: 'Faire toute la lessive', display_title: 'Faire toute la lessive', subtask_count: 8 });
  const child = task({ id: 'child', content: 'Plier le linge', display_title: 'Plier le linge', parent_id: 'parent' });
  const snapshot = snapshotWith([parent, child]);
  const digest = buildDayDigest(snapshot, DAY, GOOD);

  const ids = digest.tasks.map((t) => t.id);
  assert.ok(!ids.includes('parent'), 'le parent ne doit pas être proposé');
  assert.ok(ids.includes('child'), 'la sous-tâche doit être proposée');
  assert.equal(digest.tasks.find((t) => t.id === 'child').parent, 'Faire toute la lessive');
});

test('validateDayResponse refuse de scinder une tâche qui a déjà des sous-tâches', () => {
  const parent = task({ id: 'parent', content: 'Faire toute la lessive', display_title: 'Faire toute la lessive', subtask_count: 8, due_date: DAY });
  const snapshot = snapshotWith([parent]);
  const digest = buildDayDigest(snapshot, DAY, GOOD);

  const { splits } = validateDayResponse(
    { splits: [{ task_id: 'parent', reason: 'fourre-tout', subtasks: ['A', 'B'] }] },
    snapshot,
    DAY,
    digest,
    null
  );
  assert.equal(splits.length, 0);
});

test('validateDayResponse respecte « jamais » pour les scissions', () => {
  const free = task({ id: 'free' });
  const snapshot = snapshotWith([free]);
  const digest = buildDayDigest(snapshot, DAY, GOOD);
  const profile = { never: ['free'], postpone: [], sizes: [], improve: [] };

  const { splits } = validateDayResponse(
    { splits: [{ task_id: 'free', reason: 'x', subtasks: ['A', 'B'] }] },
    snapshot,
    DAY,
    digest,
    profile
  );
  assert.equal(splits.length, 0);
});

test('un jour reste résolvable et une proposition retirée ne casse pas les autres', async () => {
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
    const result = await generateDayProposals(snapshot, DAY, { force: true, checkin: GOOD });
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

test('rememberItems rend les propositions approfondies résolvables', () => {
  const proposals = [
    { id: 'delete_task:x:deep', type: 'delete_task', target: { id: 'x' } },
    { id: 'delete_task:y:deep', type: 'delete_task', target: { id: 'y' } },
  ];
  rememberItems(proposals);
  try {
    assert.ok(findAiProposal('delete_task:x:deep'));
    assert.ok(findAiProposal('delete_task:y:deep'));
    removeAiProposal('delete_task:x:deep');
    assert.equal(findAiProposal('delete_task:x:deep'), null);
    assert.ok(findAiProposal('delete_task:y:deep'));
  } finally {
    clearAiCache();
  }
});
