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
  clampScheduleToNow,
  subtasksFirstOrder,
  orderExecution,
  buildScheduleVariants,
  buildPostponePlan,
  suggestPostponeDate,
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
  // Les sous-tâches font désormais partie du plan pour passer avant le parent.
  assert.deepEqual(tasks.map((item) => item.id).sort(), ['late', 'p', 'prep', 'sub']);
  const prepMeta = tasks.find((item) => item.id === 'prep');
  assert.equal(prepMeta.is_prep, true);
  assert.equal(prepMeta.parent_title, 'Parent');
  const subMeta = tasks.find((item) => item.id === 'sub');
  assert.equal(subMeta.is_subtask, true);
  assert.equal(subMeta.depth, 1);
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

test('clampScheduleToNow décale un début déjà passé à l’heure actuelle', () => {
  const now = new Date('2026-11-07T13:03:00Z'); // 14:03 à Paris
  const schedule = normalizeSchedule({
    phoneStart: '09:00',
    otherStart: '11:00',
    end: '17:00',
    lunchStart: '12:00',
    lunchEnd: '13:00',
    breakMinutes: 10,
  });
  const clamped = clampScheduleToNow(schedule, '2026-11-07', {
    timeZone: 'Europe/Paris',
    now,
  });
  assert.equal(clamped.phoneStart, '14:05');
  assert.equal(clamped.otherStart, '14:05');
  assert.equal(clamped.end, '17:00');
});

test('clampScheduleToNow ne recule jamais un début déjà plus tard', () => {
  const now = new Date('2026-11-07T13:03:00Z');
  const clamped = clampScheduleToNow(
    normalizeSchedule({
      phoneStart: '15:00',
      otherStart: '16:00',
      end: '18:00',
      lunchStart: '12:00',
      lunchEnd: '13:00',
    }),
    '2026-11-07',
    { timeZone: 'Europe/Paris', now }
  );
  assert.equal(clamped.phoneStart, '15:00');
  assert.equal(clamped.otherStart, '16:00');
});

test('clampScheduleToNow ignore les autres jours et la fin de journée', () => {
  const now = new Date('2026-11-07T13:03:00Z');
  const schedule = normalizeSchedule({ phoneStart: '09:00', otherStart: '11:00' });
  assert.equal(
    clampScheduleToNow(schedule, '2026-11-08', { timeZone: 'Europe/Paris', now })
      .phoneStart,
    '09:00'
  );
  assert.equal(
    clampScheduleToNow(schedule, '2026-11-06', { timeZone: 'Europe/Paris', now })
      .phoneStart,
    '09:00'
  );

  const evening = new Date('2026-11-07T17:30:00Z'); // 18:30 à Paris
  assert.equal(
    clampScheduleToNow(schedule, '2026-11-07', {
      timeZone: 'Europe/Paris',
      now: evening,
    }).phoneStart,
    '09:00'
  );
});

function dayTask(id, priority, size, minutes, title = id) {
  return {
    id,
    title,
    priority,
    priority_label: `P${5 - priority}`,
    size,
    minutes,
    context: 'other',
  };
}

test('buildPostponePlan garde les tâches prioritaires et propose le débordement', () => {
  const tasks = [
    dayTask('important', 4, 'L', 60, 'Tâche importante'),
    dayTask('secondaire', 1, 'L', 60, 'Tâche secondaire'),
  ];
  const schedule = normalizeSchedule({
    phoneStart: '16:00',
    otherStart: '16:00',
    end: '17:00',
    lunchStart: '12:00',
    lunchEnd: '13:00',
    breakMinutes: 0,
  });
  const postpone = buildPostponePlan(tasks, schedule, null, '2026-11-07');
  assert.equal(postpone.length, 1);
  assert.equal(postpone[0].task_id, 'secondaire');
  assert.equal(postpone[0].over_minutes, 60);
  assert.equal(postpone[0].priority_label, 'P4');
});

