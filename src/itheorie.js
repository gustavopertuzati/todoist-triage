'use strict';

/**
 * Suivi iTheorie (itération 50).
 *
 * iTheorie n'expose ni API ni export. Le compromis retenu : on importe une ou
 * deux captures d'écran depuis Triage, l'IA de vision en extrait les chiffres,
 * puis l'utilisateur peut corriger avant d'enregistrer.
 *
 * Ce module est pur (hors petit magasin JSON) :
 *   - normalisation des dates françaises et des scores ;
 *   - fusion sans doublons de l'historique des tests ;
 *   - calcul de la préparation (50 % catalogue + 50 % moyenne des 5 derniers).
 */

const fs = require('node:fs');
const path = require('node:path');

const TARGET = 90;
const CATALOGUE_WEIGHT = 0.5;
const TESTS_WEIGHT = 0.5;

const MONTHS = {
  janv: 1,
  jan: 1,
  fevr: 2,
  fevrier: 2,
  mars: 3,
  avr: 4,
  avril: 4,
  mai: 5,
  juin: 6,
  juil: 7,
  juillet: 7,
  aout: 8,
  sept: 9,
  septembre: 9,
  oct: 10,
  octobre: 10,
  nov: 11,
  novembre: 11,
  dec: 12,
  decembre: 12,
};

function defaultFile() {
  return process.env.ITHEORIE_FILE
    ? path.resolve(process.env.ITHEORIE_FILE)
    : path.join(__dirname, '..', 'data', 'itheorie.json');
}

function emptySnapshot() {
  return {
    updated_at: null,
    source: null,
    catalogue: {
      correct_pct: null,
      questions_seen: null,
      questions_total: null,
    },
    tests_started: null,
    tests: [],
    categories: [],
  };
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function clampNumber(value, min, max) {
  const cleaned =
    typeof value === 'string'
      ? value.replace(/\s/g, '').replace('%', '').replace(',', '.')
      : value;
  const number = Number(cleaned);
  if (!Number.isFinite(number)) return null;
  return Math.min(max, Math.max(min, number));
}

function text(value, max = 120) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function normalizeKey(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\./g, '')
    .trim();
}

/** Convertit « 12 nov. 2026 », « 3.11.2026 » ou une date ISO en AAAA-MM-JJ. */
function normalizeDate(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  let match = raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (match) {
    const [, day, month, year] = match;
    return `${year}-${pad2(month)}-${pad2(day)}`;
  }

  match = raw.match(/^(\d{1,2})\s+([A-Za-zÀ-ÿ.]+)\s+(\d{4})$/);
  if (match) {
    const [, day, rawMonth, year] = match;
    const month = MONTHS[normalizeKey(rawMonth).replace(/[^a-z]/g, '')];
    if (month) return `${year}-${pad2(month)}-${pad2(day)}`;
  }
  return null;
}

function normalizeTest(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const date = normalizeDate(raw.date);
  const score = clampNumber(raw.score, 0, 100);
  if (!date || score === null) return null;
  return { date, score: round1(score) };
}

function testKey(test) {
  return `${test.date}|${test.score}`;
}

function mergeTests(base, incoming) {
  const byKey = new Map();
  for (const test of [...(Array.isArray(base) ? base : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    const normalized = normalizeTest(test);
    if (normalized) byKey.set(testKey(normalized), normalized);
  }
  return [...byKey.values()].sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.score - b.score;
  });
}

function normalizeCategory(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = text(raw.name, 80);
  const pct = clampNumber(raw.pct, 0, 100);
  if (!name || pct === null) return null;
  return {
    name,
    pct: round1(pct),
    total: clampNumber(raw.total, 1, 5000),
  };
}

function normalizeSnapshot(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const catalogue = source.catalogue && typeof source.catalogue === 'object' ? source.catalogue : {};
  const categories = (Array.isArray(source.categories) ? source.categories : [])
    .map(normalizeCategory)
    .filter(Boolean)
    .slice(0, 30);
  return {
    updated_at: typeof source.updated_at === 'string' ? source.updated_at.slice(0, 40) : null,
    source: text(source.source, 120) || null,
    catalogue: {
      correct_pct: clampNumber(catalogue.correct_pct, 0, 100),
      questions_seen: clampNumber(catalogue.questions_seen, 0, 20000),
      questions_total: clampNumber(catalogue.questions_total, 0, 20000),
    },
    tests_started: clampNumber(source.tests_started, 0, 10000),
    tests: mergeTests([], source.tests),
    categories,
  };
}

