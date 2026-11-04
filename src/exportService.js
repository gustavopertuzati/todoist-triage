'use strict';

/**
 * Orchestration de la lecture Todoist + cache mémoire.
 *
 * Le cache évite de relancer un full sync à chaque rechargement de la page
 * sur mobile. Il est volontairement très court et vidé par « Rafraîchir ».
 */

const { config } = require('./config');
const { fullSync, completedSince } = require('./todoist');
const { buildSnapshot } = require('./snapshot');
const { todayInTimeZone } = require('./dates');

let cached = null; // { snapshot, storedAt }
let inflight = null;

function buildCompletedDates(today) {
  const until = new Date();
  const since = new Date(until.getTime() - config.completedLookbackDays * 86_400_000);
  return {
    since: since.toISOString(),
    until: new Date(until.getTime() + 60_000).toISOString(),
  };
}

/**
 * Profil d'analyse approfondie. Chaque niveau élargit la recherche :
 * seuil de fantômes plus bas, plus de propositions, puis sous-tâches et
 * doublons entre projets.
 */
function deepProfile(depth) {
  const level = Math.max(0, Math.min(4, Number.parseInt(depth, 10) || 0));
  if (level === 0) return null;
  return {
    depth: level,
    proposalsMaxPerType: Math.min(80, config.proposalsMaxPerType * (1 + level)),
    proposalsMaxTotal: Math.min(250, Math.round(config.proposalsMaxTotal * (1 + level * 0.8))),
    cleanupGhostDays: Math.max(30, config.cleanupGhostDays - level * 120),
    cleanupMaxPerKind: Math.min(80, config.cleanupMaxPerKind * (1 + level)),
    cleanupMaxTotal: Math.min(300, Math.round(config.cleanupMaxTotal * (1 + level * 0.8))),
    cleanupIncludeSubtasks: level >= 2,
    cleanupCrossProject: level >= 3,
  };
}

async function loadSnapshot({ deep = 0 } = {}) {
  const generatedAt = new Date().toISOString();
  const today = todayInTimeZone(config.timezone, new Date(generatedAt));
  const warnings = [];
  const profile = deepProfile(deep);

  const syncPromise = fullSync();
  const dates = buildCompletedDates(today);
  const completedPromise = completedSince(dates.since, dates.until).catch((error) => {
    // L'échec de l'historique ne doit pas empêcher l'export : on le signale
    // simplement dans les avertissements (buildSnapshot ajoute le message).
    console.warn('[todoist] historique terminé indisponible :', error?.code || error?.name);
    return null;
  });

  const [sync, completed] = await Promise.all([syncPromise, completedPromise]);

  return buildSnapshot({
    sync,
    completed,
    today,
    timezone: config.timezone,
    warnings,
    completedLookbackDays: config.completedLookbackDays,
    oldTaskDays: config.oldTaskDays,
    noProgressMinAgeDays: config.projectNoProgressMinAgeDays,
    proposalsMaxPerType: profile ? profile.proposalsMaxPerType : config.proposalsMaxPerType,
    proposalsMaxTotal: profile ? profile.proposalsMaxTotal : config.proposalsMaxTotal,
    proposalDueOffsetDays: config.proposalDueOffsetDays,
    capacityHorizonDays: config.capacityHorizonDays,
    capacityRule: config.capacityRule,
    includeDueDateRule: !config.aiEnabled,
    cleanupEnabled: config.cleanupEnabled,
    cleanupGhostDays: profile ? profile.cleanupGhostDays : config.cleanupGhostDays,
    cleanupMaxPerKind: profile ? profile.cleanupMaxPerKind : config.cleanupMaxPerKind,
    cleanupMaxTotal: profile ? profile.cleanupMaxTotal : config.cleanupMaxTotal,
    cleanupIncludeSubtasks: profile ? profile.cleanupIncludeSubtasks : false,
    cleanupCrossProject: profile ? profile.cleanupCrossProject : false,
    scan: profile,
    generatedAt,
    appVersion: config.appVersion,
  });
}

/**
 * Analyse approfondie : relit Todoist sans toucher au cache normal et avec des
 * limites élargies. Utilisée par le bouton « Nettoyage plus profond ».
 */
async function getDeepSnapshot({ depth = 1 } = {}) {
  return loadSnapshot({ deep: depth });
}

/**
 * @param {{force?: boolean}} options
 * @returns {Promise<{snapshot: object, cache: {hit: boolean, age_seconds: number}}>}
 */
async function getSnapshot({ force = false } = {}) {
  const now = Date.now();
  if (!force && config.cacheTtlMs > 0 && cached) {
    const age = now - cached.storedAt;
    if (age < config.cacheTtlMs) {
      return {
        snapshot: cached.snapshot,
        cache: { hit: true, age_seconds: Math.round(age / 1000) },
      };
    }
  }

  if (!inflight) {
    inflight = loadSnapshot()
      .then((snapshot) => {
        cached = { snapshot, storedAt: Date.now() };
        return snapshot;
      })
      .finally(() => {
        inflight = null;
      });
  }

  const snapshot = await inflight;
  return { snapshot, cache: { hit: false, age_seconds: 0 } };
}

function clearCache() {
  cached = null;
}

module.exports = { getSnapshot, getDeepSnapshot, deepProfile, clearCache };
