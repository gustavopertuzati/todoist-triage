'use strict';

/**
 * Configuration centrale.
 *
 * Toutes les valeurs sensibles viennent exclusivement de variables
 * d'environnement : rien n'est écrit en dur, rien n'est envoyé au navigateur.
 */

const pkg = require('../package.json');

function readInt(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min || value > max) {
    console.warn(`[config] ${name} invalide (${raw}), utilisation de ${fallback}.`);
    return fallback;
  }
  return value;
}

function readTimeZone() {
  const fallback = 'Europe/Paris';
  const value = (process.env.APP_TIMEZONE || fallback).trim();
  try {
    // Lève une RangeError si le fuseau n'est pas reconnu par ICU.
    new Intl.DateTimeFormat('fr-FR', { timeZone: value }).format(new Date());
    return value;
  } catch {
    console.warn(`[config] APP_TIMEZONE invalide (${value}), utilisation de ${fallback}.`);
    return fallback;
  }
}

const config = {
  appVersion: pkg.version,
  port: readInt('PORT', 3000, { min: 1, max: 65535 }),
  timezone: readTimeZone(),

  // Secrets : jamais journalisés, jamais renvoyés au client.
  todoistToken: (process.env.TODOIST_API_TOKEN || '').trim(),
  appPassword: process.env.APP_PASSWORD || '',
  sessionSecret: process.env.SESSION_SECRET || '',

  sessionTtlDays: readInt('SESSION_TTL_DAYS', 30, { min: 1, max: 365 }),

  // Surcharge utile pour les tests locaux avec un faux Todoist.
  // En production, laisser la valeur par défaut.
  todoistBaseUrl: (process.env.TODOIST_BASE_URL || 'https://api.todoist.com/api/v1').replace(/\/+$/, ''),
  todoistTimeoutMs: readInt('TODOIST_TIMEOUT_MS', 20000, { min: 3000, max: 60000 }),

  // Données lues : cache mémoire court pour éviter de marteler l'API au
  // moindre rechargement de page sur mobile.
  cacheTtlMs: readInt('CACHE_TTL_SECONDS', 60, { min: 0, max: 3600 }) * 1000,

  // Fenêtre d'analyse des tâches terminées (maximum API : 3 mois).
  completedLookbackDays: readInt('COMPLETED_LOOKBACK_DAYS', 90, { min: 7, max: 92 }),

  // Un projet est considéré « sans progression » s'il a des tâches actives,
  // aucune tâche terminée sur la fenêtre, et au moins cet âge.
  projectNoProgressMinAgeDays: readInt('PROJECT_NO_PROGRESS_DAYS', 30, { min: 7, max: 365 }),

  // Tâches « anciennes » (indicateur, aucune action en lecture seule).
  oldTaskDays: readInt('OLD_TASK_DAYS', 180, { min: 30, max: 1825 }),

  // Itération 3 : propositions et écritures.
  // Les écritures Todoist ne partent QUE si une proposition est validée
  // explicitement depuis l'interface. Ce drapeau permet de les couper.
  writesEnabled: (process.env.WRITES_ENABLED || 'true').toLowerCase() !== 'false',
  proposalsMaxPerType: readInt('PROPOSALS_MAX_PER_TYPE', 15, { min: 1, max: 100 }),
  proposalsMaxTotal: readInt('PROPOSALS_MAX_TOTAL', 40, { min: 1, max: 200 }),
  // Décalage par défaut proposé pour dater une tâche ancienne sans échéance.
  proposalDueOffsetDays: readInt('PROPOSAL_DUE_OFFSET_DAYS', 7, { min: 0, max: 60 }),

  isProduction: process.env.NODE_ENV === 'production',
};

/**
 * Vérifie la configuration au démarrage et journalise clairement les manques.
 * On ne bloque pas le processus : l'app reste accessible pour afficher un
 * message de configuration à l'utilisateur (et Orkestr peut faire son healthcheck).
 */
function checkConfig() {
  const problems = [];
  if (!config.todoistToken) {
    problems.push('TODOIST_API_TOKEN est absent : l’export ne peut pas fonctionner.');
  }
  if (!config.appPassword) {
    problems.push('APP_PASSWORD est absent : la page est inaccessible.');
  } else if (config.appPassword.length < 8) {
    console.warn('[config] APP_PASSWORD fait moins de 8 caractères ; utilise un mot de passe plus long.');
  }
  if (!config.sessionSecret) {
    console.warn(
      '[config] SESSION_SECRET absent : une clé de session est dérivée de APP_PASSWORD. ' +
        'Définis SESSION_SECRET pour éviter que changer le mot de passe ne déconnecte tout le monde.'
    );
  }
  for (const problem of problems) console.error(`[config] ${problem}`);
  return problems;
}

module.exports = { config, checkConfig };