/** Extrait uniquement les champs utiles de la réponse de l'IA. */
function normalizeExtraction(raw) {
  return normalizeSnapshot({
    source: 'captures',
    catalogue: raw?.catalogue,
    tests_started: raw?.tests_started,
    tests: raw?.tests,
    categories: raw?.categories,
  });
}

/**
 * Fusionne un patch avec le snapshot courant.
 * `replaceTests: true` remplace l'historique (utile après correction manuelle).
 */
function mergeSnapshot(current, patch, { replaceTests = false } = {}) {
  const base = normalizeSnapshot(current);
  const incoming = normalizeSnapshot(patch);
  const catalogue = {
    correct_pct: incoming.catalogue.correct_pct ?? base.catalogue.correct_pct,
    questions_seen: incoming.catalogue.questions_seen ?? base.catalogue.questions_seen,
    questions_total: incoming.catalogue.questions_total ?? base.catalogue.questions_total,
  };
  const tests = replaceTests ? incoming.tests : mergeTests(base.tests, incoming.tests);
  const categories = incoming.categories.length > 0 ? incoming.categories : base.categories;
  const testsStarted = Math.max(
    Number(base.tests_started) || 0,
    Number(incoming.tests_started) || 0,
    tests.length
  );
  return normalizeSnapshot({
    updated_at: incoming.updated_at || new Date().toISOString(),
    source: incoming.source || base.source,
    catalogue,
    tests_started: testsStarted || null,
    tests,
    categories,
  });
}

