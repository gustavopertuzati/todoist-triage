'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeAllowed, normalizeCheckin, QUESTIONS, DEFAULTS } = require('../src/checkin');

const RULE = { L: 1, M: 3, S: 5 };

function total(load) {
  return load.L + load.M + load.S;
}

test('cinq questions sont définies avec des valeurs par défaut valides', () => {
  assert.equal(QUESTIONS.length, 5);
  for (const question of QUESTIONS) {
    assert.ok(question.key && question.label);
    assert.ok(question.options.length >= 4);
    assert.ok(question.options.some((option) => option.value === DEFAULTS[question.key]));
  }
});

test('normalizeCheckin retombe sur les défauts pour des valeurs inconnues', () => {
  const answers = normalizeCheckin({ energy: 'n_importe_quoi', health: 'sick' });
  assert.equal(answers.energy, DEFAULTS.energy);
  assert.equal(answers.health, 'sick');
  assert.equal(answers.mood, DEFAULTS.mood);
});

test('une personne malade et épuisée obtient une journée très allégée', () => {
  const { allowed, notes, label } = computeAllowed(
    { energy: 'exhausted', health: 'sick', time: 'lt1h', want: 'short', mood: 'overwhelmed' },
    RULE
  );
  // min(rule, épuisé{0,0,3}, malade{0,1,3}, débordé{0,1,3}) = {0,0,3} puis plafonné à 2.
  assert.ok(allowed.L === 0);
  assert.ok(total(allowed) <= 2);
  assert.match(label, /allégée/i);
  assert.ok(notes.some((n) => /repos/i.test(n)));
});

test('en pleine forme et avec du temps, la charge complète est autorisée', () => {
  const { allowed, notes, label } = computeAllowed(
    { energy: 'high', health: 'great', time: 'allday', want: 'mix', mood: 'great' },
    RULE
  );
  assert.deepEqual(allowed, RULE);
  assert.equal(notes.length, 0);
  assert.match(label, /normale/i);
});

test('le temps disponible plafonne le nombre de tâches', () => {
  const { allowed } = computeAllowed(
    { energy: 'high', health: 'great', time: 'h1to2', want: 'mix', mood: 'great' },
    RULE
  );
  assert.equal(allowed.L + allowed.M + allowed.S, 4);
});

test('un check-in neutre laisse la pleine capacité 1-3-5', () => {
  const { allowed, label } = computeAllowed(null, RULE);
  assert.deepEqual(allowed, RULE);
  assert.match(label, /normale/i);
});
