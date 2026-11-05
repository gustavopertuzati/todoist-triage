'use strict';

/**
 * Horaires écrits dans le titre des tâches (itération 26).
 *
 * Format stable en suffixe : « Titre · 09:00–09:30 ».
 * Le suffixe est retiré avant d'en écrire un nouveau, pour éviter les doublons
 * quand on réorganise plusieurs fois.
 */

const TIME_RANGE_SUFFIX = /\s*[·—]\s*\d{1,2}:\d{2}\s*[–-]\s*\d{1,2}:\d{2}\s*$/;
const TIME_RANGE_PREFIX = /^\s*\d{1,2}:\d{2}\s*[–-]\s*\d{1,2}:\d{2}\s*[·:—-]\s*/;

function stripTimeMarker(value) {
  let result = String(value || '');
  result = result.replace(TIME_RANGE_SUFFIX, '');
  result = result.replace(TIME_RANGE_PREFIX, '');
  return result.trim();
}

function isValidClock(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''));
  if (!match) return false;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

/** Ajoute/remplace le suffixe horaire. */
function titleWithTime(title, start, end) {
  const clean = stripTimeMarker(title);
  if (!clean) return clean;
  if (!isValidClock(start) || !isValidClock(end)) return clean;
  return `${clean} · ${start}–${end}`;
}

module.exports = {
  stripTimeMarker,
  titleWithTime,
  isValidClock,
};
