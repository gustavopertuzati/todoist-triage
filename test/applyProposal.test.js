'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { selectedSplitSubtasks, selectedPreparations } = require('../src/applyProposal');

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

const prepareProposal = {
  action: {
    subtasks: [
      { title: '1. Choisir le vélo', date: '2026-11-04', reason: 'Rapide' },
      { title: '2. Préparer la tenue', date: '2026-11-05', reason: null },
      { title: '3. Régler le minuteur', date: '2026-11-06', reason: 'Évite de chercher' },
    ],
  },
};

test('selectedPreparations garde tout sans sélection', () => {
  assert.deepEqual(selectedPreparations(prepareProposal, null), [
    { title: 'Choisir le vélo', date: '2026-11-04', reason: 'Rapide' },
    { title: 'Préparer la tenue', date: '2026-11-05', reason: null },
    { title: 'Régler le minuteur', date: '2026-11-06', reason: 'Évite de chercher' },
  ]);
});

test('selectedPreparations applique les dates recalées du client', () => {
  const selected = selectedPreparations(prepareProposal, {
    preparations: [
      { title: '3. Régler le minuteur', date: '2026-11-04' },
      { title: '1. Choisir le vélo', date: '2026-11-05' },
    ],
  });
  assert.deepEqual(selected, [
    { title: 'Régler le minuteur', date: '2026-11-04', reason: null },
    { title: 'Choisir le vélo', date: '2026-11-05', reason: null },
  ]);
});

test('selectedPreparations ignore les dates invalides et les titres vides', () => {
  const selected = selectedPreparations(prepareProposal, {
    preparations: [
      { title: '   ', date: '2026-11-04' },
      { title: 'Valide', date: 'pas-une-date' },
    ],
  });
  assert.deepEqual(selected, [{ title: 'Valide', date: null, reason: null }]);
});
