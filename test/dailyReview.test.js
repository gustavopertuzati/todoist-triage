'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const review = require('../src/dailyReview');
const { readGoals, writeGoalPaces } = require('../src/goals');

const GOALS = [
  {
    id: 'reading',
    title: 'Lire 7 livres',
    description: '40 pages par jour',
    keywords: ['lire', 'lecture', 'livre', 'pages'],
    confirmed: true,
    milestones: [],
  },
];

function snapshotWith(tasks, completed = []) {
  return {
    meta: { today: '2026-11-16', timezone: 'Europe/Paris' },
    tasks: tasks.map((task) => ({
      id: 't1',
      content: task.title,
      display_title: task.title,
      due_date: task.due,
      project_name: 'Lecture',
      labels: [],
      project_archived: false,
      due_is_recurring: Boolean(task.recurring),
      ...task,
    })),
    completed: { recent: completed },
  };
}

function stateWithTask(task = {}) {
  return {
    version: 1,
    reviews: {},
    tasks: {
      lire: {
        task_key: 'lire',
        task_id: 't1',
        title: 'Lire 40 pages',
        goal_id: 'reading',
        unit: 'pages',
        base: 40,
        current: 20,
        success_streak: 0,
        fail_streak: 1,
        last_result: 'failed',
        last_target_date: '2026-11-16',
        last_success_date: null,
        recurring: true,
        history: [],
        ...task,
      },
    },
    goals: {
      reading: {
        id: 'reading',
        title: 'Lire 7 livres',
        unit: 'pages',
        base: 40,
        current: 20,
        success_streak: 0,
        fail_streak: 1,
        paused_until: null,
        history: [],
      },
    },
    days: {},
  };
}

test('parseQuantity reconnaît les quantités utiles sans confondre les heures', () => {
  assert.deepEqual(
    { value: review.parseQuantity('Lire 40 pages').value, unit: 'pages' },
    { value: 40, unit: 'pages' }
  );
  assert.equal(review.parseQuantity('Faire 30 min de sport').unit, 'minutes');
  assert.equal(review.parseQuantity('Faire 3 tests iTheorie').value, 3);
  assert.equal(review.parseQuantity('Rendez-vous à 20 h'), null);
  assert.equal(review.parseQuantity('Lire pendant 2 heures').unit, 'heures');
  assert.equal(review.parseQuantity('Appeler le garage'), null);
});

test('replaceQuantity conserve le reste du titre et taskKey ignore la quantité', () => {
  assert.equal(review.replaceQuantity('Lire 40 pages', 20), 'Lire 20 pages');
  assert.equal(review.replaceQuantity('Faire 30 min de sport', 15), 'Faire 15 minutes de sport');
  assert.equal(review.taskKey('Lire 40 pages'), 'lire');
  assert.equal(review.taskKey('Lire 20 pages'), 'lire');
  assert.equal(review.taskKey('Faire 30 min de sport'), 'faire de sport');
});

test('lowerQuantity baisse par paliers et raiseQuantity remonte vers l’objectif', () => {
  assert.equal(review.lowerQuantity({ value: 40, unit: 'pages' }), 30);
  assert.equal(review.lowerQuantity({ value: 40, unit: 'pages' }, { ratio: 0.5 }), 20);
  assert.equal(review.lowerQuantity({ value: 40, unit: 'pages' }, { micro: true }), 10);
  assert.equal(review.lowerQuantity({ value: 6, unit: 'pages' }), 5);
  assert.equal(review.lowerQuantity({ value: 2, unit: 'pages' }), 2);
  assert.equal(review.raiseQuantity(20, 40, 'pages'), 25);
  assert.equal(review.raiseQuantity(35, 40, 'pages'), 40);
});

test('goalForTask associe la lecture à l’objectif par mots-clés', () => {
  const goal = review.goalForTask(
    { display_title: 'Lire 40 pages', project_name: 'Lecture', labels: [] },
    GOALS
  );
  assert.equal(goal.id, 'reading');
  assert.equal(review.goalForTask({ display_title: 'Appeler le garage' }, GOALS), null);
});

