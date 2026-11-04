'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { deepProfile } = require('../src/exportService');

test('deepProfile : aucun profil pour le nettoyage normal', () => {
  assert.equal(deepProfile(0), null);
});

test('deepProfile : les niveaux élargissent progressivement la recherche', () => {
  const level1 = deepProfile(1);
  assert.equal(level1.depth, 1);
  assert.equal(level1.cleanupGhostDays, 245);
  assert.equal(level1.cleanupMaxPerKind, 20);
  assert.equal(level1.cleanupMaxTotal, 45);
  assert.equal(level1.cleanupIncludeSubtasks, false);
  assert.equal(level1.cleanupCrossProject, false);

  const level2 = deepProfile(2);
  assert.equal(level2.cleanupGhostDays, 125);
  assert.equal(level2.cleanupIncludeSubtasks, true);
  assert.equal(level2.cleanupCrossProject, false);

  const level3 = deepProfile(3);
  assert.equal(level3.cleanupGhostDays, 30);
  assert.equal(level3.cleanupIncludeSubtasks, true);
  assert.equal(level3.cleanupCrossProject, true);
});

test('deepProfile borne les niveaux entre 1 et 4', () => {
  assert.equal(deepProfile(99).depth, 4);
  assert.equal(deepProfile(-3), null);
  assert.equal(deepProfile('abc'), null);
});
