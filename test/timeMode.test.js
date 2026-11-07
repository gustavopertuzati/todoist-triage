'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AUTO_LABEL,
  FIXED_LABEL,
  hasClock,
  clockOf,
  timeMode,
  labelsForMode,
} = require('../src/timeMode');

test('hasClock détecte une heure dans la date ou le texte', () => {
  assert.equal(hasClock({ due: { date: '2026-11-07T15:05:00' } }), true);
  assert.equal(hasClock({ due: { date: '2026-11-07' }, due_string: '2026-11-07 15:05' }), true);
  assert.equal(hasClock({ due: { date: '2026-11-07' }, due_string: 'every day at 09:00' }), true);
  assert.equal(hasClock({ due: { date: '2026-11-07' }, due_string: '2026-11-07' }), false);
});

test('clockOf extrait HH:mm', () => {
  assert.equal(clockOf({ due: { date: '2026-11-07T15:05:00' } }), '15:05');
  assert.equal(clockOf({ due_string: '2026-11-07 09:30' }), '09:30');
  assert.equal(clockOf({ due: { date: '2026-11-07' } }), null);
});

test('timeMode distingue fixe, auto, à confirmer et sans heure', () => {
  assert.equal(timeMode({ labels: [FIXED_LABEL] }), 'fixed');
  assert.equal(timeMode({ labels: [AUTO_LABEL] }), 'auto');
  assert.equal(timeMode({ labels: [], due: { date: '2026-11-07T10:00:00' } }), 'confirm');
  assert.equal(timeMode({ labels: [], due: { date: '2026-11-07' } }), 'untimed');
});

test('labelsForMode conserve les autres labels et remplace le mode', () => {
  const task = { labels: ['perso', AUTO_LABEL] };
  assert.deepEqual(labelsForMode(task, 'fixed'), ['perso', FIXED_LABEL]);
  assert.deepEqual(labelsForMode(task, 'auto'), ['perso', AUTO_LABEL]);
});
