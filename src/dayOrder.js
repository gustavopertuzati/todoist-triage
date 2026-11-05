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
const DEFAULT_MINUTES = { L: 60, M: 30, S: 15 };
const CONTEXTS = ['phone', 'computer', 'home', 'outside', 'office', 'other'];
const PHONE_RE =
  /\b(appel|appeler|t[ée]l[ée]phone|t[ée]l[ée]phoner|tel|phone|sms|whatsapp|message vocal)\b/i;
const COMPUTER_RE =
  /\b(ordi|ordinateur|computer|mail|email|e-mail|excel|word|code|dev|site|web|admin)\b/i;

function detectContext(task) {
  const haystack = `${titleOf(task)} ${(task.labels || []).join(' ')}`;
  if (PHONE_RE.test(haystack)) return 'phone';
  if (COMPUTER_RE.test(haystack)) return 'computer';
  return 'other';
}

/** Durée : durée Todoist si renseignée, sinon estimation par taille. */
function estimateMinutes(task, size, aiMinutes = null) {
  const duration = task?.duration;
  if (duration && typeof duration === 'object') {
    const amount = Number(duration.amount) || 0;
    if (amount > 0) {
      const minutes = duration.unit === 'hour' ? amount * 60 : amount;
      if (minutes >= 5 && minutes <= 480) return Math.round(minutes);
    }
  }
  const proposed = Number(aiMinutes);
  if (Number.isFinite(proposed) && proposed >= 5 && proposed <= 480) {
    return Math.round(proposed);
  }
  return DEFAULT_MINUTES[size] || 30;
}

function normalizeMinutes(value, fallback) {
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes >= 5 && minutes <= 480
    ? Math.round(minutes)
    : fallback;
}

function normalizeContext(value, fallback) {
  return CONTEXTS.includes(value) ? value : fallback;
}

function formatMinutes(total) {
  const minutes = Math.max(0, Math.round(total));
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

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
  const size = estimateTaskSize(task, task.subtask_count || 0);
  return {
    id: task.id,
    title: titleOf(task).slice(0, 160),
    priority: task.priority || 1,
    priority_label: task.priority_label || `P${5 - (task.priority || 1)}`,
    size,
    minutes: estimateMinutes(task, size),
    context: detectContext(task),
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
      minutes_hint: task.minutes,
      context_hint: task.context,
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
    'Pour chaque tâche :',
    '- estime "minutes" de façon réaliste (5 à 480) d’après le titre, la note, la taille et le contexte ;',
    '- classe "context" parmi phone, computer, home, outside, office, other.',
    '- donne une raison courte (max 10 mots) dans "why".',
    '',
    'Réponds EXACTEMENT par ce JSON :',
    '{"summary":"phrase courte expliquant l’ordre",',
    ' "order":[{"id":"...","why":"...","minutes":30,"context":"computer"}]}',
    '',
    'Données :',
    JSON.stringify(digest),
  ].join('\n');
}