test('buildReview liste les tâches d’hier non terminées', () => {
  const snapshot = snapshotWith(
    [
      { id: 't1', title: 'Lire 40 pages', due: '2026-11-15', recurring: true },
      { id: 't2', title: 'Appeler le garage', due: '2026-11-16' },
      { id: 't3', title: 'Faire 30 min de sport', due: '2026-11-15' },
    ],
    [{ id: 'c1', title: 'Faire 30 min de sport', completed_at: '2026-11-15T18:00:00Z' }]
  );
  const built = review.buildReview({
    snapshot,
    date: '2026-11-16',
    state: review.emptyState(),
    goals: GOALS,
  });
  assert.equal(built.yesterday, '2026-11-15');
  assert.equal(built.unfinished.length, 2);
  assert.equal(built.pending_count, 2);
  assert.equal(built.completed_count, 1);
  assert.equal(built.unfinished[0].goal_id, 'reading');
  assert.equal(built.unfinished[0].quantity.value, 40);
});

test('« pas la motiv » divise la lecture par deux et met à jour l’objectif', () => {
  const snapshot = snapshotWith([
    { id: 't1', title: 'Lire 40 pages', due: '2026-11-15', recurring: true },
  ]);
  const state = review.emptyState();
  const result = review.applyReview({
    snapshot,
    date: '2026-11-16',
    state,
    goals: GOALS,
    answers: [{ taskId: 't1', reason: 'no_motivation', action: 'auto' }],
  });

  assert.equal(result.graded[0].to, 20);
  assert.equal(state.goals.reading.current, 20);
  assert.equal(result.goal_updates.length, 1);
  assert.equal(result.cap, null);
  assert.equal(result.proposals.length, 2);
  const rename = result.proposals.find((proposal) => proposal.type === 'rename_task');
  assert.equal(rename.action.content, 'Lire 20 pages');
  const move = result.proposals.find((proposal) => proposal.type === 'set_due_date');
  assert.equal(move.action.due_date, '2026-11-16');
  assert.match(result.hints[0], /motivation/i);
});

test('« trop grosse » baisse d’un cran seulement', () => {
  const snapshot = snapshotWith([
    { id: 't1', title: 'Lire 40 pages', due: '2026-11-15' },
  ]);
  const state = review.emptyState();
  const result = review.applyReview({
    snapshot,
    date: '2026-11-16',
    state,
    goals: GOALS,
    answers: [{ taskId: 't1', reason: 'too_big', action: 'auto' }],
  });
  assert.equal(result.graded[0].to, 30);
  assert.equal(state.goals.reading.current, 30);
});

test('« trop de choses » allège la journée sans toucher à la quantité', () => {
  const snapshot = snapshotWith([
    { id: 't1', title: 'Lire 40 pages', due: '2026-11-15' },
  ]);
  const state = review.emptyState();
  const result = review.applyReview({
    snapshot,
    date: '2026-11-16',
    state,
    goals: GOALS,
    answers: [{ taskId: 't1', reason: 'too_many', action: 'auto' }],
  });
  assert.equal(result.graded[0].to, 40);
  assert.equal(result.cap, 3);
  assert.equal(result.proposals.some((proposal) => proposal.type === 'rename_task'), false);
  assert.match(result.hints[0], /3 tâches/i);
});

test('« pas le temps » reporte sans changer l’objectif', () => {
  const snapshot = snapshotWith([
    { id: 't1', title: 'Lire 40 pages', due: '2026-11-15' },
  ]);
  const state = review.emptyState();
  const result = review.applyReview({
    snapshot,
    date: '2026-11-16',
    state,
    goals: GOALS,
    answers: [{ taskId: 't1', reason: 'no_time', action: 'auto' }],
  });
  assert.equal(result.graded[0].to, 40);
  assert.equal(state.goals.reading.current, 40);
  assert.equal(result.goal_updates.length, 0);
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].type, 'set_due_date');
});

test('une tâche non claire peut être reformulée avec la précision donnée', () => {
  const snapshot = snapshotWith([
    { id: 't1', title: 'Ranger', due: '2026-11-15' },
  ]);
  const result = review.applyReview({
    snapshot,
    date: '2026-11-16',
    state: review.emptyState(),
    goals: GOALS,
    answers: [
      {
        taskId: 't1',
        reason: 'unclear',
        action: 'keep',
        note: 'Trier les cartons de la cave',
      },
    ],
  });
  const rename = result.proposals.find((proposal) => proposal.type === 'rename_task');
  assert.equal(rename.action.content, 'Trier les cartons de la cave');
});

