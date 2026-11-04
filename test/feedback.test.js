'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  QUESTIONNAIRES,
  KINDS,
  kindForProposal,
  normalizeEntry,
  normalizeFeedback,
  buildProfile,
  describeForPrompt,
} = require('../src/feedback');

const TODAY = '2026-11-04';

test('cinq questionnaires adaptés, chacun avec ses raccourcis', () => {
  assert.deepEqual(KINDS.sort(), ['cleanup', 'defer', 'place', 'rename', 'split']);
  for (const kind of KINDS) {
    const q = QUESTIONNAIRES[kind];
    assert.ok(q.title);
    assert.ok(q.questions.length >= 1);
    assert.ok(q.quick.length >= 1);
    assert.ok(q.questions.some((question) => question.key === 'reason'));
  }
});

test('kindForProposal choisit le bon questionnaire', () => {
  assert.equal(kindForProposal({ type: 'set_due_date' }), 'place');
  assert.equal(kindForProposal({ type: 'set_due_date', move: true }), 'defer');
  assert.equal(kindForProposal({ type: 'split_task' }), 'split');
  assert.equal(kindForProposal({ type: 'rename_task' }), 'rename');
  assert.equal(kindForProposal({ type: 'delete_task' }), 'cleanup');
  assert.equal(kindForProposal({ type: 'archive_project' }), 'cleanup');
});

test('le questionnaire « defer » demande pourquoi garder et comment adapter', () => {
  const q = QUESTIONNAIRES.defer;
  const reason = q.questions.find((question) => question.key === 'reason');
  const values = reason.options.map((o) => o.value);
  assert.ok(values.includes('deadline'));
  assert.ok(values.includes('can_wait'));
  const adapt = q.questions.find((question) => question.key === 'adapt');
  assert.deepEqual(
    adapt.options.map((o) => o.value),
    ['split', 'shorten', 'swap', 'keep']
  );
  // La question « quand » n'apparaît que si ça peut attendre.
  const window = q.questions.find((question) => question.key === 'window');
  assert.deepEqual(window.showIf, { key: 'reason', in: ['can_wait'] });
});

test('normalizeEntry valide selon le type de questionnaire', () => {
  assert.equal(normalizeEntry({ taskId: 't1', kind: 'defer', reason: 'blabla' }), null);
  // « too_big » n'existe pas dans le questionnaire « defer ».
  assert.equal(normalizeEntry({ taskId: 't1', kind: 'defer', reason: 'too_big' }), null);
  const entry = normalizeEntry({ taskId: 't1', kind: 'defer', reason: 'important', adapt: 'split' });
  assert.equal(entry.kind, 'defer');
  assert.equal(entry.adapt, 'split');
  assert.equal(entry.scope, 'once');
});

test('buildProfile : un « defer » gardé aujourd’hui + adaptation', () => {
  const entries = normalizeFeedback([
    { taskId: 'a', kind: 'defer', reason: 'deadline', adapt: 'shorten', title: 'Facture' },
    { taskId: 'b', kind: 'defer', reason: 'can_wait', window: 'next_week', title: 'Tri' },
  ]);
  const profile = buildProfile(entries, TODAY);

  assert.deepEqual(profile.keepToday, ['a']);
  assert.deepEqual(profile.adaptation, [{ taskId: 'a', mode: 'shorten' }]);
  assert.equal(profile.postpone.length, 1);
  assert.equal(profile.postpone[0].taskId, 'b');
  assert.equal(profile.postpone[0].until, '2026-11-14'); // today + 10
  assert.equal(profile.never.length, 0);
});

test('buildProfile : refus de découpage, de reformulation et de nettoyage', () => {
  const entries = normalizeFeedback([
    { taskId: 's', kind: 'split', reason: 'already_split', alt: 'nothing', scope: 'always', title: 'Gros projet' },
    { taskId: 'r', kind: 'rename', reason: 'fine', scope: 'always', title: 'Titre ok' },
    { taskId: 'c', kind: 'cleanup', reason: 'useful', scope: 'always', title: 'Vieux projet' },
  ]);
  const profile = buildProfile(entries, TODAY);

  assert.deepEqual(profile.noSplit, ['s']);
  assert.deepEqual(profile.noRename, ['r']);
  assert.deepEqual(profile.noCleanup, ['c']);
});

test('buildProfile : « place » inchange (jamais, report, taille, amélioration)', () => {
  const entries = normalizeFeedback([
    { taskId: 'x', kind: 'place', reason: 'never', title: 'Vieille' },
    { taskId: 'y', kind: 'place', reason: 'now', window: 'this_week', title: 'Plus tard' },
    { taskId: 'z', kind: 'place', reason: 'too_big', size: 'S', title: 'Gros' },
  ]);
  const profile = buildProfile(entries, TODAY);

  assert.deepEqual(profile.never, ['x']);
  assert.deepEqual(profile.sizes, [{ taskId: 'z', size: 'S' }]);
  assert.deepEqual(profile.improve.map((i) => i.taskId), ['z']);
  assert.equal(profile.postpone[0].taskId, 'y');
});

test('describeForPrompt traduit le profil pour l’IA', () => {
  const entries = normalizeFeedback([
    { taskId: 'a', kind: 'defer', reason: 'someone', adapt: 'split', title: 'Devoir' },
    { taskId: 's', kind: 'split', reason: 'single', scope: 'always', title: 'Appel' },
  ]);
  const block = describeForPrompt(buildProfile(entries, TODAY));

  assert.deepEqual(block.garder_aujourdhui, [{ tache: 'Devoir', adapter: 'split' }]);
  assert.deepEqual(block.ne_pas_decouper, ['Appel']);
  assert.equal(describeForPrompt(buildProfile([], TODAY)), null);
});