function validateOrderResponse(parsed, tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const seen = new Set();
  const execution = [];

  const fallbackMinutes = (task) =>
    Number.isFinite(task.minutes) ? task.minutes : estimateMinutes(task, task.size || 'M');
  const fallbackContext = (task) =>
    CONTEXTS.includes(task.context) ? task.context : detectContext(task);

  const raw = Array.isArray(parsed?.order) ? parsed.order : [];
  for (const entry of raw) {
    const id = String(typeof entry === 'string' ? entry : entry?.id || '');
    const task = byId.get(id);
    if (!task || seen.has(id)) continue;
    seen.add(id);
    const heuristicContext = fallbackContext(task);
    let context = normalizeContext(entry?.context, heuristicContext);
    // Sécurité : l'IA ne peut pas envoyer une tâche à 9h « téléphone » sans
    // indice concret dans le titre ou les labels.
    if (context === 'phone' && heuristicContext !== 'phone') context = heuristicContext;

    execution.push({
      id,
      why:
        typeof entry?.why === 'string' && entry.why.trim()
          ? entry.why.trim().slice(0, 120)
          : null,
      minutes: normalizeMinutes(entry?.minutes, fallbackMinutes(task)),
      context,
    });
  }

  const fallback = priorityOrder(tasks);
  for (const task of fallback) {
    if (!seen.has(task.id)) {
      execution.push({
        id: task.id,
        why: null,
        minutes: fallbackMinutes(task),
        context: fallbackContext(task),
      });
    }
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

const DAY_END = 17 * 60;

function scheduleVariant(key, label, ordered, { phoneStart, otherStart }) {
  const phoneMinutes = ordered
    .filter((task) => task.context === 'phone')
    .reduce((sum, task) => sum + task.minutes, 0);
  let phoneCursor = phoneStart;
  // Les tâches non-téléphone ne commencent jamais avant 11h ni avant la fin
  // réelle des tâches téléphone, pour éviter les chevauchements.
  let otherCursor = Math.max(otherStart, phoneStart + phoneMinutes);
  let overflow = 0;
  const items = [];
  const starts = [];
  const ends = [];

  for (const task of ordered) {
    const phone = task.context === 'phone';
    const start = Math.max(phone ? phoneCursor : otherCursor, phone ? phoneStart : otherStart);
    const end = start + task.minutes;
    if (phone) phoneCursor = end;
    else otherCursor = end;

    const over = Math.max(0, end - DAY_END);
    overflow += over;
    starts.push(start);
    ends.push(end);
    items.push({
      id: task.id,
      start: formatMinutes(start),
      end: formatMinutes(end),
      minutes: task.minutes,
      context: task.context,
      overflow: over > 0,
    });
  }

  return {
    key,
    label,
    start: items.length ? formatMinutes(Math.min(...starts)) : null,
    end: items.length ? formatMinutes(Math.max(...ends)) : null,
    overflow_minutes: overflow,
    items,
  };
}

/** Trois planifications + une variante décalée (ordre et heure de départ). */
function buildScheduleVariants(tasks, execution) {
  if (tasks.length === 0) return [];
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const executionTasks = execution
    .map((entry) => byId.get(entry.id))
    .filter(Boolean);
  const priorityTasks = priorityOrder(tasks);
  const shortTasks = [...tasks].sort(
    (a, b) =>
      a.minutes - b.minutes ||
      (b.priority || 1) - (a.priority || 1) ||
      a.title.localeCompare(b.title, 'fr-FR')
  );

  return [
    scheduleVariant('equilibre', 'Exécution', executionTasks, {
      phoneStart: 9 * 60,
      otherStart: 11 * 60,
    }),
    scheduleVariant('priorite', 'Priorité', priorityTasks, {
      phoneStart: 9 * 60,
      otherStart: 11 * 60,
    }),
    scheduleVariant('court', 'Courtes d’abord', shortTasks, {
      phoneStart: 9 * 60,
      otherStart: 11 * 60,
    }),
    scheduleVariant('decale', 'Départ décalé', executionTasks, {
      phoneStart: 10 * 60,
      otherStart: 11 * 60 + 30,
    }),
  ];
}

async function generateDayOrder(snapshot, date, { force = false } = {}) {
  const tasks = listDayTasks(snapshot, date);
  const priority = priorityOrder(tasks).map((task) => task.id);
  const fallbackExecution = priority.map((id) => {
    const task = tasks.find((item) => item.id === id);
    return {
      id,
      why: null,
      minutes: task ? task.minutes : 30,
      context: task ? task.context : 'other',
    };
  });

  if (tasks.length === 0) {
    return {
      date,
      tasks,
      priority,
      execution: [],
      variants: [],
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
      variants: buildScheduleVariants(tasks, fallbackExecution),
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
      variants: buildScheduleVariants(tasks, fallbackExecution),
      changed: 0,
      summary: 'IA indisponible : ordre de priorité utilisé.',
      cached: false,
      usage: null,
    };
  }

  const { execution, changed, summary } = validateOrderResponse(data, tasks);
  // Reporte les durées/contextes estimés par l'IA sur les tâches, pour les plans.
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const item of execution) {
    const task = byId.get(item.id);
    if (!task) continue;
    task.minutes = item.minutes;
    task.context = item.context;
  }
  const variants = buildScheduleVariants(tasks, execution);
  const entry = {
    signature,
    date,
    tasks,
    priority,
    execution,
    variants,
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
  buildScheduleVariants,
  estimateMinutes,
  detectContext,
  formatMinutes,
  DEFAULT_MINUTES,
  CONTEXTS,
  generateDayOrder,
  clearDayOrderCache,
  isPreparationTask,
};