test('deux réussites consécutives font remonter le rythme vers l’objectif', () => {
  const state = stateWithTask();
  const dayOne = snapshotWith([], [
    { id: 'c1', title: 'Lire 20 pages', completed_at: '2026-11-16T18:00:00Z' },
  ]);
  const first = review.recordSuccesses({
    snapshot: dayOne,
    state,
    date: '2026-11-17',
    timezone: 'Europe/Paris',
  });
  assert.equal(first.changed, true);
  assert.equal(state.goals.reading.current, 20);
  assert.equal(state.tasks.lire.success_streak, 1);
  assert.equal(state.tasks.lire.last_target_date, '2026-11-17');

  const dayTwo = snapshotWith([], [
    { id: 'c2', title: 'Lire 20 pages', completed_at: '2026-11-17T18:00:00Z' },
  ]);
  const second = review.recordSuccesses({
    snapshot: dayTwo,
    state,
    date: '2026-11-18',
    timezone: 'Europe/Paris',
  });
  assert.equal(second.changed, true);
  assert.equal(state.goals.reading.current, 25);
  assert.ok(second.items.some((item) => item.kind === 'raise'));
});

test('resetGoalPace revient au rythme de départ', () => {
  const state = stateWithTask();
  const reset = review.resetGoalPace(state, 'reading', '2026-11-18');
  assert.equal(reset.current, 40);
  assert.equal(state.goals.reading.current, 40);
});

test('writeGoalPaces met à jour GOALS.json puis readGoals relit le rythme', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-goals-'));
  const file = path.join(dir, 'GOALS.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ updated_at: '2026-11-01', goals: GOALS }, null, 2),
    'utf8'
  );

  const changed = writeGoalPaces(
    [
      {
        id: 'reading',
        pace: {
          value: 20,
          unit: 'pages',
          base: 40,
          updated_at: '2026-11-16T10:00:00.000Z',
          reason: 'Bilan du 2026-11-15',
        },
      },
    ],
    file
  );
  assert.deepEqual(changed, ['reading']);
  const [goal] = readGoals(file);
  assert.equal(goal.pace.value, 20);
  assert.equal(goal.pace.base, 40);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('une tâche sans objectif garde quand même son rythme adapté', () => {
  const snapshot = snapshotWith([
    { id: 't1', title: 'Faire 30 min de sport', due: '2026-11-15' },
  ]);
  const state = review.emptyState();
  const first = review.applyReview({
    snapshot,
    date: '2026-11-16',
    state,
    goals: [],
    answers: [{ taskId: 't1', reason: 'too_big', action: 'auto' }],
  });
  assert.equal(first.graded[0].to, 25);
  assert.equal(state.tasks['faire de sport'].current, 25);
  assert.equal(state.goals.reading, undefined);

  const second = review.applyReview({
    snapshot: snapshotWith([
      { id: 't1', title: 'Faire 30 min de sport', due: '2026-11-15' },
    ]),
    date: '2026-11-16',
    state,
    goals: [],
    answers: [{ taskId: 't1', reason: 'too_big', action: 'auto' }],
  });
  assert.equal(second.graded[0].to, 20);
});

test('reviewContextFor renvoie les consignes et le plafond du jour', () => {
  const context = review.reviewContextFor(
    { days: { '2026-11-16': { hints: ['limiter à 3 tâches'], cap: 3 } } },
    '2026-11-16'
  );
  assert.deepEqual(context.hints, ['limiter à 3 tâches']);
  assert.equal(context.cap, 3);
  assert.deepEqual(review.reviewContextFor({}, '2026-11-16'), { hints: [], cap: null });
});

test('removeReviewProposal retire une action appliquée de la mémoire', () => {
  const state = {
    ...review.emptyState(),
    reviews: {
      '2026-11-15': {
        proposals: [{ id: 'a' }, { id: 'b' }],
      },
    },
  };
  assert.equal(review.removeReviewProposal(state, 'a'), true);
  assert.deepEqual(state.reviews['2026-11-15'].proposals.map((p) => p.id), ['b']);
  assert.equal(review.removeReviewProposal(state, 'inconnu'), false);
});

test('normalizeAnswers ignore les raisons inconnues et déduplique les tâches', () => {
  const answers = review.normalizeAnswers([
    { taskId: 't1', reason: 'too_big', action: 'n_importe_quoi' },
    { taskId: 't1', reason: 'no_time', action: 'move_tomorrow' },
    { taskId: 't2', reason: 'inconnue' },
    { taskId: '', reason: 'too_big' },
  ]);
  assert.equal(answers.length, 1);
  assert.equal(answers[0].reason, 'no_time');
  assert.equal(answers[0].action, 'move_tomorrow');
});
