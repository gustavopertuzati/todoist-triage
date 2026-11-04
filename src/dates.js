'use strict';

/**
 * Dates et convention personnelle « date en fin de titre ».
 *
 * Convention supportée :
 *   - « Appeler le garage 11.10.2026 »  -> 11 octobre 2026
 *   - « Payer la facture auj »           -> aujourd'hui (fuseau configuré)
 *
 * La date n'est reconnue qu'en toute fin de titre. On la retire du titre
 * affiché et on renvoie une date ISO (AAAA-MM-JJ), jamais un objet Date,
 * pour éviter les décalages de fuseau.
 */

const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

/** Ajoute un zéro devant les nombres < 10. */
function pad2(value) {
  return String(value).padStart(2, '0');
}

/** Vérifie qu'une chaîne est une date calendaire ISO valide (AAAA-MM-JJ). */
function isValidIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < MIN_YEAR || year > MAX_YEAR) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** Renvoie AAAA-MM-JJ pour la date civile « aujourd'hui » dans un fuseau. */
function todayInTimeZone(timeZone, now = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(now)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Décale une date ISO de `days` jours (négatif accepté). */
function addDaysIso(isoDate, days) {
  if (!isValidIsoDate(isoDate)) throw new Error(`Date ISO invalide : ${isoDate}`);
  const [year, month, day] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/** Nombre de jours calendaires entre deux dates ISO (b - a). */
function daysBetweenIso(a, b) {
  if (!isValidIsoDate(a) || !isValidIsoDate(b)) return null;
  const toUtc = (iso) => {
    const [year, month, day] = iso.split('-').map(Number);
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
}

// La date doit être précédée d'un espace (ou être seule) et terminer le titre.
// Le groupe 1 capture le séparateur pour pouvoir nettoyer le titre proprement.
const DATE_AT_END = /(^|[\s\u00a0])(\d{1,2})\.(\d{1,2})\.(\d{4})\s*$/u;
const TODAY_AT_END = /(^|[\s\u00a0])auj\.?\s*$/iu;

function cleanTitle(value) {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Analyse le titre d'une tâche.
 *
 * @param {string} content Titre brut Todoist.
 * @param {string} today Date ISO du jour dans le fuseau de l'utilisateur.
 * @returns {{
 *   detected: boolean, valid: boolean, title: string,
 *   dueDate: string|null, token: string|null,
 *   kind: 'date'|'today'|null, reason: string|null
 * }}
 */
function parseDateConvention(content, today) {
  const original = typeof content === 'string' ? content : '';
  const result = {
    detected: false,
    valid: false,
    title: cleanTitle(original),
    dueDate: null,
    token: null,
    kind: null,
    reason: null,
  };

  if (!original.trim()) return result;

  let match = original.match(DATE_AT_END);
  if (match) {
    const [full, separator, rawDay, rawMonth, rawYear] = match;
    const day = Number(rawDay);
    const month = Number(rawMonth);
    const year = Number(rawYear);
    result.detected = true;
    result.token = full.trim();
    result.kind = 'date';

    const iso = `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
    const title = cleanTitle(original.slice(0, original.length - full.length + separator.length));

    if (!isValidIsoDate(iso)) {
      result.reason = 'Date invalide (vérifie le jour et le mois).';
      return result;
    }
    if (!title) {
      result.reason = 'Le titre serait vide après retrait de la date.';
      return result;
    }

    result.valid = true;
    result.title = title;
    result.dueDate = iso;
    return result;
  }

  match = original.match(TODAY_AT_END);
  if (match) {
    const [full, separator] = match;
    result.detected = true;
    result.token = full.trim();
    result.kind = 'today';

    if (!isValidIsoDate(today)) {
      result.reason = 'Date du jour indisponible.';
      return result;
    }

    const title = cleanTitle(original.slice(0, original.length - full.length + separator.length));
    if (!title) {
      result.reason = 'Le titre serait vide après retrait de « auj ».';
      return result;
    }

    result.valid = true;
    result.title = title;
    result.dueDate = today;
    return result;
  }

  return result;
}

module.exports = {
  MIN_YEAR,
  MAX_YEAR,
  isValidIsoDate,
  todayInTimeZone,
  addDaysIso,
  daysBetweenIso,
  parseDateConvention,
};
