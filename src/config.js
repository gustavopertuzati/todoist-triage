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

  // Itération 4 : propositions datées par une IA (OpenRouter).
  // Sans clé, l'app fonctionne normalement en mode règles.
  openrouterApiKey: (process.env.OPENROUTER_API_KEY || '').trim(),
  openrouterBaseUrl: (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
  aiModel: (process.env.AI_MODEL || 'deepseek/deepseek-v4.1-flash').trim(),
  aiTimeoutMs: readInt('AI_TIMEOUT_MS', 90000, { min: 5000, max: 300000 }),
  aiMaxTokens: readInt('AI_MAX_TOKENS', 8000, { min: 1000, max: 32000 }),
  aiReasoningMaxTokens: readInt('AI_REASONING_MAX_TOKENS', 400, { min: 0, max: 8000 }),
  aiMaxProposals: readInt('AI_MAX_PROPOSALS', 5, { min: 1, max: 40 }),
  aiCacheTtlMs: readInt('AI_CACHE_TTL_MINUTES', 30, { min: 0, max: 1440 }) * 60000,
  aiEnabled:
    Boolean((process.env.OPENROUTER_API_KEY || '').trim()) &&
    (process.env.AI_ENABLED || 'true').toLowerCase() !== 'false',

  // Itération 5 : capacité journalière « 1-3-5 » (1 gros, 3 moyens, 5 petits).
  capacityHorizonDays: readInt('CAPACITY_HORIZON_DAYS', 14, { min: 3, max: 60 }),
  capacityRule: {
    L: readInt('CAPACITY_MAX_LARGE', 1, { min: 0, max: 20 }),
    M: readInt('CAPACITY_MAX_MEDIUM', 3, { min: 0, max: 40 }),
    S: readInt('CAPACITY_MAX_SMALL', 5, { min: 0, max: 60 }),
  },
  aiAllowSplits: (process.env.AI_ALLOW_SPLITS || 'true').toLowerCase() !== 'false',

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
