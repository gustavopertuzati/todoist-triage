'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { DEFAULTS, normalize, serialize } = require('../public/schedule-settings');

test('une ancienne sauvegarde sans date repart des horaires par défaut', () => {
  const { settings, base } = normalize(
    { phoneStart: '14:05', otherStart: '14:05', end: '18:00' },
    '2026-11-07'
  );
  assert.equal(settings.phoneStart, DEFAULTS.phoneStart);
  assert.equal(settings.otherStart, DEFAULTS.otherStart);
  assert.equal(settings.end, '18:00');
  assert.deepEqual(base, {
    phoneStart: DEFAULTS.phoneStart,
    otherStart: DEFAULTS.otherStart,
  });
});

test('le même jour conserve l’heure calée automatiquement', () => {
  const { settings } = normalize(
    {
      phoneStart: '14:05',
      otherStart: '14:05',
      end: '17:00',
      day: '2026-11-07',
      basePhoneStart: '09:00',
      baseOtherStart: '11:00',
    },
    '2026-11-07'
  );
  assert.equal(settings.phoneStart, '14:05');
  assert.equal(settings.otherStart, '14:05');
});

test('le lendemain repart de la préférence, pas de l’heure d’hier', () => {
  const { settings, base } = normalize(
    {
      phoneStart: '14:05',
      otherStart: '15:05',
      day: '2026-11-06',
      basePhoneStart: '08:30',
      baseOtherStart: '10:30',
    },
    '2026-11-07'
  );
  assert.equal(settings.phoneStart, '08:30');
  assert.equal(settings.otherStart, '10:30');
  assert.deepEqual(base, { phoneStart: '08:30', otherStart: '10:30' });
});

test('serialize garde la préférence et la date du jour', () => {
  const stored = serialize(
    { phoneStart: '14:05', otherStart: '14:05', end: '17:00' },
    { phoneStart: '09:00', otherStart: '11:00' },
    '2026-11-07'
  );
  assert.equal(stored.day, '2026-11-07');
  assert.equal(stored.basePhoneStart, '09:00');
  assert.equal(stored.baseOtherStart, '11:00');
  assert.equal(stored.phoneStart, '14:05');

  const reloaded = normalize(stored, '2026-11-07');
  assert.equal(reloaded.settings.phoneStart, '14:05');

  const nextDay = normalize(stored, '2026-11-08');
  assert.equal(nextDay.settings.phoneStart, '09:00');
});

test('les valeurs invalides retombent sur les défauts', () => {
  const { settings } = normalize(
    {
      phoneStart: '25:99',
      otherStart: 'nope',
      end: '08:00',
      breakMinutes: 999,
      lunchStart: '99:99',
      lunchEnd: 'x',
    },
    '2026-11-07'
  );
  assert.equal(settings.phoneStart, DEFAULTS.phoneStart);
  assert.equal(settings.otherStart, DEFAULTS.otherStart);
  assert.equal(settings.end, DEFAULTS.end);
  assert.equal(settings.breakMinutes, 120);
  assert.equal(settings.lunchStart, DEFAULTS.lunchStart);
  assert.equal(settings.lunchEnd, DEFAULTS.lunchEnd);
});
