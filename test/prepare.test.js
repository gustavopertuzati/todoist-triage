'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  prepWindow,
  buildPrepareDigest,
  buildPreparePrompt,
  validatePrepareResponse,
  buildDecomposeDigest,
  buildDecomposePrompt,
  validateDecomposeResponse,
  stripOrderPrefix,
  numberedTitle,
} = require('../src/prepare');

const TODAY = '2026-11-04';

function makeTask(overrides = {}) {
  return {
    id: 't1',
    content: 'Ranger la cave',
    display_title: 'Ranger la cave',
    description: '',
    due_date: '2026-11-07',
    project_id: 'p1',
    project_name: 'Maison',
    section_id: 's1',
    subtask_count: 0,
    ...overrides,
  };
}

function makeSnapshot(task = makeTask(), extraTasks = []) {
  return {
    meta: { today: TODAY, timezone: 'Europe/Zurich' },
    tasks: [
      task,
      ...extraTasks,
    ],
    capacity: {
      days: [
        { date: '2026-11-04', remaining: { L: 1, M: 3, S: 5 } },
        { date: '2026-11-05', remaining: { L: 1, M: 3, S: 2 } },
        { date: '2026-11-06', remaining: { L: 1, M: 3, S: 0 } },
        { date: '2026-11-07', remaining: { L: 1, M: 3, S: 3 } },
        { date: '2026-11-08', remaining: { L: 1, M: 3, S: 5 } },
      ],
    },
  };
}

test('prepWindow couvre de today à la date de la tâche', () => {
  const { target, dates } = prepWindow(makeTask(), TODAY);
  assert.equal(target, '2026-11-07');
  assert.deepEqual(dates, ['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07']);
});

test('prepWindow d’une tâche sans échéance ne propose que today', () => {
  const { target, dates } = prepWindow(makeTask({ due_date: null }), TODAY);
  assert.equal(target, TODAY);
  assert.deepEqual(dates, [TODAY]);
});

test('prepWindow plafonne une préparation lointaine à 31 jours', () => {
  const { target, windowEnd, dates, tooEarly } = prepWindow(
    makeTask({ due_date: '2027-03-01' }),
    TODAY
  );
  assert.equal(target, '2027-03-01');
  assert.equal(dates.length, 31);
  assert.equal(windowEnd, dates[dates.length - 1]);
  assert.ok(windowEnd < target);
  assert.equal(tooEarly, true);
});

test('prepWindow d’une tâche proche n’est pas « trop tôt »', () => {
  const { tooEarly } = prepWindow(makeTask({ due_date: '2026-11-07' }), TODAY);
  assert.equal(tooEarly, false);
});

test('buildPrepareDigest ne garde que la fenêtre et liste les sous-tâches', () => {
  const child = makeTask({
    id: 'c1',
    content: 'Sortir les cartons',
    display_title: 'Sortir les cartons',
    parent_id: 't1',
    due_date: '2026-11-05',
  });
  const snapshot = makeSnapshot(makeTask(), [child]);
  const digest = buildPrepareDigest(makeTask(), snapshot, { maxPrep: 2 });

  assert.equal(digest.task.date, '2026-11-07');
  assert.equal(digest.task.in_days, 3);
  assert.equal(digest.max_prep, 2);
  assert.deepEqual(digest.capacity.map((day) => day.date), [
    '2026-11-04',
    '2026-11-05',
    '2026-11-06',
    '2026-11-07',
  ]);
  assert.deepEqual(digest.task.existing_subtasks, [
    { title: 'Sortir les cartons', date: '2026-11-05' },
  ]);
});

test('buildPreparePrompt demande des préparations datées et sans doublon', () => {
  const snapshot = makeSnapshot();
  const prompt = buildPreparePrompt(buildPrepareDigest(makeTask(), snapshot, { maxPrep: 3 }));
  assert.match(prompt, /PRÉPARATION/);
  assert.match(prompt, /entre today et la date de la tâche/);
  assert.match(prompt, /existing_subtasks/);
});

