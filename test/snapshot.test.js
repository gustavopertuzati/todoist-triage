'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSnapshot } = require('../src/snapshot');

const TODAY = '2026-11-04';

function fixture() {
  return {
    sync: {
      user: { id: 'u1', full_name: 'Test', email: 'test@example.com', tz_info: { timezone: 'Europe/Paris' } },
      projects: [
        { id: 'p1', name: 'Maison', color: 'red', created_at: '2025-12-01T10:00:00Z', order_key: 'a1', is_archived: false },
        { id: 'p2', name: 'Travail', color: 'blue', created_at: '2026-06-01T10:00:00Z', order_key: 'a2', is_archived: false },
        { id: 'p3', name: 'Ancien projet', color: 'grey', created_at: '2024-01-01T10:00:00Z', order_key: 'a3', is_archived: true },
        { id: 'p4', name: 'Vide', color: 'green', created_at: '2026-01-01T10:00:00Z', order_key: 'a4', is_archived: false },
      ],
      sections: [
        { id: 's1', project_id: 'p1', name: 'Courses', section_order: 1 },
        { id: 's2', project_id: 'p1', name: 'Maison', section_order: 2 },
        { id: 's3', project_id: 'p3', name: 'Archivée', section_order: 1 },
      ],
      labels: [{ id: 'l1', name: 'maison', color: 'red', order: 1 }],
      items: [
        {
          id: 't1', project_id: 'p1', section_id: 's1', parent_id: null,
          content: 'Appeler le garage 11.10.2026', description: '', priority: 4,
          labels: ['maison'], due: null, added_at: '2025-01-01T10:00:00Z',
          updated_at: '2026-09-01T10:00:00Z', child_order: 1,
        },
        {
          id: 't5', project_id: 'p1', section_id: 's1', parent_id: 't1',
          content: 'Préparer les papiers auj', description: '', priority: 1,
          labels: [], due: null, added_at: '2026-10-01T10:00:00Z',
          updated_at: '2026-10-02T10:00:00Z', child_order: 2,
        },
        {
          id: 't2', project_id: 'p1', section_id: 's2', parent_id: null,
          content: 'Payer la facture auj', description: 'Facture EDF', priority: 2,
          labels: [], due: null, added_at: '2026-09-01T10:00:00Z',
          updated_at: '2026-09-02T10:00:00Z', child_order: 3,
        },
        {
          id: 't4', project_id: 'p1', section_id: null, parent_id: null,
          content: 'Tâche due today', description: '', priority: 1,
          labels: [], due: { date: '2026-11-04', is_recurring: false, string: 'auj.' },
          added_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-03T10:00:00Z', child_order: 4,
        },
        {
          id: 't3', project_id: 'p2', section_id: null, parent_id: null,
          content: 'Tâche en retard', description: '', priority: 3,
          labels: [], due: { date: '2026-11-01', is_recurring: false, string: '1 nov.' },
          added_at: '2026-09-01T10:00:00Z', updated_at: '2026-10-01T10:00:00Z', child_order: 1,
        },
        {
          id: 't6', project_id: 'p2', section_id: null, parent_id: null,
          content: 'Conflit 12.11.2026', description: '', priority: 1,
          labels: [], due: { date: '2026-11-10', is_recurring: false, string: '10 nov.' },
          added_at: '2026-09-01T10:00:00Z', updated_at: '2026-10-01T10:00:00Z', child_order: 2,
        },
        {
          id: 't8', project_id: 'p2', section_id: null, parent_id: null,
          content: 'Sans date', description: '', priority: 1,
          labels: [], due: null, added_at: '2026-09-01T10:00:00Z',
          updated_at: '2026-10-01T10:00:00Z', child_order: 3,
        },
        {
          id: 't7', project_id: 'p3', section_id: 's3', parent_id: null,
          content: 'Vieille archive', description: '', priority: 1,
          labels: [], due: null, added_at: '2024-01-01T10:00:00Z',
          updated_at: '2024-01-01T10:00:00Z', child_order: 1,
        },
      ],
    },
    completed: {
      items: [
        { id: 'c1', project_id: 'p2', completed_at: '2026-10-20T10:00:00Z' },
      ],
      truncated: false,
    },
    today: TODAY,
    timezone: 'Europe/Paris',
    warnings: [],
    completedLookbackDays: 90,
    oldTaskDays: 180,
    noProgressMinAgeDays: 30,
    generatedAt: '2026-11-04T12:00:00.000Z',
    appVersion: '0.1.0',
  };
}

test('calcule les compteurs principaux sans compter les projets archivés', () => {
  const snapshot = buildSnapshot(fixture());
  const { summary } = snapshot;

  assert.equal(summary.projects_total, 3);
  assert.equal(summary.projects_archived, 1);
  assert.equal(summary.projects_empty, 1);
  assert.equal(summary.projects_no_progress, 1);
  assert.equal(summary.sections_total, 2);
  assert.equal(summary.tasks_total, 7);
  assert.equal(summary.subtasks_total, 1);
  assert.equal(summary.overdue_total, 1);
  assert.equal(summary.due_today_total, 1);
  assert.equal(summary.no_due_total, 4);
  assert.equal(summary.title_dates_total, 4);
  assert.equal(summary.title_dates_today, 2);
  assert.equal(summary.conflicts_total, 1);
  assert.equal(summary.completed_lookback_total, 1);
  assert.deepEqual(summary.priority, { p1: 1, p2: 1, p3: 1, p4: 4 });
  assert.deepEqual(summary.labels_top, [{ name: 'maison', count: 1 }]);
});

