'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { readGoals, countCompleted, evaluateGoals } = require('../src/goals');
const { normalizeMilestones } = require('../src/goalProposals');

const goal = {
  id: 'g',
  title: 'Objectif test',
  keywords: ['itheorie', 'permis'],
  milestones: [
    { id: 'm1', title: '10 tests', weight: 50, type: 'completed_tasks', count: 2 },
    { id: 'm2', title: 'Examen', weight: 50, type: 'manual' },
  ],
};

const snapshot = {
  projects: [{ id: 'p1', name: 'Permis' }],
  completed: {
    recent: [
      { title: 'Test iTheorie 92%', project_id: 'p1' },
      { title: 'Réviser le permis', project_id: 'p1' },
      { title: 'Faire les courses', project_id: 'p2' },
    ],
  },
};

test('countCompleted compte les tâches liées aux mots-clés', () => {
  assert.equal(countCompleted(snapshot, ['itheorie', 'permis']), 2);
  assert.equal(countCompleted(snapshot, ['inconnu']), 0);
});

test('evaluateGoals calcule les jalons automatiques', () => {
  const [evaluated] = evaluateGoals(snapshot, [goal]);
  assert.equal(evaluated.completed_count, 2);
  assert.equal(evaluated.milestones[0].completed_count, 2);
  assert.equal(evaluated.milestones[0].auto_done, true);
  assert.equal(evaluated.milestones[1].auto_done, false);
});

test('normalizeMilestones normalise les poids à 100 et garde les étapes', () => {
  const milestones = normalizeMilestones({
    milestones: [
      { title: 'Partie A', weight: 20, steps: ['1', '2', '3', '4'] },
      { title: 'Partie B', weight: 80 },
    ],
  });
  assert.equal(
    milestones.reduce((sum, milestone) => sum + milestone.weight, 0),
    100
  );
  assert.equal(milestones[0].steps.length, 4);
  assert.equal(milestones[0].type, 'manual');
});

test('readGoals charge les objectifs et leurs jalons', () => {
  const goals = readGoals();
  assert.ok(goals.length >= 10);
  const itheorie = goals.find((item) => item.id === 'itheorie');
  assert.equal(itheorie.confirmed, true);
  assert.ok(itheorie.milestones.length >= 4);
});