test('buildPostponePlan ne propose rien quand tout tient', () => {
  const tasks = [dayTask('a', 4, 'S', 15), dayTask('b', 2, 'S', 15)];
  const schedule = normalizeSchedule({
    phoneStart: '09:00',
    otherStart: '09:00',
    end: '17:00',
    lunchStart: '12:00',
    lunchEnd: '13:00',
    breakMinutes: 0,
  });
  assert.deepEqual(buildPostponePlan(tasks, schedule, null, '2026-11-07'), []);
});

test('subtasksFirstOrder place le niveau le plus profond avant les parents', () => {
  const tasks = [
    { id: 'parent', parent_id: null, title: 'Parent' },
    { id: 'a', parent_id: 'parent', title: 'A' },
    { id: 'b', parent_id: 'parent', title: 'B' },
    { id: 'a1', parent_id: 'a', title: 'A1' },
  ];
  assert.deepEqual(
    subtasksFirstOrder(tasks).map((task) => task.id),
    ['a1', 'a', 'b', 'parent']
  );
});

test('priorityOrder garde une sous-tâche avant son parent prioritaire', () => {
  const tasks = [
    { id: 'parent', parent_id: null, title: 'Parent', priority: 4, priority_label: 'P1' },
    { id: 'child', parent_id: 'parent', title: 'Enfant', priority: 1, priority_label: 'P4' },
  ];
  assert.deepEqual(
    priorityOrder(tasks).map((task) => task.id),
    ['child', 'parent']
  );
});

test('orderExecution remonte les sous-tâches avant leur parent', () => {
  const tasks = [
    { id: 'parent', parent_id: null, title: 'Parent' },
    { id: 'child', parent_id: 'parent', title: 'Enfant' },
  ];
  const execution = [
    { id: 'parent', why: null, minutes: 30, context: 'other' },
    { id: 'child', why: null, minutes: 15, context: 'other' },
  ];
  assert.deepEqual(
    orderExecution(execution, tasks).map((entry) => entry.id),
    ['child', 'parent']
  );
});

test('la variante « courtes d’abord » garde les sous-tâches avant le parent', () => {
  const tasks = [
    {
      id: 'parent',
      title: 'Parent',
      parent_id: null,
      is_subtask: false,
      priority: 1,
      minutes: 15,
      context: 'other',
    },
    {
      id: 'child',
      title: 'Enfant long',
      parent_id: 'parent',
      is_subtask: true,
      priority: 1,
      minutes: 60,
      context: 'other',
    },
  ];
  const variants = buildScheduleVariants(tasks, [
    { id: 'parent', minutes: 15, context: 'other' },
    { id: 'child', minutes: 60, context: 'other' },
  ]);
  const court = variants.find((variant) => variant.key === 'court');
  assert.deepEqual(
    court.items.map((item) => item.id),
    ['child', 'parent']
  );
});

test('listDayTasks inclut tout l’arbre des sous-tâches, même sans échéance', () => {
  const tasks = listDayTasks(
    snapshot([
      task({ id: 'parent', display_title: 'Parent' }),
      task({ id: 'child', display_title: 'Enfant', parent_id: 'parent', due_date: '2026-11-06' }),
      task({ id: 'grandchild', display_title: 'Petit-enfant', parent_id: 'child', due_date: null }),
    ]),
    TODAY
  );
  assert.deepEqual(
    tasks.map((item) => item.id),
    ['parent', 'child', 'grandchild']
  );
  assert.deepEqual(
    tasks.map((item) => item.depth),
    [0, 1, 2]
  );
  assert.equal(tasks[1].parent_id, 'parent');
  assert.equal(tasks[2].is_subtask, true);
});

