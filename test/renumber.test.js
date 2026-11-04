'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  renumberPlan,
  nextNumberedTitle,
  hasOrderPrefix,
} = require('../src/renumber');

function task(id, content, childOrder = 0) {
  return {
    id,
    content,
    display_title: content,
    child_order: childOrder,
    order_key: '',
    parent_id: 'parent',
    project_archived: false,
  };
}

test('renumberPlan recolle les numéros après une suppression', () => {
  const children = [
    task('a', '1. Trier', 0),
    task('c', '3. Descendre', 1),
    task('d', '4. Ranger', 2),
    task('e', 'Note libre', 3),
  ];
  const plan = renumberPlan(children);

  assert.deepEqual(plan.changes, [
    { id: 'c', from: '3. Descendre', to: '2. Descendre' },
    { id: 'd', from: '4. Ranger', to: '3. Ranger' },
  ]);
  assert.equal(plan.numbered, 3);
  // Une tâche sans préfixe n'est jamais touchée.
  assert.ok(!plan.changes.some((change) => change.id === 'e'));
});

test('renumberPlan ne change rien si les numéros sont déjà bons', () => {
  const plan = renumberPlan([
    task('a', '1. Trier', 0),
    task('b', '2. Descendre', 1),
  ]);
  assert.deepEqual(plan.changes, []);
  assert.equal(plan.numbered, 2);
});

test('renumberPlan gère aussi les préfixes « 1) »', () => {
  const plan = renumberPlan([
    task('a', '1) Trier', 0),
    task('c', '3) Ranger', 1),
  ]);
  assert.deepEqual(plan.changes, [
    { id: 'a', from: '1) Trier', to: '1. Trier' },
    { id: 'c', from: '3) Ranger', to: '2. Ranger' },
  ]);
});

test('nextNumberedTitle donne le numéro suivant du groupe', () => {
  const siblings = [task('a', '1. Trier', 0), task('b', '2. Descendre', 1)];
  assert.equal(nextNumberedTitle(siblings, 'Ranger les outils'), '3. Ranger les outils');
  assert.equal(nextNumberedTitle([], 'Ranger'), '1. Ranger');
  assert.equal(hasOrderPrefix('2. Descendre'), true);
  assert.equal(hasOrderPrefix('Note libre'), false);
});
