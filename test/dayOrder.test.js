'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  listDayTasks,
  priorityOrder,
  buildDayOrderDigest,
  buildOrderPrompt,
  validateOrderResponse,
  normalizeSchedule,
  buildScheduleVariants,
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
    { id: 'b', why: 'urgent', minutes: 30, context: 'other' },
    { id: 'a', why: null, minutes: 30, context: 'other' },
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
    { id: 'a', why: null, minutes: 30, context: 'other' },
    { id: 'b', why: null, minutes: 30, context: 'other' },
  ]);
});

test('les durées et contextes par défaut sont exploitables', () => {
  const tasks = listDayTasks(
    snapshot([
      task({
        id: 'phone',
        display_title: 'Appeler le dentiste',
        priority: 4,
        priority_label: 'P1',
        duration: { amount: 20, unit: 'minute' },
      }),
      task({
        id: 'home',
        display_title: 'Ranger la cave',
        priority: 2,
        priority_label: 'P3',
        duration: { amount: 1, unit: 'hour' },
      }),
    ]),
    TODAY
  );
  const phone = tasks.find((item) => item.id === 'phone');
  const home = tasks.find((item) => item.id === 'home');
  assert.equal(phone.context, 'phone');
  assert.equal(home.context, 'other');
  assert.equal(phone.minutes, 20);
  assert.equal(home.minutes, 60);
});

test('buildScheduleVariants place le téléphone à 9h et le reste à 11h', () => {
  const tasks = [
    {
      id: 'phone',
      title: 'Appeler',
      priority: 4,
      priority_label: 'P1',
      minutes: 20,
      context: 'phone',
      overdue: false,
      is_prep: false,
      parent_title: null,
    },
    {
      id: 'cave',
      title: 'Ranger la cave',
      priority: 2,
      priority_label: 'P3',
      minutes: 60,
      context: 'other',
      overdue: false,
      is_prep: false,
      parent_title: null,
    },
  ];
  const execution = [
    { id: 'phone', why: null, minutes: 20, context: 'phone' },
    { id: 'cave', why: null, minutes: 60, context: 'other' },
  ];
  const variants = buildScheduleVariants(tasks, execution);
  const equilibre = variants.find((variant) => variant.key === 'equilibre');
  assert.equal(equilibre.items[0].start, '09:00');
  assert.equal(equilibre.items[0].end, '09:20');
  assert.equal(equilibre.items[1].start, '11:00');
  assert.equal(equilibre.items[1].end, '12:00');
  assert.equal(equilibre.overflow_minutes, 0);

  const decale = variants.find((variant) => variant.key === 'decale');
  assert.equal(decale.items[0].start, '10:00');
  // 11:30 + 60 min chevaucherait la pause déjeuner (12:00–13:00).
  assert.equal(decale.items[1].start, '13:00');
});

test('normalizeSchedule valide et corrige les horaires et pauses', () => {
  assert.deepEqual(normalizeSchedule({ phoneStart: '08:30', otherStart: '10:00', end: '16:00' }), {
    phoneStart: '08:30',
    otherStart: '10:00',
    end: '16:00',
    breakMinutes: 10,
    lunchStart: '12:00',
    lunchEnd: '13:00',
  });
  assert.deepEqual(normalizeSchedule({ phoneStart: '18:00', otherStart: '11:00', end: '17:00' }), {
    phoneStart: '09:00',
    otherStart: '11:00',
    end: '17:00',
    breakMinutes: 10,
    lunchStart: '12:00',
    lunchEnd: '13:00',
  });
  assert.deepEqual(normalizeSchedule({}), {
    phoneStart: '09:00',
    otherStart: '11:00',
    end: '17:00',
    breakMinutes: 10,
    lunchStart: '12:00',
    lunchEnd: '13:00',
  });
});

test('buildScheduleVariants respecte des horaires personnalisés', () => {
  const tasks = [
    {
      id: 'phone',
      title: 'Appel',
      priority: 4,
      priority_label: 'P1',
      minutes: 30,
      context: 'phone',
      overdue: false,
      is_prep: false,
      parent_title: null,
    },
    {
      id: 'other',
      title: 'Ranger',
      priority: 2,
      priority_label: 'P3',
      minutes: 60,
      context: 'other',
      overdue: false,
      is_prep: false,
      parent_title: null,
    },
  ];
  const execution = [
    { id: 'phone', why: null, minutes: 30, context: 'phone' },
    { id: 'other', why: null, minutes: 60, context: 'other' },
  ];
  const equilibre = buildScheduleVariants(tasks, execution, {
    phoneStart: '10:00',
    otherStart: '12:00',
    end: '16:00',
  }).find((variant) => variant.key === 'equilibre');
  assert.equal(equilibre.items[0].start, '10:00');
  assert.equal(equilibre.items[0].end, '10:30');
  // Début demandé à 12:00 = pendant la pause déjeuner → repoussé à 13:00.
  assert.equal(equilibre.items[1].start, '13:00');
  assert.equal(equilibre.items[1].end, '14:00');
});

test('les tâches non-téléphone ne chevauchent pas une longue plage téléphone', () => {
  const tasks = [
    {
      id: 'phone',
      title: 'Appels',
      priority: 4,
      priority_label: 'P1',
      minutes: 180,
      context: 'phone',
      overdue: false,
      is_prep: false,
      parent_title: null,
    },
    {
      id: 'other',
      title: 'Ranger',
      priority: 1,
      priority_label: 'P4',
      minutes: 60,
      context: 'other',
      overdue: false,
      is_prep: false,
      parent_title: null,
    },
  ];
  const execution = [
    { id: 'phone', why: null, minutes: 180, context: 'phone' },
    { id: 'other', why: null, minutes: 60, context: 'other' },
  ];
  const equilibre = buildScheduleVariants(tasks, execution).find(
    (variant) => variant.key === 'equilibre'
  );
  assert.equal(equilibre.items[0].start, '09:00');
  assert.equal(equilibre.items[0].end, '12:00');
  assert.equal(equilibre.items[1].start, '13:00');
});

test('les pauses entre tâches et la pause déjeuner sont respectées', () => {
  const tasks = [
    {
      id: 'a',
      title: 'A',
      priority: 4,
      priority_label: 'P1',
      minutes: 30,
      context: 'other',
      overdue: false,
      is_prep: false,
      parent_title: null,
    },
    {
      id: 'b',
      title: 'B',
      priority: 3,
      priority_label: 'P2',
      minutes: 30,
      context: 'other',
      overdue: false,
      is_prep: false,
      parent_title: null,
    },
  ];
  const execution = [
    { id: 'a', why: null, minutes: 30, context: 'other' },
    { id: 'b', why: null, minutes: 30, context: 'other' },
  ];
  const equilibre = buildScheduleVariants(tasks, execution, {
    otherStart: '11:00',
    end: '17:00',
    breakMinutes: 10,
    lunchStart: '12:00',
    lunchEnd: '13:00',
  }).find((variant) => variant.key === 'equilibre');

  assert.equal(equilibre.items[0].start, '11:00');
  assert.equal(equilibre.items[0].end, '11:30');
  // 10 min de pause, puis la tâche suivante tombe dans le déjeuner.
  assert.equal(equilibre.items[1].start, '13:00');
});