test('une tâche parente ne prend pas de créneau et finit avec sa dernière sous-tâche', () => {
  const tasks = [
    { ...dayTask('parent', 1, 'L', 60, 'Parent'), parent_id: null, is_subtask: false },
    { ...dayTask('child', 1, 'L', 60, 'Enfant'), parent_id: 'parent', is_subtask: true },
  ];
  const variants = buildScheduleVariants(tasks, [
    { id: 'child', minutes: 60, context: 'other' },
    { id: 'parent', minutes: 60, context: 'other' },
  ], {
    phoneStart: '16:00',
    otherStart: '16:00',
    end: '17:00',
    lunchStart: '12:00',
    lunchEnd: '13:00',
    breakMinutes: 0,
  });
  const variant = variants.find((item) => item.key === 'priorite');
  const parent = variant.items.find((item) => item.id === 'parent');
  const child = variant.items.find((item) => item.id === 'child');
  assert.equal(child.start, '16:00');
  assert.equal(child.end, '17:00');
  assert.equal(parent.container, true);
  assert.equal(parent.minutes, 0);
  assert.equal(parent.start, '17:00');
  assert.equal(parent.end, '17:00');
  assert.deepEqual(buildPostponePlan(tasks, {
    phoneStart: '16:00',
    otherStart: '16:00',
    end: '17:00',
    lunchStart: '12:00',
    lunchEnd: '13:00',
    breakMinutes: 0,
  }, null, '2026-11-07'), []);
});

test('aucun horaire ne dépasse la fin de journée ni 24 h', () => {
  const tasks = Array.from({ length: 12 }, (_, index) =>
    dayTask(`t${index}`, 2, 'L', 60, `Tâche ${index}`)
  );
  const execution = tasks.map((task) => ({
    id: task.id,
    minutes: task.minutes,
    context: 'other',
  }));
  const variants = buildScheduleVariants(tasks, execution, {
    phoneStart: '09:00',
    otherStart: '09:00',
    end: '17:00',
    breakMinutes: 10,
    lunchStart: '12:00',
    lunchEnd: '13:00',
  });
  const variant = variants.find((item) => item.key === 'priorite');
  assert.ok(variant.items.some((item) => item.unscheduled));
  for (const item of variant.items) {
    if (item.start) {
      assert.match(item.start, /^([01]\d|2[0-3]):[0-5]\d$/);
      assert.match(item.end, /^([01]\d|2[0-3]):[0-5]\d$/);
      assert.ok(item.end <= '17:00');
    } else {
      assert.equal(item.end, null);
    }
  }
  assert.ok(variant.end <= '17:00');
});

test('une partie des sous-tâches reste planifiée, le parent passe au report', () => {
  const tasks = [
    {
      ...dayTask('parent', 1, 'L', 30, 'Parent'),
      parent_id: null,
      is_subtask: false,
    },
    {
      ...dayTask('c1', 1, 'M', 60, 'Enfant 1'),
      parent_id: 'parent',
      is_subtask: true,
    },
    {
      ...dayTask('c2', 1, 'L', 120, 'Enfant 2'),
      parent_id: 'parent',
      is_subtask: true,
    },
  ];
  const schedule = {
    phoneStart: '09:00',
    otherStart: '09:00',
    end: '11:00',
    breakMinutes: 0,
    lunchStart: '12:00',
    lunchEnd: '13:00',
  };
  const postpone = buildPostponePlan(tasks, schedule, null, '2026-11-07');
  assert.equal(postpone.length, 1);
  assert.equal(postpone[0].task_id, 'parent');
  assert.equal(postpone[0].scheduled_count, 1);
  assert.equal(postpone[0].unscheduled_count, 1);
  assert.deepEqual(postpone[0].also_task_ids, ['c2']);
  assert.equal(postpone[0].over_minutes, 120);
});

test('suggestPostponeDate choisit le premier jour qui a encore de la place', () => {
  const snapshot = {
    capacity: {
      rule: { L: 1, M: 3, S: 5 },
      days: [
        { date: '2026-11-08', remaining: { L: 0, M: 1, S: 2 } },
        { date: '2026-11-09', remaining: { L: 1, M: 3, S: 5 } },
      ],
    },
  };
  assert.equal(suggestPostponeDate(snapshot, '2026-11-07', 'M'), '2026-11-08');
  assert.equal(suggestPostponeDate(snapshot, '2026-11-07', 'L'), '2026-11-09');
  assert.equal(suggestPostponeDate(null, '2026-11-07', 'M'), '2026-11-08');
});
