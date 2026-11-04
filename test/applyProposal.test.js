'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { selectedSplitSubtasks } = require('../src/applyProposal');

const proposal = {
  action: { subtasks: ['Un', 'Deux', 'Trois'] },
};

test('selectedSplitSubtasks garde toute la liste sans sélection', () => {
  assert.deepEqual(selectedSplitSubtasks(proposal, null), ['Un', 'Deux', 'Trois']);
});

test('selectedSplitSubtasks applique la sélection du client', () => {
  assert.deepEqual(selectedSplitSubtasks(proposal, { subtasks: ['Trois', 'Un'] }), [
    'Trois',
    'Un',
  ]);
});

test('selectedSplitSubtasks nettoie et ignore les entrées vides', () => {
  assert.deepEqual(
    selectedSplitSubtasks(proposal, { subtasks: ['  Un  ', '', 'x', 'Deux'] }),
    ['Un', 'Deux']
  );
});

test('selectedSplitSubtasks accepte les objets {title} et plafonne à 50', () => {
  assert.deepEqual(selectedSplitSubtasks(proposal, { subtasks: [{ title: 'Objet' }] }), [
    'Objet',
  ]);
  const many = Array.from({ length: 60 }, (_, i) => `Tâche ${i}`);
  assert.equal(selectedSplitSubtasks({ action: { subtasks: many } }, null).length, 50);
});
