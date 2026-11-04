'use strict';

/**
 * Ordre du jour (itération 17).
 *
 * Bouton « Réorganiser la journée » : on liste les tâches réellement prévues ce
 * jour-là (tâches principales + préparations), puis on produit deux ordres :
 *   - un ordre de PRIORITÉ déterministe (P1 → P4, retards d'abord) ;
 *   - un ordre d'EXÉCUTION proposé par l'IA (prérequis, préparations avant leur
 *     parent, enchaînement logique).
 *
 * Lecture seule : aucun ordre n'est écrit dans Todoist.
 */

const crypto = require('node:crypto');
const { config } = require('./config');
const { chatJson, AiError } = require('./ai');
const { estimateTaskSize } = require('./capacity');
const { PREPARATION_MARKER } = require('./prepare');

const SYSTEM_PROMPT = [
  'Tu organises une journée de travail pour une personne.',
  'Tu ordonnes les tâches dans l’ordre où elles doivent être exécutées.',
  'Tu ne renommes rien, tu ne supprimes rien, tu ne crées rien.',
  'Tu réponds UNIQUEMENT par un objet JSON valide, sans texte autour.',
].join(' ');

const MAX_TASKS = 40;
const ORDER_PREFIX = /^\s*\d+[.)]\s+/;

let cache = new Map(); // date -> { signature, tasks, priority, execution, summary, ... }

function signatureOf(value) {
  return crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex');
}

function titleOf(task) {
  return String(task?.display_title || task?.content || '').trim();
}

function isPreparationTask(task) {
  if (!task?.parent_id) return false;
  if (String(task.description || '').includes(PREPARATION_MARKER)) return true;
  // Anciennes préparations : sous-tâche numérotée ET datée.
  return Boolean(task.due_date && ORDER_PREFIX.test(titleOf(task)));
}

function taskMeta(task, parentTitle) {
  return {
    id: task.id,
    title: titleOf(task).slice(0, 160),
    priority: task.priority || 1,
    priority_label: task.priority_label || `P${5 - (task.priority || 1)}`,
    size: estimateTaskSize(task, task.subtask_count || 0),
    overdue: Boolean(task.is_overdue),
    is_prep: isPreparationTask(task),
    parent_title: parentTitle ? parentTitle.slice(0, 120) : null,
    labels: (task.labels || []).slice(0, 5),
    note: String(task.description || '').slice(0, 220) || null,
  };
}

/** Tâches visibles pour ce jour : principales + préparations (+ retards si aujourd'hui). */
function listDayTasks(snapshot, date) {
  const today = snapshot.meta.today;
  const isToday = date === today;
  const byId = new Map((snapshot.tasks || []).map((task) => [task.id, task]));
  const seen = new Set();
  const tasks = [];

  for (const task of snapshot.tasks || []) {
    if (task.project_archived) continue;
    if (task.parent_id && !isPreparationTask(task)) continue;
    const onDay = task.due_date === date;
    const overdue = isToday && task.is_overdue && task.due_date !== date;
    if (!onDay && !overdue) continue;
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    const parent = task.parent_id ? byId.get(task.parent_id) : null;
    tasks.push(taskMeta(task, parent ? titleOf(parent) : null));
    if (tasks.length >= MAX_TASKS) break;
  }

  return tasks;
}

/** Ordre de priorité : P1 d'abord, puis retards, puis titre. */
function priorityOrder(tasks) {
  return [...tasks].sort(
    (a, b) =>
      (b.priority || 1) - (a.priority || 1) ||
      Number(b.overdue) - Number(a.overdue) ||
      a.title.localeCompare(b.title, 'fr-FR')
  );
}

function buildDayOrderDigest(tasks, date) {
  return {
    date,
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      priority: task.priority_label,
      size: task.size,
      overdue: task.overdue,
      is_preparation: task.is_prep,
      parent: task.parent_title,
      labels: task.labels,
      note: task.note,
    })),
  };
}

