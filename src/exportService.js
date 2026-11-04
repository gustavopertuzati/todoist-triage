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

async function loadSnapshot() {
  const generatedAt = new Date().toISOString();
  const today = todayInTimeZone(config.timezone, new Date(generatedAt));
  const warnings = [];

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
    generatedAt,
    appVersion: config.appVersion,
  });
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

module.exports = { getSnapshot, clearCache };