test('validatePrepareResponse accepte des préparations datées dans la fenêtre', () => {
  const task = makeTask();
  const snapshot = makeSnapshot();
  const digest = buildPrepareDigest(task, snapshot, { maxPrep: 3 });

  const parsed = {
    summary: 'Préparer la cave en deux temps.',
    preparations: [
      { title: 'Sortir les cartons à descendre', date: '2026-11-05', reason: 'Libère de la place' },
      { title: 'Préparer la lampe et les sacs', date: '2026-11-07', reason: 'Tout avoir sous la main' },
    ],
  };

  const { items, dropped } = validatePrepareResponse(parsed, task, snapshot, digest);
  assert.equal(dropped, 0);
  assert.equal(items.length, 1);
  const proposal = items[0];
  assert.equal(proposal.type, 'prepare_task');
  assert.equal(proposal.format, 'prepare');
  assert.equal(proposal.action.parent_id, 't1');
  assert.deepEqual(proposal.action.subtasks, [
    { title: '1. Sortir les cartons à descendre', date: '2026-11-05', reason: 'Libère de la place' },
    { title: '2. Préparer la lampe et les sacs', date: '2026-11-07', reason: 'Tout avoir sous la main' },
  ]);
  assert.match(proposal.preview, /2 préparation/);
});

test('validatePrepareResponse refuse les dates hors fenêtre', () => {
  const task = makeTask();
  const snapshot = makeSnapshot();
  const digest = buildPrepareDigest(task, snapshot, { maxPrep: 3 });

  const parsed = {
    preparations: [
      { title: 'Trop tôt', date: '2026-11-01' },
      { title: 'Trop tard', date: '2026-11-12' },
      { title: 'Bon jour', date: '2026-11-04' },
    ],
  };

  const { items, dropped } = validatePrepareResponse(parsed, task, snapshot, digest);
  assert.equal(dropped, 2);
  assert.deepEqual(items[0].action.subtasks.map((s) => s.title), ['1. Bon jour']);
});

test('une journée pleine n’empêche pas une préparation (elles sont légères)', () => {
  const task = makeTask();
  const snapshot = makeSnapshot();
  const digest = buildPrepareDigest(task, snapshot, { maxPrep: 3 });

  // 2026-11-06 a remaining.S = 0 : c'était bloquant avant.
  const parsed = {
    preparations: [{ title: 'Jour plein mais préparation utile', date: '2026-11-06' }],
  };

  const { items, dropped } = validatePrepareResponse(parsed, task, snapshot, digest);
  assert.equal(dropped, 0);
  assert.deepEqual(items[0].action.subtasks.map((s) => s.title), [
    '1. Jour plein mais préparation utile',
  ]);
});

test('validatePrepareResponse déduplique et ignore les titres trop courts', () => {
  const task = makeTask();
  const child = makeTask({
    id: 'c1',
    content: 'Sortir les cartons',
    display_title: 'Sortir les cartons',
    parent_id: 't1',
  });
  const snapshot = makeSnapshot(task, [child]);
  const digest = buildPrepareDigest(task, snapshot, { maxPrep: 3 });

  const parsed = {
    preparations: [
      { title: 'Sortir les cartons', date: '2026-11-05' }, // déjà existant
      { title: 'ab', date: '2026-11-05' },
      { title: 'Sortir les cartons', date: '2026-11-06' }, // doublon interne
      { title: 'Préparer les sacs', date: '2026-11-05' },
    ],
  };

  const { items } = validatePrepareResponse(parsed, task, snapshot, digest);
  assert.deepEqual(items[0].action.subtasks.map((s) => s.title), ['1. Préparer les sacs']);
});

test('validatePrepareResponse respecte le nombre maximum et la capacité', () => {
  const task = makeTask();
  const snapshot = makeSnapshot();
  const digest = buildPrepareDigest(task, snapshot, { maxPrep: 1 });

  const parsed = {
    preparations: [
      { title: 'Première chose', date: '2026-11-04' },
      { title: 'Deuxième chose', date: '2026-11-04' },
    ],
  };

  const { items } = validatePrepareResponse(parsed, task, snapshot, digest);
  assert.equal(items[0].action.subtasks.length, 1);
  assert.equal(items[0].action.subtasks[0].title, '1. Première chose');
});

