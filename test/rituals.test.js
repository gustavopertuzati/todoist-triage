'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const rituals = require('../public/rituals');

test('les anciens tableaux de dates sont lus comme un compteur', () => {
  const counts = rituals.normalizeCounts(['2026-11-15', '2026-11-16', '2026-11-16']);
  assert.deepEqual(counts, { '2026-11-15': 1, '2026-11-16': 2 });
  assert.equal(rituals.countToday(counts, '2026-11-16'), 2);
  assert.equal(rituals.total(counts), 3);
});

test('on peut ajouter plusieurs passages dans la même journée et annuler', () => {
  let counts = rituals.addOne(undefined, '2026-11-16');
  counts = rituals.addOne(counts, '2026-11-16');
  counts = rituals.addOne(counts, '2026-11-16');
  assert.equal(rituals.countToday(counts, '2026-11-16'), 3);

  counts = rituals.removeOne(counts, '2026-11-16');
  assert.equal(rituals.countToday(counts, '2026-11-16'), 2);

  counts = rituals.removeOne(rituals.removeOne(counts, '2026-11-16'), '2026-11-16');
  assert.equal(rituals.countToday(counts, '2026-11-16'), 0);
  assert.deepEqual(counts, {});
});

test('la série compte les jours consécutifs, pas les passages', () => {
  const counts = { '2026-11-14': 1, '2026-11-15': 3, '2026-11-16': 2 };
  assert.equal(rituals.streak(counts, '2026-11-16'), 3);
  // Si aujourd'hui n'est pas encore fait, la série d'hier reste visible.
  assert.equal(rituals.streak(counts, '2026-11-17'), 3);
});

test('chaque objectif a un petit rituel dédié, sauf lecture et sport', () => {
  assert.equal(rituals.goalCardRitual('opencode').title, 'Tester une action');
  assert.equal(rituals.goalCardRitual('jobops').minutes, 3);
  assert.equal(rituals.goalCardRitual('reading'), null);
  assert.equal(rituals.goalCardRitual('sport'), null);
  assert.equal(rituals.goalCardRitual('inconnu'), null);
});

test('les rituels liés à un objectif ajoutent une petite progression, plafonnée', () => {
  const state = {
    reading: { '2026-11-16': 2 },
    sport: { '2026-11-16': 1 },
  };
  assert.equal(rituals.bonusForGoal('reading', state), 1);
  assert.equal(rituals.bonusForGoal('sport', state), 0.5);
  assert.equal(rituals.bonusForGoal('opencode', state), 0);

  const many = {
    reading: Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`2026-01-${String(index + 1).padStart(2, '0')}`, 1])
    ),
  };
  assert.equal(rituals.bonusForGoal('reading', many), rituals.MAX_BONUS);
});
