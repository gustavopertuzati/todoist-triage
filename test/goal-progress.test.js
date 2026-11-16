'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { goalProgress, milestoneFraction, milestoneDone, nextMilestone } = require('../public/goal-progress');

function goal(overrides = {}) {
  return {
    confirmed: true,
    milestones: [
      {
        id: 'm1',
        title: 'Partie 20 % en 4 étapes',
        weight: 20,
        type: 'manual',
        steps: [
          { id: 's1', title: 'Étape 1' },
          { id: 's2', title: 'Étape 2' },
          { id: 's3', title: 'Étape 3' },
          { id: 's4', title: 'Étape 4' },
        ],
      },
      { id: 'm2', title: 'Le reste', weight: 80, type: 'manual' },
    ],
    ...overrides,
  };
}

test('20 % en 4 étapes donne 5 % par étape', () => {
  const entry = { steps: { m1: { s1: true } } };
  assert.equal(milestoneFraction(goal().milestones[0], entry), 0.25);
  assert.equal(goalProgress(goal(), entry), 5);
  const all = { steps: { m1: { s1: true, s2: true, s3: true, s4: true } } };
  assert.equal(goalProgress(goal(), all), 20);
  assert.equal(milestoneDone(goal().milestones[0], all), true);
});

test('un jalon automatique donne une fraction proportionnelle', () => {
  const milestone = { id: 'a', weight: 20, type: 'completed_tasks', count: 4, completed_count: 1 };
  const rest = { id: 'b', weight: 80, type: 'manual' };
  assert.equal(milestoneFraction(milestone, {}), 0.25);
  assert.equal(
    goalProgress({ confirmed: true, milestones: [milestone, rest] }, {}),
    5
  );
});

test('le prochain jalon ignore ceux déjà terminés', () => {
  const g = goal();
  const entry = { done: { m2: true } };
  assert.equal(nextMilestone(g, entry).id, 'm1');
});

test('les micro-rituels ajoutent une petite progression visible', () => {
  const g = goal();
  const entry = { steps: { m1: { s1: true } } };
  assert.equal(goalProgress(g, entry), 5);
  assert.equal(goalProgress(g, entry, 2.5), 7.5);
});

test('les rituels ne font jamais croire qu’un objectif est terminé', () => {
  const g = goal();
  const entry = { steps: { m1: { s1: true, s2: true, s3: true, s4: true } } };
  assert.equal(goalProgress(g, entry, 10), 30);
  const almost = {
    ...g,
    milestones: g.milestones.map((milestone) => ({
      ...milestone,
      weight: 50,
      steps: undefined,
      type: 'manual',
    })),
  };
  assert.equal(goalProgress(almost, { done: { m1: true } }, 10), 60);
});

test('tous les jalons terminés donnent 100 % même avec des rituels', () => {
  const g = goal();
  const entry = { steps: { m1: { s1: true, s2: true, s3: true, s4: true } }, done: { m2: true } };
  assert.equal(goalProgress(g, entry, 10), 100);
});