function buildOrderPrompt(digest) {
  return [
    `Ordonne les tâches du ${digest.date} pour une exécution réelle.`,
    '',
    'Règles :',
    '- Les préparations (is_preparation) passent avant la tâche parente concernée.',
    '- Respecte les dépendances logiques et les prérequis.',
    '- Commence par ce qui est urgent/en retard, puis les priorités hautes.',
    '- Alterne les grosses tâches avec des petites si c’est plus réaliste.',
    '- Ne tiens pas compte des tâches qui ne sont pas dans la liste.',
    '- Utilise chaque identifiant exactement une fois.',
    '',
    'Donne une raison courte (max 10 mots) pour chaque tâche.',
    '',
    'Réponds EXACTEMENT par ce JSON :',
    '{"summary":"phrase courte expliquant l’ordre",',
    ' "order":[{"id":"...","why":"..."}]}',
    '',
    'Données :',
    JSON.stringify(digest),
  ].join('\n');
}

function validateOrderResponse(parsed, tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const seen = new Set();
  const execution = [];

  const raw = Array.isArray(parsed?.order) ? parsed.order : [];
  for (const entry of raw) {
    const id = String(typeof entry === 'string' ? entry : entry?.id || '');
    if (!byId.has(id) || seen.has(id)) continue;
    seen.add(id);
    execution.push({
      id,
      why:
        typeof entry?.why === 'string' && entry.why.trim()
          ? entry.why.trim().slice(0, 120)
          : null,
    });
  }

  const fallback = priorityOrder(tasks);
  for (const task of fallback) {
    if (!seen.has(task.id)) execution.push({ id: task.id, why: null });
  }

  return {
    execution,
    changed: execution.filter((entry, index) => entry.id !== fallback[index]?.id).length,
    summary:
      typeof parsed?.summary === 'string' && parsed.summary.trim()
        ? parsed.summary.trim().slice(0, 300)
        : null,
  };
}

async function generateDayOrder(snapshot, date, { force = false } = {}) {
  const tasks = listDayTasks(snapshot, date);
  const priority = priorityOrder(tasks).map((task) => task.id);
  const fallbackExecution = priority.map((id) => ({ id, why: null }));

  if (tasks.length === 0) {
    return {
      date,
      tasks,
      priority,
      execution: [],
      changed: 0,
      summary: 'Aucune tâche prévue ce jour-là.',
      cached: false,
      usage: null,
    };
  }

  if (!config.aiEnabled) {
    return {
      date,
      tasks,
      priority,
      execution: fallbackExecution,
      changed: 0,
      summary: 'IA désactivée : ordre de priorité utilisé.',
      cached: false,
      usage: null,
    };
  }

  const digest = buildDayOrderDigest(tasks, date);
  const signature = signatureOf(digest);
  const cached = cache.get(String(date));
  const fresh =
    cached &&
    cached.signature === signature &&
    (config.aiCacheTtlMs === 0 || Date.now() - cached.generatedAt < config.aiCacheTtlMs);

  if (fresh && !force) return { ...cached, cached: true };

  let data;
  let usage = null;
  let model = null;
  try {
    const response = await chatJson({
      system: SYSTEM_PROMPT,
      user: buildOrderPrompt(digest),
    });
    data = response.data;
    usage = response.usage;
    model = response.model;
  } catch (error) {
    // L'IA peut timeout : le bouton doit quand même produire un ordre utile.
    console.warn('[ordre] IA indisponible :', error?.code || error?.message);
    return {
      date,
      tasks,
      priority,
      execution: fallbackExecution,
      changed: 0,
      summary: 'IA indisponible : ordre de priorité utilisé.',
      cached: false,
      usage: null,
    };
  }

  const { execution, changed, summary } = validateOrderResponse(data, tasks);
  const entry = {
    signature,
    date,
    tasks,
    priority,
    execution,
    changed,
    summary: summary || 'Ordre proposé selon les priorités et les dépendances.',
    generatedAt: Date.now(),
    usage,
    model,
  };
  cache.set(String(date), entry);

  return { ...entry, cached: false };
}

function clearDayOrderCache() {
  cache = new Map();
}

module.exports = {
  SYSTEM_PROMPT,
  listDayTasks,
  priorityOrder,
  buildDayOrderDigest,
  buildOrderPrompt,
  validateOrderResponse,
  generateDayOrder,
  clearDayOrderCache,
  isPreparationTask,
};
