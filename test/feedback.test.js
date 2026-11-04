'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  QUESTIONNAIRE,
  followUps,
  normalizeEntry,
  normalizeFeedback,
  buildProfile,
  describeForPrompt,
} = require('../src/feedback');

const TODAY = '2026-11-04';

test('le questionnaire expose raisons, fenêtres, tailles et portées', () => {
  assert.ok(QUESTIONNAIRE.reasons.length >= 6);
  assert.ok(QUESTIONNAIRE.windows.length >= 4);
  assert.ok(QUESTIONNAIRE.sizes.length === 3);
  assert.ok(QUESTIONNAIRE.scopes.length === 2);
  assert.equal(QUESTIONNAIRE.quick.length, 2);
});

test('followUps n’ajoute la fenêtre que quand c’est pertinent', () => {
  assert.ok(followUps('now').includes('window'));
  assert.ok(followUps('wrong_day').includes('window'));
  assert.ok(!followUps('too_big').includes('window'));
  assert.ok(followUps('too_big').includes('size'));
  assert.ok(followUps('never').length === 1); // seulement la portée
});

test('normalizeEntry rejette les raisons inconnues et garde la dernière réponse', () => {
  assert.equal(normalizeEntry({ taskId: 't1', reason: 'blabla' }), null);
  assert.equal(normalizeEntry({ reason: 'now' }), null);

  const list = normalizeFeedback([
    { taskId: 't1', reason: 'now', window: 'this_week' },
    { taskId: 't1', reason: 'never' },
    { taskId: 't2', reason: 'too_big', size: 'S' },
  ]);
  assert.equal(list.length, 2);
  assert.equal(list.find((e) => e.taskId === 't1').reason, 'never');
  assert.equal(list.find((e) => e.taskId === 't2').size, 'S');
});

test('buildProfile déduit « jamais », reports, tailles et améliorations', () => {
  const entries = normalizeFeedback([
    { taskId: 'a', reason: 'never', title: 'Tâche A' },
    { taskId: 'b', reason: 'now', window: 'this_week', title: 'Tâche B' },
    { taskId: 'c', reason: 'too_big', size: 'S', title: 'Tâche C' },
    { taskId: 'd', reason: 'unclear', title: 'Tâche D' },
    { taskId: 'e', reason: 'not_priority', scope: 'always', title: 'Tâche E' },
  ]);
  const profile = buildProfile(entries, TODAY);

  assert.deepEqual(profile.never.sort(), ['a', 'e']);
  assert.equal(profile.postpone.length, 1);
  assert.equal(profile.postpone[0].taskId, 'b');
  assert.equal(profile.postpone[0].until, '2026-11-08'); // today + 4
  assert.deepEqual(profile.sizes, [{ taskId: 'c', size: 'S' }]);
  assert.deepEqual(
    profile.improve.map((i) => i.taskId).sort(),
    ['c', 'd']
  );
  assert.equal(profile.signals.never, 1);
  assert.equal(profile.count, 5);
});

test('describeForPrompt traduit le profil en bloc lisible pour l’IA', () => {
  const entries = normalizeFeedback([
    { taskId: 'a', reason: 'never', title: 'Vieille tâche' },
    { taskId: 'c', reason: 'too_big', size: 'S', title: 'Gros chantier' },
  ]);
  const block = describeForPrompt(buildProfile(entries, TODAY));

  assert.deepEqual(block.ne_pas_proposer, ['Vieille tâche']);
  assert.deepEqual(block.taille_reelle, [{ tache: 'Gros chantier', taille: 'S' }]);
  assert.equal(describeForPrompt(buildProfile([], TODAY)), null);
});
