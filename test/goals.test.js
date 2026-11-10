'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { readGoals, countCompleted, evaluateGoals } = require('../src/goals');

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

test('readGoals charge la proposition iTheorie non validée', () => {
  const goals = readGoals();
  assert.ok(goals.some((item) => item.id === 'itheorie'));
  const itheorie = goals.find((item) => item.id === 'itheorie');
  assert.equal(itheorie.confirmed, false);
  assert.ok(itheorie.milestones.length >= 4);
});
