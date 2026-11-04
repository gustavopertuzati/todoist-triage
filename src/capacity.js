'use strict';

/**
 * Capacité journalière (itération 5).
 *
 * Règle « 1-3-5 » : une journée saine contient au plus 1 grosse tâche,
 * 3 tâches moyennes et 5 petites. On mesure d'abord la charge DÉJÀ posée dans
 * Todoist (tâches ayant une échéance), puis on n'accepte de nouvelles
 * propositions que s'il reste de la place.
 *
 * La taille d'une tâche est estimée de façon déterministe à partir de sa durée
 * (si renseignée), du nombre de sous-tâches et de la longueur de la note.
 */

const { addDaysIso } = require('./dates');

const SIZES = ['L', 'M', 'S'];
const SIZE_LABELS = { L: 'Gros', M: 'Moyen', S: 'Petit' };

/** Estime la taille d'une tâche : 'L' (gros), 'M' (moyen) ou 'S' (petit). */
function estimateTaskSize(task, subtaskCount = null) {
  const count = subtaskCount === null ? task.subtask_count || 0 : subtaskCount;
  const duration = task && task.duration;
  if (duration && typeof duration === 'object') {
    const amount = Number(duration.amount) || 0;
    const unit = duration.unit;
    const minutes = unit === 'hour' ? amount * 60 : amount;
    if (minutes > 0) {
      if (minutes >= 60) return 'L';
      if (minutes >= 30) return 'M';
      return 'S';
    }
  }

  const noteLength = typeof task.description === 'string' ? task.description.trim().length : 0;
  if (count >= 3 || noteLength > 600) return 'L';
  if (count >= 1 || noteLength > 200) return 'M';

  const title = String(task.display_title || task.content || '');
  if (title.length > 90) return 'M';
  return 'S';
}

/** Nom du jour en français, sans souci de fuseau. */
function weekdayName(iso) {
  const date = new Date(`${iso}T12:00:00Z`);
  return new Intl.DateTimeFormat('fr-FR', { weekday: 'long', timeZone: 'UTC' }).format(date);
}

function emptyLoad() {
  return { L: 0, M: 0, S: 0 };
}

/**
 * Construit le plan des `horizonDays` prochains jours à partir des tâches déjà
 * planifiées, avec la place restante par taille.
 */
function buildAgenda({ tasks, today, horizonDays, rule }) {
  const lastDay = addDaysIso(today, horizonDays - 1);
  const byDate = new Map();

  for (const task of tasks) {
    if (task.project_archived || !task.due_date) continue;
    if (task.due_date < today || task.due_date > lastDay) continue;
    if (!byDate.has(task.due_date)) byDate.set(task.due_date, []);
    byDate.get(task.due_date).push(task);
  }

  const days = [];
  for (let i = 0; i < horizonDays; i += 1) {
    const date = addDaysIso(today, i);
    const items = byDate.get(date) || [];
    const load = emptyLoad();
    for (const task of items) load[estimateTaskSize(task, task.subtask_count || 0)] += 1;

    const remaining = {};
    for (const size of SIZES) remaining[size] = Math.max(0, rule[size] - load[size]);

    days.push({
      date,
      weekday: weekdayName(date),
      load,
      remaining,
      total: items.length,
      full: SIZES.every((size) => remaining[size] === 0),
    });
  }

  return days;
}

/**
 * Ne garde que les propositions qui tiennent dans la capacité restante.
 * Les propositions trop grosses pour un jour sont rejetées (l'appelant peut
 * alors les reproposer sur un autre jour).
 * @returns {{accepted: object[], rejected: object[]}}
 */
function enforceCapacity(proposals, agenda, rule) {
  const remaining = new Map(
    agenda.map((day) => [day.date, { ...day.remaining }])
  );
  const accepted = [];
  const rejected = [];

  for (const proposal of proposals) {
    const date = proposal.action && proposal.action.due_date;
    const slot = remaining.get(date);
    const size = SIZES.includes(proposal.size) ? proposal.size : 'M';

    if (!slot || slot[size] <= 0) {
      rejected.push(proposal);
      continue;
    }
    slot[size] -= 1;
    accepted.push(proposal);
  }

  return { accepted, rejected };
}

/** Petit résumé textuel d'une journée, ex. « 1 gros · 2 moyens · 3 petits ». */
function describeLoad(load) {
  const parts = [];
  if (load.L > 0) parts.push(`${load.L} gros`);
  if (load.M > 0) parts.push(`${load.M} moyen${load.M > 1 ? 's' : ''}`);
  if (load.S > 0) parts.push(`${load.S} petit${load.S > 1 ? 's' : ''}`);
  return parts.join(' · ') || 'libre';
}

module.exports = {
  SIZES,
  SIZE_LABELS,
  estimateTaskSize,
  weekdayName,
  buildAgenda,
  enforceCapacity,
  describeLoad,
};
