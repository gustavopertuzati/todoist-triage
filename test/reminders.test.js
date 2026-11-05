'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { dueString, sameDue } = require('../src/reminders');

test('dueString produit une date locale Todoist', () => {
  assert.equal(dueString('2026-11-06', '09:30'), '2026-11-06T09:30:00');
});

test('sameDue compare la même minute, même avec des secondes', () => {
  const reminder = { due: { date: '2026-11-06T09:30:00' } };
  assert.equal(sameDue(reminder, '2026-11-06', '09:30'), true);
  assert.equal(sameDue(reminder, '2026-11-06', '09:31'), false);
  assert.equal(sameDue({ due: { date: '2026-11-06T09:30:59' } }, '2026-11-06', '09:30'), true);
  assert.equal(sameDue({}, '2026-11-06', '09:30'), false);
});