test('validatePrepareResponse renvoie une liste vide sans préparation valable', () => {
  const task = makeTask();
  const snapshot = makeSnapshot();
  const digest = buildPrepareDigest(task, snapshot, { maxPrep: 3 });
  const { items, dropped } = validatePrepareResponse({ preparations: [] }, task, snapshot, digest);
  assert.deepEqual(items, []);
  assert.equal(dropped, 0);
});

test('numberedTitle numérote sans jamais doubler le préfixe', () => {
  assert.equal(numberedTitle('Trier les outils', 0), '1. Trier les outils');
  assert.equal(numberedTitle('1. Trier les outils', 1), '2. Trier les outils');
  assert.equal(stripOrderPrefix('3) Ranger les étagères'), 'Ranger les étagères');
});

test('buildDecomposeDigest liste les sous-tâches existantes', () => {
  const task = makeTask({ description: 'Trier les cartons et les outils' });
  const child = makeTask({
    id: 'c1',
    content: 'Sortir les cartons',
    display_title: 'Sortir les cartons',
    parent_id: 't1',
  });
  const digest = buildDecomposeDigest(task, makeSnapshot(task, [child]), { maxItems: 4 });

  assert.equal(digest.max_items, 4);
  assert.equal(digest.task.title, 'Ranger la cave');
  assert.deepEqual(digest.task.existing_subtasks, ['Sortir les cartons']);
});

test('buildDecomposePrompt demande des morceaux concrets sans date', () => {
  const task = makeTask();
  const prompt = buildDecomposePrompt(buildDecomposeDigest(task, makeSnapshot(), { maxItems: 3 }));
  assert.match(prompt, /Découpe la tâche/);
  assert.match(prompt, /Pas de dates/);
  assert.match(prompt, /2 à 3 sous-tâches/);
});

test('validateDecomposeResponse crée une proposition de découpage', () => {
  const task = makeTask();
  const digest = buildDecomposeDigest(task, makeSnapshot(), { maxItems: 5 });

  const { item, dropped } = validateDecomposeResponse(
    {
      summary: 'Trois morceaux pour démarrer facilement.',
      subtasks: ['Trier les outils', 'Descendre les cartons', 'Ranger les étagères'],
    },
    task,
    digest
  );

  assert.equal(dropped, 0);
  assert.equal(item.type, 'split_task');
  assert.equal(item.action_label, 'Créer les sous-tâches');
  assert.deepEqual(item.action.subtasks, [
    '1. Trier les outils',
    '2. Descendre les cartons',
    '3. Ranger les étagères',
  ]);
  assert.match(item.preview, /3 sous-tâche/);
});

test('validateDecomposeResponse déduplique et exige au moins deux morceaux', () => {
  const task = makeTask();
  const child = makeTask({
    id: 'c1',
    content: 'Trier les outils',
    display_title: 'Trier les outils',
    parent_id: 't1',
  });
  const digest = buildDecomposeDigest(task, makeSnapshot(task, [child]), { maxItems: 5 });

  const duplicate = validateDecomposeResponse(
    { subtasks: ['Trier les outils', 'Trier les outils', 'Ranger'] },
    task,
    digest
  );
  assert.equal(duplicate.item, null);

  const short = validateDecomposeResponse({ subtasks: ['ab', 'cd'] }, task, digest);
  assert.equal(short.item, null);

  const ok = validateDecomposeResponse(
    {
      subtasks: [
        'Trier les outils',
        'Ranger les étagères',
        'Passer un coup de balai',
        'Ranger les étagères',
      ],
    },
    task,
    digest
  );
  assert.deepEqual(ok.item.action.subtasks, [
    '1. Ranger les étagères',
    '2. Passer un coup de balai',
  ]);
});

test('validateDecomposeResponse respecte le maximum demandé', () => {
  const task = makeTask();
  const digest = buildDecomposeDigest(task, makeSnapshot(), { maxItems: 2 });
  const { item } = validateDecomposeResponse(
    { subtasks: ['Premier', 'Deuxième', 'Troisième'] },
    task,
    digest
  );
  assert.deepEqual(item.action.subtasks, ['1. Premier', '2. Deuxième']);
});