function average(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function weightedCatalogue(snapshot) {
  if (snapshot.catalogue.correct_pct !== null) return snapshot.catalogue.correct_pct;
  const withTotal = snapshot.categories.filter((category) => category.total);
  if (withTotal.length === 0) return null;
  const total = withTotal.reduce((sum, category) => sum + category.total, 0);
  if (total <= 0) return null;
  return withTotal.reduce((sum, category) => sum + category.pct * category.total, 0) / total;
}

function consecutive90(tests, fromEnd = false) {
  let best = 0;
  let current = 0;
  for (const test of tests) {
    if (test.score >= TARGET) {
      current += 1;
      best = Math.max(best, current);
    } else {
      current = 0;
    }
  }
  if (!fromEnd) return best;
  let streak = 0;
  for (let index = tests.length - 1; index >= 0; index -= 1) {
    if (tests[index].score >= TARGET) streak += 1;
    else break;
  }
  return streak;
}

/** Calcule les indicateurs affichés dans Triage. */
function computeProgress(rawSnapshot) {
  const snapshot = normalizeSnapshot(rawSnapshot);
  const tests = [...snapshot.tests].sort((a, b) => a.date.localeCompare(b.date));
  const lastFive = tests.slice(-5);
  const lastFiveAverage = average(lastFive.map((test) => test.score));
  const cataloguePct = weightedCatalogue(snapshot);
  let readiness = null;
  if (cataloguePct !== null && lastFiveAverage !== null) {
    readiness = cataloguePct * CATALOGUE_WEIGHT + lastFiveAverage * TESTS_WEIGHT;
  } else {
    readiness = cataloguePct ?? lastFiveAverage;
  }

  const passed = tests.filter((test) => test.score >= TARGET).length;
  const coverage =
    snapshot.catalogue.questions_seen !== null &&
    snapshot.catalogue.questions_total !== null &&
    snapshot.catalogue.questions_total > 0
      ? (snapshot.catalogue.questions_seen / snapshot.catalogue.questions_total) * 100
      : null;
  const bestScore = tests.length > 0 ? Math.max(...tests.map((test) => test.score)) : null;
  const bestRecent =
    lastFive.length > 0 ? Math.max(...lastFive.map((test) => test.score)) : null;
  const weakCategories = [...snapshot.categories]
    .sort((a, b) => a.pct - b.pct)
    .slice(0, 3)
    .map((category) => ({ name: category.name, pct: category.pct, total: category.total }));

  return {
    target: TARGET,
    formula: '50 % catalogue + 50 % moyenne des 5 derniers tests',
    readiness: readiness === null ? null : round1(readiness),
    gap: readiness === null ? null : round1(Math.max(0, TARGET - readiness)),
    progress_to_target: readiness === null ? null : round1(Math.min(100, (readiness / TARGET) * 100)),
    catalogue_pct: cataloguePct === null ? null : round1(cataloguePct),
    coverage: coverage === null ? null : round1(coverage),
    questions_seen: snapshot.catalogue.questions_seen,
    questions_total: snapshot.catalogue.questions_total,
    tests_finished: tests.length,
    tests_started: snapshot.tests_started,
    tests_remaining_for_10: Math.max(0, 10 - tests.length),
    last_five_average: lastFiveAverage === null ? null : round1(lastFiveAverage),
    last_five_scores: lastFive.map((test) => ({ date: test.date, score: test.score })),
    last_three_average:
      tests.length > 0
        ? round1(average(tests.slice(-3).map((test) => test.score)))
        : null,
    best_score: bestScore,
    best_recent: bestRecent,
    success_rate: tests.length > 0 ? round1((passed / tests.length) * 100) : null,
    passed_tests: passed,
    current_streak_90: consecutive90(tests, true),
    best_streak_90: consecutive90(tests, false),
    last_test: tests.length > 0 ? tests[tests.length - 1] : null,
    weak_categories: weakCategories,
    updated_at: snapshot.updated_at,
    source: snapshot.source,
  };
}

/** Prompt envoyé au modèle de vision. */
function buildExtractionPrompt() {
  return [
    'Tu lis des captures d’écran de l’application iTheorie Premium (permis suisse).',
    'Extrais uniquement les données réellement visibles. Ne devine rien.',
    '',
    'Réponds EXACTEMENT par cet objet JSON, sans texte autour :',
    '{"catalogue":{"correct_pct":null,"questions_seen":null,"questions_total":null},',
    ' "tests_started":null,',
    ' "tests":[{"date":"AAAA-MM-JJ","score":82}],',
    ' "categories":[{"name":"...","pct":82,"total":89}]}',
    '',
    'Règles :',
    '- "tests" = uniquement les tests TERMINÉS (cartes sous « Tests terminés »).',
    '  Ignore « Tests commencés », les tests en cours et la carte « Question 18 ».',
    '- score = pourcentage affiché (ex. 82). N’utilise jamais les points (740, 659…).',
    '- Convertis les dates françaises (12 nov. 2026, 9 juin 2025) en AAAA-MM-JJ.',
    '- Si plusieurs captures se chevauchent, déduplique les tests identiques.',
    '- "correct_pct" = le « 82 % Correct » de l’écran Succès ; sinon le pourcentage global Apprendre.',
    '- "questions_seen" = nombre de « Questions » de l’écran Succès (ex. 444).',
    '- "questions_total" = total indiqué dans Apprendre (ex. 490).',
    '- "tests_started" = « Tests Effectués » (ex. 10).',
    '- "categories" = cartes de l’écran Apprendre avec un pourcentage :',
    '  Panneaux, Arrêt & stationnement, Comportement au volant, Dépassement,',
    '  Accidents & pannes, Danger, Systèmes d’aide, Priorité.',
    '  Ignore Entraîneur, Casse-têtes et Répétition (ce ne sont pas des pourcentages de catégorie).',
    '- Si une valeur est absente, mets null. Ne mets pas de texte dans les nombres.',
    '',
    'Les captures peuvent être dans le désordre. Analyse-les toutes ensemble.',
  ].join('\n');
}

/** Petit magasin JSON, atomique et rechargeable. */
function createStore({ file = defaultFile() } = {}) {
  let snapshot = null;

  function load() {
    if (snapshot) return snapshot;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      snapshot = normalizeSnapshot(parsed);
    } catch {
      snapshot = emptySnapshot();
    }
    return snapshot;
  }

  function persist() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(load(), null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  }

  function get() {
    return load();
  }

  function save(next) {
    snapshot = normalizeSnapshot({
      ...next,
      updated_at: new Date().toISOString(),
    });
    persist();
    return snapshot;
  }

  function merge(patch, options) {
    const merged = mergeSnapshot(load(), patch, options);
    snapshot = { ...merged, updated_at: new Date().toISOString() };
    persist();
    return snapshot;
  }

  function reset() {
    snapshot = { ...emptySnapshot(), updated_at: new Date().toISOString() };
    persist();
    return snapshot;
  }

  return { file, get, save, merge, reset, load };
}

const store = createStore();

module.exports = {
  TARGET,
  CATALOGUE_WEIGHT,
  TESTS_WEIGHT,
  defaultFile,
  emptySnapshot,
  normalizeDate,
  normalizeTest,
  normalizeCategory,
  normalizeSnapshot,
  normalizeExtraction,
  mergeTests,
  mergeSnapshot,
  computeProgress,
  buildExtractionPrompt,
  createStore,
  store,
};
