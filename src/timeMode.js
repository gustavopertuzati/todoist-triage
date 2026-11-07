'use strict';

/**
 * Gestion des horaires « libres » ou « verrouillés ».
 *
 * Convention de labels Todoist :
 *   - `triage-auto`  : horaire géré par Triage (peut être recalculé) ;
 *   - `triage-fixe`  : horaire choisi par la personne, Triage n'y touche plus.
 *
 * Une tâche avec une heure mais aucun de ces labels doit être confirmée une
 * fois par la personne avant que Triage puisse la déplacer.
 */

const AUTO_LABEL = 'triage-auto';
const FIXED_LABEL = 'triage-fixe';
const MODE_LABELS = [AUTO_LABEL, FIXED_LABEL];

function labelsOf(task) {
  return Array.isArray(task?.labels) ? task.labels : [];
}

function hasModeLabel(task, label) {
  return labelsOf(task).includes(label);
}

/** Vrai si la tâche a une heure (due_datetime, due_string avec HH:mm). */
function hasClock(task) {
  const date = String(task?.due?.date || '');
  if (/T\d{2}:\d{2}/.test(date)) return true;
  const string = String(task?.due_string || '');
  return /\b\d{1,2}:\d{2}\b/.test(string);
}

/** Heure existante (HH:mm) ou null. */
function clockOf(task) {
  const date = String(task?.due?.date || '');
  const inDate = /T(\d{2}:\d{2})/.exec(date);
  if (inDate) return inDate[1];
  const inString = /\b(\d{1,2}:\d{2})\b/.exec(String(task?.due_string || ''));
  return inString ? inString[1].padStart(5, '0') : null;
}

/**
 * mode = fixed | auto | confirm | untimed
 * - fixed   : label triage-fixe
 * - auto    : label triage-auto
 * - confirm : heure présente mais aucun label (à demander)
 * - untimed : aucune heure ni label (Triage peut en poser une)
 */
function timeMode(task) {
  if (hasModeLabel(task, FIXED_LABEL)) return 'fixed';
  if (hasModeLabel(task, AUTO_LABEL)) return 'auto';
  if (hasClock(task)) return 'confirm';
  return 'untimed';
}

/** Labels après application du mode demandé. */
function labelsForMode(task, mode) {
  const kept = labelsOf(task).filter((label) => !MODE_LABELS.includes(label));
  if (mode === 'fixed') kept.push(FIXED_LABEL);
  else if (mode === 'auto') kept.push(AUTO_LABEL);
  return [...new Set(kept)];
}

module.exports = {
  AUTO_LABEL,
  FIXED_LABEL,
  MODE_LABELS,
  hasModeLabel,
  hasClock,
  clockOf,
  timeMode,
  labelsForMode,
};