test('dérive correctement les champs de la convention de date', () => {
  const snapshot = buildSnapshot(fixture());
  const byId = Object.fromEntries(snapshot.tasks.map((task) => [task.id, task]));

  assert.equal(byId.t1.display_title, 'Appeler le garage');
  assert.equal(byId.t1.title_due_date, '2026-10-11');
  assert.equal(byId.t1.due_source, 'title');
  assert.equal(byId.t1.needs_apply, true);

  assert.equal(byId.t2.title_due_today, true);
  assert.equal(byId.t2.display_title, 'Payer la facture');

  assert.equal(byId.t3.is_overdue, true);
  assert.equal(byId.t3.days_overdue, 3);

  assert.equal(byId.t4.is_due_today, true);

  assert.equal(byId.t6.conflict, true);
  assert.equal(byId.t6.needs_apply, true);
  assert.equal(byId.t6.display_title, 'Conflit');
  assert.equal(byId.t6.due_date, '2026-11-10');
  assert.equal(byId.t6.title_due_date, '2026-11-12');

  assert.equal(byId.t5.is_subtask, true);
  assert.equal(byId.t5.title_due_today, true);
});

test('marque les tâches des projets archivés sans les compter dans le résumé', () => {
  const snapshot = buildSnapshot(fixture());
  const archivedTask = snapshot.tasks.find((task) => task.id === 't7');
  const archivedProject = snapshot.projects.find((project) => project.id === 'p3');

  assert.equal(archivedTask.project_archived, true);
  assert.equal(archivedProject.is_archived, true);
  assert.equal(archivedProject.stats.tasks, 1);
});

test('identifie les projets vides et sans progression', () => {
  const snapshot = buildSnapshot(fixture());
  const byId = Object.fromEntries(snapshot.projects.map((project) => [project.id, project]));

  assert.equal(byId.p4.stats.empty, true);
  assert.equal(byId.p1.stats.no_progress, true);
  assert.equal(byId.p2.stats.no_progress, false);
  assert.equal(byId.p2.stats.completed_lookback, 1);
  assert.equal(byId.p2.stats.last_completed_at, '2026-10-20T10:00:00Z');
});

test('signale l’absence d’historique sans faire échouer l’instantané', () => {
  const input = fixture();
  input.completed = null;
  const snapshot = buildSnapshot(input);
  assert.equal(snapshot.meta.completed_available, false);
  assert.equal(snapshot.summary.completed_lookback_total, null);
  assert.equal(snapshot.projects.find((project) => project.id === 'p1').stats.no_progress, false);
  assert.ok(snapshot.meta.warnings.some((warning) => /terminées/i.test(warning)));
});

test('attache un diagnostic à chaque projet et l’agrège dans le résumé', () => {
  const snapshot = buildSnapshot(fixture());
  const byId = Object.fromEntries(snapshot.projects.map((project) => [project.id, project]));

  assert.equal(byId.p4.diagnosis.verdict, 'empty');
  assert.equal(byId.p4.diagnosis.proposal.code, 'archive');
  assert.equal(byId.p1.diagnosis.verdict, 'dormant');
  assert.equal(byId.p2.diagnosis.verdict, 'healthy');

  const plan = snapshot.summary.project_diagnosis;
  assert.equal(plan.total, 3);
  assert.equal(plan.counts.archive, 1);
  assert.equal(plan.counts.review, 1);
  assert.equal(plan.counts.healthy, 1);
  assert.ok(plan.actions.some((action) => action.key === 'archive' && action.count === 1));
});

test('génère des propositions et les résume', () => {
  const snapshot = buildSnapshot(fixture());
  assert.ok(Array.isArray(snapshot.proposals));
  const types = new Set(snapshot.proposals.map((proposal) => proposal.type));
  assert.ok(types.has('reschedule_overdue'));
  assert.ok(types.has('set_due_date'));
  assert.ok(types.has('archive_project'));

  const late = snapshot.proposals.find((p) => p.type === 'reschedule_overdue');
  assert.equal(late.target.id, 't3');
  assert.equal(late.action.due_date, TODAY);

  assert.equal(snapshot.summary.proposals.total, snapshot.proposals.length);
});

test('expose un plan de charge journalière (règle 1-3-5)', () => {
  const snapshot = buildSnapshot(fixture());
  assert.ok(Array.isArray(snapshot.capacity.days));
  assert.equal(snapshot.capacity.days.length, 14);
  assert.deepEqual(snapshot.capacity.rule, { L: 1, M: 3, S: 5 });
  assert.deepEqual(snapshot.meta.capacity_rule, { L: 1, M: 3, S: 5 });

  // Le 4 novembre porte une tâche (t4, échéance aujourd'hui).
  const today = snapshot.capacity.days[0];
  assert.equal(today.date, TODAY);
  assert.equal(today.total, 1);

  // Chaque tâche expose sa taille estimée.
  assert.ok(snapshot.tasks.every((task) => typeof task.subtask_count === 'number'));
});

