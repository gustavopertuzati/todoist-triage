'use strict';

/**
 * Retour sur les propositions ignorées (itération 10).
 *
 * Quand tu ignores une proposition, un mini-questionnaire cible recueille la
 * raison. Ces réponses servent à deux choses :
 *   1. ne plus reproposer la même tâche (ou pas avant une date) ;
 *   2. nourrir l'IA (signaux, corrections de taille, demandes d'amélioration)
 *      pour qu'elle s'améliore réellement.
 *
 * Ce module est pur : il normalise les réponses et en déduit un « profil ».
 */

const { addDaysIso, isValidIsoDate } = require('./dates');

const REASONS = [
  { value: 'now', label: 'Pas maintenant' },
  { value: 'wrong_day', label: 'Pas le bon jour' },
  { value: 'too_big', label: 'Trop gros pour aujourd’hui' },
  { value: 'not_priority', label: 'Pas prioritaire' },
  { value: 'unclear', label: 'Titre pas clair' },
  { value: 'done', label: 'Déjà fait / obsolète' },
  { value: 'never', label: 'Ne plus la proposer' },
];

const WINDOWS = [
  { value: 'tomorrow', label: 'Demain', days: 1 },
  { value: 'this_week', label: 'Cette semaine', days: 4 },
  { value: 'next_week', label: 'La semaine prochaine', days: 10 },
  { value: 'weekend', label: 'Ce week-end', days: 5 },
  { value: 'never', label: 'Jamais', days: null },
];

const SIZES = [
  { value: 'S', label: 'Petit' },
  { value: 'M', label: 'Moyen' },
  { value: 'L', label: 'Gros' },
];

const SCOPES = [
  { value: 'once', label: 'Juste cette fois' },
  { value: 'always', label: 'Toujours pour cette tâche' },
];

/** Question à poser selon la raison choisie (le client s'en sert pour l'UI). */
function followUps(reason) {
  const steps = [];
  if (['now', 'wrong_day', 'not_priority'].includes(reason)) steps.push('window');
  if (reason === 'too_big') steps.push('size');
  steps.push('scope');
  return steps;
}

const QUESTIONNAIRE = {
  title: 'Pourquoi tu l’ignores ?',
  reasons: REASONS,
  windows: WINDOWS,
  sizes: SIZES,
  scopes: SCOPES,
  /** Raccourcis pour aller vite depuis une carte. */
  quick: [
    { label: 'Plus tard', entry: { reason: 'now', window: 'this_week' } },
    { label: 'Jamais', entry: { reason: 'never' } },
  ],
};

function allowed(values) {
  return new Set(values.map((v) => v.value));
}

/** Valide et normalise une entrée de feedback reçue du client. */
function normalizeEntry(input) {
  if (!input || typeof input !== 'object') return null;
  const taskId = String(input.taskId || '').trim();
  if (!taskId) return null;

  const reason = allowed(REASONS).has(input.reason) ? input.reason : null;
  if (!reason) return null;

  const window = allowed(WINDOWS).has(input.window) ? input.window : null;
  const size = allowed(SIZES).has(input.size) ? input.size : null;
  const scope = allowed(SCOPES).has(input.scope) ? input.scope : 'once';

  return {
    taskId,
    reason,
    window,
    size,
    scope,
    title: typeof input.title === 'string' ? input.title.slice(0, 120) : null,
    at: typeof input.at === 'string' && !Number.isNaN(Date.parse(input.at)) ? input.at : new Date().toISOString(),
  };
}

function normalizeFeedback(list) {
  if (!Array.isArray(list)) return [];
  const byTask = new Map();
  for (const raw of list) {
    const entry = normalizeEntry(raw);
    if (!entry) continue;
    // La dernière réponse pour une tâche l'emporte.
    byTask.set(entry.taskId, entry);
  }
  return [...byTask.values()];
}

/**
 * Déduit un profil exploitable par l'IA et par l'affichage.
 * @param {object[]} entries réponses normalisées
 * @param {string} today date ISO du jour
 */
function buildProfile(entries, today) {
  const list = Array.isArray(entries) ? entries : [];
  const validToday = isValidIsoDate(today) ? today : null;

  const never = new Set();
  const postpone = new Map(); // taskId -> date ISO
  const sizes = new Map();
  const improve = new Map(); // taskId -> raison
  const signals = {};
  const titles = new Map();

  for (const entry of list) {
    signals[entry.reason] = (signals[entry.reason] || 0) + 1;
    if (entry.title) titles.set(entry.taskId, entry.title);

    const windowDef = WINDOWS.find((w) => w.value === entry.window) || null;

    if (
      entry.reason === 'never' ||
      (windowDef && windowDef.value === 'never') ||
      (entry.scope === 'always' && ['done', 'not_priority'].includes(entry.reason))
    ) {
      never.add(entry.taskId);
      continue;
    }

    if (windowDef && typeof windowDef.days === 'number' && validToday) {
      const until = addDaysIso(validToday, windowDef.days);
      const current = postpone.get(entry.taskId);
      if (!current || until > current) postpone.set(entry.taskId, until);
    }

    if (entry.size) sizes.set(entry.taskId, entry.size);
    if (['unclear', 'too_big'].includes(entry.reason)) improve.set(entry.taskId, entry.reason);
  }

  return {
    never: [...never],
    postpone: [...postpone.entries()].map(([taskId, until]) => ({ taskId, until })),
    sizes: [...sizes.entries()].map(([taskId, size]) => ({ taskId, size })),
    improve: [...improve.entries()].map(([taskId, reason]) => ({ taskId, reason })),
    titles: Object.fromEntries(titles),
    signals,
    count: list.length,
  };
}

const REASON_TEXT = {
  now: 'pas maintenant',
  wrong_day: 'pas le bon jour',
  too_big: 'trop gros',
  not_priority: 'pas prioritaire',
  unclear: 'titre pas clair',
  done: 'déjà fait',
  never: 'ne plus proposer',
};

/**
 * Traduit le profil en bloc compact pour l'invite de l'IA.
 * @param {object} profile
 */
function describeForPrompt(profile) {
  if (!profile || profile.count === 0) return null;
  const title = (id) => profile.titles[id] || 'tâche inconnue';

  return {
    ne_pas_proposer: profile.never.map((id) => title(id)),
    reporter_apres: profile.postpone.map((p) => ({ tache: title(p.taskId), apres: p.until })),
    taille_reelle: profile.sizes.map((s) => ({ tache: title(s.taskId), taille: s.size })),
    a_ameliorer: profile.improve.map((i) => ({ tache: title(i.taskId), pourquoi: REASON_TEXT[i.reason] || i.reason })),
    signaux: profile.signals,
  };
}

module.exports = {
  REASONS,
  WINDOWS,
  SIZES,
  SCOPES,
  QUESTIONNAIRE,
  followUps,
  normalizeEntry,
  normalizeFeedback,
  buildProfile,
  describeForPrompt,
  REASON_TEXT,
};
