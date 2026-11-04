'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseDateConvention,
  todayInTimeZone,
  addDaysIso,
  daysBetweenIso,
  isValidIsoDate,
} = require('../src/dates');

const TODAY = '2026-11-04';

test('détecte une date JJ.MM.AAAA en fin de titre et la retire', () => {
  const result = parseDateConvention('Appeler le garage 11.10.2026', TODAY);
  assert.equal(result.detected, true);
  assert.equal(result.valid, true);
  assert.equal(result.title, 'Appeler le garage');
  assert.equal(result.dueDate, '2026-10-11');
  assert.equal(result.kind, 'date');
});

test('accepte les jours et mois à un chiffre', () => {
  const result = parseDateConvention('Réunion 1.1.2026', TODAY);
  assert.equal(result.valid, true);
  assert.equal(result.dueDate, '2026-01-01');
  assert.equal(result.title, 'Réunion');
});

test('« auj » vaut la date du jour, sans tenir compte de la casse', () => {
  for (const content of ['Payer la facture auj', 'Payer la facture AUJ', 'Payer la facture auj.']) {
    const result = parseDateConvention(content, TODAY);
    assert.equal(result.valid, true, content);
    assert.equal(result.dueDate, TODAY, content);
    assert.equal(result.title, 'Payer la facture', content);
    assert.equal(result.kind, 'today', content);
  }
});

test('ne détecte pas une date au milieu du titre', () => {
  const result = parseDateConvention('Date 11.10.2026 au milieu', TODAY);
  assert.equal(result.detected, false);
  assert.equal(result.title, 'Date 11.10.2026 au milieu');
});

test('signale une date invalide sans la retirer', () => {
  const result = parseDateConvention('Anniversaire 31.02.2026', TODAY);
  assert.equal(result.detected, true);
  assert.equal(result.valid, false);
  assert.equal(result.dueDate, null);
  assert.match(result.reason, /invalide/i);
  assert.equal(result.title, 'Anniversaire 31.02.2026');
});

test('refuse un titre qui deviendrait vide', () => {
  const result = parseDateConvention('11.10.2026', TODAY);
  assert.equal(result.detected, true);
  assert.equal(result.valid, false);
  assert.match(result.reason, /vide/i);
});

test('laisse un titre sans convention intact', () => {
  const result = parseDateConvention('Acheter du pain', TODAY);
  assert.equal(result.detected, false);
  assert.equal(result.valid, false);
  assert.equal(result.title, 'Acheter du pain');
});

test('nettoie les espaces autour du titre restant', () => {
  const result = parseDateConvention('  Appeler   le garage   11.10.2026  ', TODAY);
  assert.equal(result.valid, true);
  assert.equal(result.title, 'Appeler le garage');
});

test('calcule la date du jour dans le fuseau demandé', () => {
  const instant = new Date('2026-11-04T23:30:00Z');
  assert.equal(todayInTimeZone('Europe/Paris', instant), '2026-11-05');
  assert.equal(todayInTimeZone('UTC', instant), '2026-11-04');
});

test('arithmétique de dates ISO', () => {
  assert.equal(addDaysIso('2026-12-31', 1), '2027-01-01');
  assert.equal(addDaysIso('2026-03-01', -1), '2026-02-28');
  assert.equal(daysBetweenIso('2026-10-11', '2026-11-04'), 24);
  assert.equal(isValidIsoDate('2026-02-29'), false);
  assert.equal(isValidIsoDate('2028-02-29'), true);
});
