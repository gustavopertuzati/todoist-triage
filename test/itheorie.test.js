'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const itheorie = require('../src/itheorie');

const CATEGORIES = [
  { name: 'Panneaux, feux & signes', pct: 91, total: 89 },
  { name: 'Arrêt & stationnement', pct: 100, total: 34 },
  { name: 'Comportement au volant', pct: 78, total: 98 },
  { name: 'Dépassement', pct: 79, total: 48 },
  { name: 'Accidents & pannes', pct: 81, total: 31 },
  { name: 'Danger, sécurité & prudence', pct: 84, total: 87 },
  { name: "Systèmes d'aide à la conduite", pct: 86, total: 21 },
  { name: 'Priorité', pct: 70, total: 82 },
];

const SNAPSHOT = {
  source: 'captures de test',
  catalogue: { correct_pct: 82, questions_seen: 444, questions_total: 490 },
  tests_started: 10,
  tests: [
    { date: '2025-06-09', score: 82 },
    { date: '2025-06-21', score: 90 },
    { date: '2026-10-30', score: 77 },
    { date: '2026-11-02', score: 56 },
    { date: '2026-11-03', score: 65 },
    { date: '2026-11-03', score: 78 },
    { date: '2026-11-04', score: 80 },
    { date: '2026-11-09', score: 87 },
    { date: '2026-11-12', score: 82 },
  ],
  categories: CATEGORIES,
};

test('normalizeDate convertit les dates françaises et ISO', () => {
  assert.equal(itheorie.normalizeDate('12 nov. 2026'), '2026-11-12');
  assert.equal(itheorie.normalizeDate('9 juin 2025'), '2025-06-09');
  assert.equal(itheorie.normalizeDate('21 juin 2025'), '2025-06-21');
  assert.equal(itheorie.normalizeDate('3.11.2026'), '2026-11-03');
  assert.equal(itheorie.normalizeDate('2026-11-12'), '2026-11-12');
  assert.equal(itheorie.normalizeDate('n’importe quoi'), null);
});

test('normalizeExtraction nettoie les pourcentages et les scores', () => {
  const parsed = itheorie.normalizeExtraction({
    catalogue: { correct_pct: '82 %', questions_seen: '444', questions_total: 490 },
    tests_started: 10,
    tests: [
      { date: '12 nov. 2026', score: '82 %' },
      { date: '9 nov. 2026', score: 87 },
      { date: 'date inconnue', score: 50 },
    ],
    categories: [{ name: 'Priorité', pct: 70, total: 82 }],
  });
  assert.equal(parsed.catalogue.correct_pct, 82);
  assert.equal(parsed.catalogue.questions_seen, 444);
  assert.equal(parsed.tests.length, 2);
  assert.equal(parsed.tests.find((test) => test.date === '2026-11-09').score, 87);
  assert.equal(parsed.tests.find((test) => test.date === '2026-11-12').score, 82);
  assert.equal(parsed.categories[0].pct, 70);
});

test('mergeTests déduplique et trie par date', () => {
  const merged = itheorie.mergeTests(
    [{ date: '2026-11-12', score: 82 }],
    [
      { date: '2026-11-12', score: 82 },
      { date: '2026-11-09', score: 87 },
    ]
  );
  assert.deepEqual(merged, [
    { date: '2026-11-09', score: 87 },
    { date: '2026-11-12', score: 82 },
  ]);
});

test('computeProgress calcule la préparation 50/50 validée', () => {
  const metrics = itheorie.computeProgress(SNAPSHOT);
  assert.equal(metrics.readiness, 80.2);
  assert.equal(metrics.catalogue_pct, 82);
  assert.equal(metrics.last_five_average, 78.4);
  assert.deepEqual(
    metrics.last_five_scores.map((test) => test.score),
    [65, 78, 80, 87, 82]
  );
  assert.equal(metrics.tests_finished, 9);
  assert.equal(metrics.tests_started, 10);
  assert.equal(metrics.tests_remaining_for_10, 1);
  assert.equal(metrics.best_score, 90);
  assert.equal(metrics.best_recent, 87);
  assert.equal(metrics.success_rate, 11.1);
  assert.equal(metrics.current_streak_90, 0);
  assert.equal(metrics.best_streak_90, 1);
  assert.equal(metrics.coverage, 90.6);
  assert.equal(metrics.gap, 9.8);
  assert.deepEqual(
    metrics.weak_categories.map((category) => category.name),
    ['Priorité', 'Comportement au volant', 'Dépassement']
  );
});

test('computeProgress retombe sur le catalogue si aucun test', () => {
  const metrics = itheorie.computeProgress({
    catalogue: { correct_pct: 75, questions_seen: 300, questions_total: 490 },
    tests: [],
  });
  assert.equal(metrics.readiness, 75);
  assert.equal(metrics.last_five_average, null);
  assert.equal(metrics.tests_finished, 0);
});

test('mergeSnapshot conserve le catalogue et remplace les tests si demandé', () => {
  const base = itheorie.normalizeSnapshot(SNAPSHOT);
  const merged = itheorie.mergeSnapshot(base, {
    catalogue: { correct_pct: 84, questions_seen: 460, questions_total: 490 },
    tests: [{ date: '2026-11-17', score: 88 }],
  });
  assert.equal(merged.catalogue.correct_pct, 84);
  assert.equal(merged.catalogue.questions_seen, 460);
  assert.equal(merged.tests.length, 10);
  assert.equal(merged.tests.at(-1).score, 88);

  const replaced = itheorie.mergeSnapshot(
    base,
    { tests: [{ date: '2026-11-17', score: 88 }] },
    { replaceTests: true }
  );
  assert.equal(replaced.tests.length, 1);
  assert.equal(replaced.tests[0].score, 88);
});

test('le magasin persiste un snapshot sur disque', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-itheorie-'));
  const file = path.join(dir, 'itheorie.json');
  const store = itheorie.createStore({ file });
  store.merge(SNAPSHOT, { replaceTests: true });
  const reloaded = itheorie.createStore({ file });
  const metrics = itheorie.computeProgress(reloaded.get());
  assert.equal(metrics.readiness, 80.2);
  assert.equal(metrics.tests_finished, 9);
  fs.rmSync(dir, { recursive: true, force: true });
});
