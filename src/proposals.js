'use strict';

/**
 * Moteur de propositions (itération 3).
 *
 * À partir de l'instantané Todoist, ce module génère une liste de modifications
 * concrètes et réversibles, chacune destinée à être validée individuellement
 * depuis l'interface. Aucune écriture n'est faite ici : ce module est pur.
 *
 * Un identifiant stable (hash de la cible + de l'action) permet de retrouver la
 * même proposition d'un chargement à l'autre, et donc d'ignorer durablement
 * celles qu'on ne veut pas.
 */

const crypto = require('node:crypto');
const { addDaysIso, isValidIsoDate } = require('./dates');

const TYPE_META = {
  reschedule_overdue: { label: 'Reporter', tone: 'danger', score: 80 },
  archive_project: { label: 'Archiver', tone: 'muted', score: 60 },
  split_task: { label: 'Scinder', tone: 'ok', score: 45 },
  set_due_date: { label: 'Dater', tone: 'warn', score: 30 },
};

/**
 * Extrait les éléments d'une liste à puces dans une description.
 * Reconnaît « - x », « * x », « + x », « - [ ] x » et « - [x] x ».
 */
function parseChecklist(description) {
  if (typeof description !== 'string' || !description) return [];
  const items = [];
  for (const line of description.split(/\r?\n/)) {
    const match = line.match(/^\s*[-*+]\s+(?:\[[ xX]\]\s*)?(.+?)\s*$/);
    if (match && match[1].trim()) items.push(match[1].trim());
  }
  return items;
}

/** Description restante une fois les lignes de liste retirées. */
function descriptionWithoutChecklist(description) {
  if (typeof description !== 'string') return '';
  return description
    .split(/\r?\n/)
    .filter((line) => !/^\s*[-*+]\s+(?:\[[ xX]\]\s*)?.+?\s*$/.test(line))
    .join('\n')
    .trim();
}

function hashId(parts) {
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12);
}

function makeId(type, targetId, actionSignature) {
  return `${type}:${targetId}:${hashId([type, targetId, actionSignature])}`;
}

function shortList(items, max = 4) {
  const shown = items.slice(0, max).join(' · ');
  return items.length > max ? `${shown}…` : shown;
}

function targetFromTask(task) {
  return {
    kind: 'task',
    id: task.id,
    name: task.display_title || task.content,
    project_id: task.project_id,
    project_name: task.project_name || null,
    section_id: task.section_id || null,
  };
}

function buildReschedule(task, today) {
  return {
    id: makeId('reschedule_overdue', task.id, today),
    type: 'reschedule_overdue',
    title: 'Reporter à aujourd’hui',
    rationale: `Échéance dépassée de ${task.days_overdue} jour(s).`,
    target: targetFromTask(task),
    action: { due_date: today },
    editable: ['due_date'],
    preview: `Échéance → ${today}`,
    format: 'date',
    score: TYPE_META.reschedule_overdue.score + Math.min(20, task.days_overdue || 0),
  };
}

function buildSetDueDate(task, today, offsetDays) {
  const suggested = addDaysIso(today, offsetDays);
  return {
    id: makeId('set_due_date', task.id, suggested),
    type: 'set_due_date',
    title: 'Donner une échéance',
    rationale: `Créée il y a ${task.age_days} jour(s) et toujours sans échéance.`,
    target: targetFromTask(task),
    action: { due_date: suggested },
    editable: ['due_date'],
    preview: `Échéance → ${suggested}`,
    format: 'date',
    score: TYPE_META.set_due_date.score + Math.min(15, Math.round((task.age_days || 0) / 60)),
  };
}

function buildArchive(project) {
  const empty = project.diagnosis.verdict === 'empty';
  return {
    id: makeId('archive_project', project.id, 'archive'),
    type: 'archive_project',
    title: 'Archiver le projet',
    rationale: empty
      ? 'Ce projet ne contient aucune tâche active.'
      : `Aucune tâche terminée sur 90 j, ${project.stats.tasks} tâche(s) en attente.`,
    target: {
      kind: 'project',
      id: project.id,
      name: project.name,
      project_id: project.id,
      project_name: project.name,
      section_id: null,
    },
    action: { archive: true },
    editable: [],
    preview: 'Archivé (réversible depuis Todoist)',
    format: 'project',
    score: TYPE_META.archive_project.score + (empty ? 10 : 0),
  };
}

function buildSplit(task) {
  const items = parseChecklist(task.description);
  const remaining = descriptionWithoutChecklist(task.description);
  return {
    id: makeId('split_task', task.id, items.join('\u0001')),
    type: 'split_task',
    title: 'Scinder en sous-tâches',
    rationale: `La description contient ${items.length} élément(s) de liste.`,
    target: targetFromTask(task),
    action: { subtasks: items, remaining_description: remaining, update_description: true },
    editable: [],
    preview: `Créer ${items.length} sous-tâche(s) : ${shortList(items)}`,
    format: 'split',
    score: TYPE_META.split_task.score,
  };
}

