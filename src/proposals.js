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

/** Normalise un titre pour repérer les doublons (accents, ponctuation, casse). */
function normalizeTitle(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Score « à garder » entre deux doublons : échéance, labels, priorité, fraîcheur. */
function keepScore(task) {
  let score = 0;
  if (task.due_date) score += 4;
  score += Math.min(3, (task.labels || []).length);
  score += (task.priority || 1) - 1;
  if (task.description) score += 1;
  return score;
}

/** Construit une proposition de suppression, avec de quoi restaurer la tâche. */
function makeDeleteProposal(task, kind, rationale) {
  return {
    id: makeId('delete_task', task.id, kind),
    type: 'delete_task',
    type_label: 'Abandonner',
    action_label: 'Supprimer',
    source: 'cleanup',
    tone: 'danger',
    score: kind === 'orphan' ? 55 : kind === 'duplicate' ? 50 : 45,
    cleanup_kind: kind,
    title: kind === 'duplicate' ? 'Supprimer un doublon' : 'Supprimer une tâche abandonnée',
    rationale,
    target: {
      kind: 'task',
      id: task.id,
      name: task.display_title || task.content,
      project_id: task.project_id || null,
      project_name: task.project_name || null,
      section_id: task.section_id || null,
    },
    action: {
      delete: true,
      restore: {
        content: task.content,
        description: task.description || '',
        project_id: task.project_id || null,
        section_id: task.section_id || null,
        parent_id: task.parent_id || null,
        labels: task.labels || [],
        priority: task.priority || 1,
        due_date: task.due_date || null,
      },
    },
    editable: [],
    preview: 'Supprimée — récupérable via la corbeille',
    format: 'delete',
  };
}

/**
 * Détecte les tâches à nettoyer : fantômes (très anciennes sans date),
 * doublons (même titre dans un projet) et orphelines (projet absent).
 */
function buildCleanupTasks({ tasks, projects, limits }) {
  const { ghostDays = 365, cleanupMaxPerKind = 10, cleanupMaxTotal = 25 } = limits;
  const projectIds = new Set(projects.map((project) => project.id));
  const result = [];

  // Tâches fantômes : anciennes, sans échéance, jamais retouchées, hors sous-tâches.
  const ghosts = tasks
    .filter(
      (task) =>
        !task.due_date &&
        !task.parent_id &&
        task.age_days !== null &&
        task.age_days >= ghostDays
    )
    .sort((a, b) => (b.age_days || 0) - (a.age_days || 0))
    .slice(0, cleanupMaxPerKind);

  for (const task of ghosts) {
    result.push(
      makeDeleteProposal(
        task,
        'ghost',
        `Créée il y a ${task.age_days} j, sans échéance : probablement abandonnée.`
      )
    );
  }

  // Doublons : même titre normalisé dans un même projet.
  const groups = new Map();
  for (const task of tasks) {
    if (!task.project_id || !projectIds.has(task.project_id)) continue;
    const normalized = normalizeTitle(task.display_title || task.content);
    if (normalized.length < 4) continue;
    const key = `${task.project_id}::${normalized}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(task);
  }

  let duplicates = 0;
  for (const list of groups.values()) {
    if (list.length < 2 || duplicates >= cleanupMaxPerKind) continue;
    const sorted = [...list].sort((a, b) => keepScore(b) - keepScore(a));
    const keep = sorted[0];
    for (const task of sorted.slice(1)) {
      if (duplicates >= cleanupMaxPerKind) break;
      duplicates += 1;
      result.push(
        makeDeleteProposal(
          task,
          'duplicate',
          `Doublon de « ${keep.display_title || keep.content} » dans le même projet.`
        )
      );
    }
  }

  // Orphelines : projet absent du compte.
  for (const task of tasks.filter((t) => !t.project_id || !projectIds.has(t.project_id)).slice(0, 5)) {
    result.push(makeDeleteProposal(task, 'orphan', 'Tâche rattachée à un projet absent du compte.'));
  }

  return result.slice(0, cleanupMaxTotal);
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
  const {
    maxPerType,
    maxTotal,
    dueOffsetDays,
    includeDueDate = true,
    includeCleanup = true,
  } = limits;
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
    .filter((task) => (task.subtask_count || 0) === 0)
    .filter((task) => parseChecklist(task.description).length >= 2)
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))
    .map((task) => buildSplit(task));

  pools.delete_task = includeCleanup
    ? buildCleanupTasks({ tasks: activeTasks, projects, limits })
    : [];

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
  buildCleanupTasks,
  normalizeTitle,
  findProposal,
  normalizeDueDate,
  targetFromTask,
  mergeProposalLists,
};
