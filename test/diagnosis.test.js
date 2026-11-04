'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  THRESHOLDS,
  diagnoseProject,
  buildProjectDiagnosis,
  bucketForVerdict,
} = require('../src/diagnosis');

const CONTEXT = { completedLookbackDays: 90, noProgressMinAgeDays: 30 };

function stats(overrides = {}) {
  return {
    tasks: 5,
    top_level_tasks: 5,
    subtasks: 0,
    overdue: 0,
    due_today: 0,
    no_due: 0,
    completed_lookback: 2,
    last_completed_at: null,
    sections: 1,
    project_age_days: 120,
    empty: false,
    no_progress: false,
    days_since_activity: 3,
    no_due_ratio: 0,
    undated_old: 0,
    ...overrides,
  };
}

function project(overrides = {}) {
  return { id: 'p1', name: 'Projet', is_inbox: false, is_archived: false, ...overrides };
}

test('un projet actif et équilibré est déclaré sain', () => {
  const diagnosis = diagnoseProject(project(), stats(), CONTEXT);
  assert.equal(diagnosis.verdict, 'healthy');
  assert.equal(diagnosis.score, 0);
  assert.deepEqual(diagnosis.signals, []);
  assert.equal(diagnosis.proposal.code, 'keep');
});

test('un projet sans tâche active est un candidat à l’archivage', () => {
  const diagnosis = diagnoseProject(project(), stats({ tasks: 0, empty: true, completed_lookback: 0 }), CONTEXT);
  assert.equal(diagnosis.verdict, 'empty');
  assert.equal(diagnosis.proposal.code, 'archive');
  assert.equal(diagnosis.signals[0].label, 'Projet vide');
});

test('un Inbox vide n’est pas signalé comme projet vide', () => {
  const diagnosis = diagnoseProject(
    project({ is_inbox: true }),
    stats({ tasks: 0, empty: true, completed_lookback: 0 }),
    CONTEXT
  );
  assert.equal(diagnosis.verdict, 'healthy');
});

test('un projet sans progression est signalé', () => {
  const diagnosis = diagnoseProject(project(), stats({ no_progress: true }), CONTEXT);
  assert.equal(diagnosis.verdict, 'dormant');
  assert.equal(diagnosis.proposal.code, 'review');
  assert.match(diagnosis.signals[0].detail, /aucune terminée/i);
});

test('un projet avec beaucoup de retards alerte', () => {
  const diagnosis = diagnoseProject(
    project(),
    stats({ overdue: THRESHOLDS.overdueMin }),
    CONTEXT
  );
  assert.equal(diagnosis.verdict, 'overdue');
  assert.equal(diagnosis.tone, 'danger');
  assert.equal(diagnosis.proposal.code, 'catch_up');
  assert.ok(diagnosis.score >= 25);
});

test('un projet majoritairement sans échéance est « à dater »', () => {
  const diagnosis = diagnoseProject(
    project(),
    stats({ tasks: 20, no_due: 15, no_due_ratio: 15 / 20 }),
    CONTEXT
  );
  assert.equal(diagnosis.verdict, 'undated');
  assert.equal(diagnosis.proposal.code, 'schedule');
});

test('un projet très chargé est signalé comme surchargé', () => {
  const diagnosis = diagnoseProject(
    project(),
    stats({ tasks: THRESHOLDS.congestedMin }),
    CONTEXT
  );
  assert.equal(diagnosis.verdict, 'congested');
  assert.equal(diagnosis.proposal.code, 'split');
});

test('le verdict retenu est le signal le plus grave', () => {
  const diagnosis = diagnoseProject(
    project(),
    stats({ no_progress: true, overdue: 15, tasks: 60 }),
    CONTEXT
  );
  // Retards (25 + 15) passe devant « sans progression » et « surchargé ».
  assert.equal(diagnosis.verdict, 'overdue');
  assert.ok(diagnosis.signals.length >= 3);
});

test('buildProjectDiagnosis regroupe par action et ignore les archives', () => {
  const projects = [
    { id: 'a', is_archived: false, diagnosis: { verdict: 'empty' } },
    { id: 'b', is_archived: false, diagnosis: { verdict: 'dormant' } },
    { id: 'c', is_archived: false, diagnosis: { verdict: 'stale' } },
    { id: 'd', is_archived: false, diagnosis: { verdict: 'overdue' } },
    { id: 'e', is_archived: false, diagnosis: { verdict: 'healthy' } },
    { id: 'f', is_archived: true, diagnosis: { verdict: 'empty' } },
  ];
  const summary = buildProjectDiagnosis(projects);

  assert.equal(summary.total, 5);
  assert.equal(summary.counts.all, 5);
  assert.equal(summary.counts.archive, 1);
  assert.equal(summary.counts.review, 2); // dormant + stale
  assert.equal(summary.counts.catch_up, 1);
  assert.equal(summary.counts.healthy, 1);
  assert.equal(bucketForVerdict('stale'), 'review');
  assert.equal(summary.by_verdict.stale, 1);
});