/**
 * @param {object} params
 * @param {object[]} params.projects Projets normalisés (avec `diagnosis`, `stats`).
 * @param {object[]} params.tasks Tâches normalisées.
 * @param {string} params.today Date ISO du jour.
 * @param {{maxPerType:number, maxTotal:number, dueOffsetDays:number}} params.limits
 * @returns {{items: object[], summary: {total:number, by_type:object, truncated:object}}}
 */
function buildProposals({ projects, tasks, today, limits }) {
  const { maxPerType, maxTotal, dueOffsetDays, includeDueDate = true } = limits;
  const activeTasks = tasks.filter((task) => !task.project_archived);
  const truncated = {};

  const pools = {};

  pools.reschedule_overdue = activeTasks
    .filter((task) => task.is_overdue)
    .sort((a, b) => (b.days_overdue || 0) - (a.days_overdue || 0))
    .map((task) => buildReschedule(task, today));

  // La datation par règles est désactivée quand l'IA planifie jour par jour :
  // sinon on retombe sur « tout à la même date ».
  pools.set_due_date = includeDueDate
    ? activeTasks
        .filter((task) => !task.due_date && task.is_old)
        .sort((a, b) => (b.age_days || 0) - (a.age_days || 0))
        .map((task) => buildSetDueDate(task, today, dueOffsetDays))
    : [];

  pools.archive_project = projects
    .filter(
      (project) =>
        !project.is_archived &&
        !project.is_inbox &&
        project.diagnosis &&
        (project.diagnosis.verdict === 'empty' || project.diagnosis.verdict === 'dormant')
    )
    .sort((a, b) => (b.diagnosis?.score || 0) - (a.diagnosis?.score || 0))
    .map((project) => buildArchive(project));

  pools.split_task = activeTasks
    .filter((task) => parseChecklist(task.description).length >= 2)
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))
    .map((task) => buildSplit(task));

  const kept = [];
  for (const [type, pool] of Object.entries(pools)) {
    if (pool.length > maxPerType) truncated[type] = pool.length - maxPerType;
    kept.push(...pool.slice(0, maxPerType));
  }

  kept.sort((a, b) => b.score - a.score || a.type.localeCompare(b.type) || a.id.localeCompare(b.id));

  let items = kept;
  if (items.length > maxTotal) {
    truncated.total = items.length - maxTotal;
    items = items.slice(0, maxTotal);
  }

  const byType = {};
  for (const item of items) byType[item.type] = (byType[item.type] || 0) + 1;

  return {
    items,
    summary: { total: items.length, by_type: byType, truncated },
  };
}

/**
 * Retrouve une proposition par identifiant dans un instantané recalculé.
 * @returns {object|null}
 */
function findProposal(snapshot, id) {
  const list = Array.isArray(snapshot?.proposals) ? snapshot.proposals : [];
  return list.find((proposal) => proposal.id === id) || null;
}

/** Vérifie qu'une date ISO reçue du client est exploitable. */
function normalizeDueDate(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return isValidIsoDate(trimmed) ? trimmed : null;
}

function summarizeTypes(items) {
  const byType = {};
  for (const item of items) byType[item.type] = (byType[item.type] || 0) + 1;
  return byType;
}

/**
 * Fusionne les propositions à règles et celles de l'IA.
 * Les types couverts par l'IA prennent le pas sur les règles (ex. : l'IA datera
 * mieux que la règle « tout à la même date »).
 * @param {object[]} ruleItems
 * @param {object[]} aiItems
 * @param {{maxTotal?: number}} options
 */
function mergeProposalLists(ruleItems, aiItems, { maxTotal = 0 } = {}) {
  const rule = Array.isArray(ruleItems) ? ruleItems : [];
  const ai = Array.isArray(aiItems) ? aiItems : [];

  const aiTypes = new Set(ai.map((proposal) => proposal.type));
  const combined = [...rule.filter((proposal) => !aiTypes.has(proposal.type)), ...ai];

  const seen = new Set();
  const unique = [];
  for (const proposal of combined) {
    const key = `${proposal.type}:${proposal.target?.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(proposal);
  }

  unique.sort(
    (a, b) =>
      (b.score || 0) - (a.score || 0) ||
      a.type.localeCompare(b.type) ||
      String(a.id).localeCompare(String(b.id))
  );

  const items = maxTotal > 0 ? unique.slice(0, maxTotal) : unique;
  const truncated = {};
  if (items.length < unique.length) truncated.total = unique.length - items.length;

  return {
    items,
    summary: { total: items.length, by_type: summarizeTypes(items), truncated },
  };
}

module.exports = {
  TYPE_META,
  parseChecklist,
  descriptionWithoutChecklist,
  buildProposals,
  findProposal,
  normalizeDueDate,
  targetFromTask,
  mergeProposalLists,
};
