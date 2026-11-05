'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  stripTimeMarker,
  titleWithTime,
  isValidClock,
} = require('../src/taskTitles');

test('titleWithTime ajoute un suffixe horaire', () => {
  assert.equal(titleWithTime('1. Trier les cartons', '09:00', '09:30'), '1. Trier les cartons · 09:00–09:30');
});

test('titleWithTime remplace un ancien horaire sans le doubler', () => {
  const first = titleWithTime('Trier', '09:00', '09:30');
  const second = titleWithTime(first, '10:00', '10:45');
  assert.equal(second, 'Trier · 10:00–10:45');
});

test('stripTimeMarker enlève un ancien suffixe ou préfixe', () => {
  assert.equal(stripTimeMarker('Tâche · 09:00–09:30'), 'Tâche');
  assert.equal(stripTimeMarker('09:00–09:30 · Tâche'), 'Tâche');
  assert.equal(stripTimeMarker('Tâche sans horaire'), 'Tâche sans horaire');
});

test('isValidClock valide les heures', () => {
  assert.equal(isValidClock('09:00'), true);
  assert.equal(isValidClock('23:59'), true);
  assert.equal(isValidClock('24:00'), false);
  assert.equal(isValidClock('9h'), false);
});
