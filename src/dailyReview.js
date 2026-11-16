'use strict';

/**
 * Bilan de la veille et adaptation par essais/erreurs (itération 48).
 *
 * Chaque jour, l'app regarde les tâches qui étaient prévues la veille et qui
 * n'ont pas été terminées. Un petit questionnaire demande pourquoi (trop
 * grosse, pas la motivation, pas le temps, trop de choses, oubliée…), puis :
 *   - baisse (ou remonte) progressivement la quantité d'une tâche
 *     (« Lire 40 pages » → « Lire 20 pages » → « Lire 10 pages ») ;
 *   - reporte la tâche sans toucher à l'objectif quand le problème est le temps ;
 *   - allège la journée quand la personne dit « trop de choses » ;
 *   - met à jour le rythme de l'objectif associé (GOALS.json) ;
 *   - se souvient des réussites pour remonter vers l'objectif de départ.
 *
 * Module pur : aucune écriture Todoist, aucun accès fichier. Les propositions
 * renvoyées restent à valider individuellement dans l'interface.
 */

const crypto = require('node:crypto');
const { addDaysIso, isValidIsoDate, todayInTimeZone } = require('./dates');
const { stripTimeMarker } = require('./taskTitles');

const REASONS = [
  {
    value: 'too_big',
    label: 'Trop grande',
    short: 'trop grosse',
    help: 'Elle me décourage par sa taille.',
  },
  {
    value: 'no_motivation',
    label: 'Pas la motiv',
    short: 'pas la motivation',
    help: 'Je n’avais pas envie de m’y mettre.',
  },
  {
    value: 'no_time',
    label: 'Pas le temps',
    short: 'pas eu le temps',
    help: 'La journée a manqué de temps.',
  },
  {
    value: 'too_many',
    label: 'Trop de choses',
    short: 'trop de choses',
    help: 'La journée était surchargée.',
  },
  {
    value: 'forgot',
    label: 'Oubliée',
    short: 'oubliée',
    help: 'Je suis passé à côté.',
  },
  {
    value: 'unclear',
    label: 'Pas claire',
    short: 'pas assez claire',
    help: 'Je ne savais pas par quoi commencer.',
  },
  {
    value: 'external',
    label: 'Imprévu',
    short: 'un imprévu',
    help: 'Un empêchement extérieur.',
  },
  {
    value: 'not_priority',
    label: 'Pas prioritaire',
    short: 'pas prioritaire',
    help: 'Ce n’est pas le moment pour cet objectif.',
  },
];

const ACTIONS = [
  { value: 'auto', label: 'Adapter automatiquement' },
  { value: 'reduce', label: 'Baisser la quantité' },
  { value: 'micro', label: 'Version minimale (2 min)' },
  { value: 'split', label: 'Découper en petites étapes' },
  { value: 'move_today', label: 'Reporter à aujourd’hui' },
  { value: 'move_tomorrow', label: 'Reporter à demain' },
  { value: 'keep', label: 'Garder telle quelle' },
  { value: 'skip', label: 'Laisser tomber cette fois' },
];

const REASON_LABELS = Object.fromEntries(REASONS.map((reason) => [reason.value, reason.label]));
const ACTION_LABELS = Object.fromEntries(ACTIONS.map((action) => [action.value, action.label]));
const REASON_VALUES = new Set(REASONS.map((reason) => reason.value));
const ACTION_VALUES = new Set(ACTIONS.map((action) => action.value));

/**
 * Unités reconnues dans les titres. `min`/`max` bornent la version adaptée.
 * Le motif est volontairement prudent : « 20 h » n'est pas une durée, tandis
 * que « 30 min » et « 40 pages » le sont.
 */
const UNITS = [
  { canonical: 'pages', pattern: /(\d{1,4})\s*(pages?|p\.)(?=\s|$|[),.;])/i, min: 2, labels: ['page', 'pages'] },
  { canonical: 'minutes', pattern: /(\d{1,4})\s*(minutes?|min|mn)(?=\s|$|[),.;])/i, min: 5, labels: ['minute', 'minutes'] },
  { canonical: 'heures', pattern: /(\d{1,2}(?:[.,]\d)?)\s*(heures?)(?=\s|$|[),.;])/i, min: 1, labels: ['heure', 'heures'] },
  { canonical: 'tests', pattern: /(\d{1,3})\s*(tests?|quiz)(?=\s|$|[),.;])/i, min: 1, labels: ['test', 'tests'] },
  { canonical: 'exercices', pattern: /(\d{1,3})\s*(exercices?|exos?)(?=\s|$|[),.;])/i, min: 1, labels: ['exercice', 'exercices'] },
  { canonical: 'séances', pattern: /(\d{1,2})\s*(séances?|seances?|sessions?)(?=\s|$|[),.;])/i, min: 1, labels: ['séance', 'séances'] },
  { canonical: 'chapitres', pattern: /(\d{1,3})\s*(chapitres?)(?=\s|$|[),.;])/i, min: 1, labels: ['chapitre', 'chapitres'] },
  { canonical: 'kilomètres', pattern: /(\d{1,3}(?:[.,]\d)?)\s*(km|kilomètres?|kilometres?)(?=\s|$|[),.;])/i, min: 1, labels: ['km', 'km'] },
  { canonical: 'candidatures', pattern: /(\d{1,3})\s*(candidatures?)(?=\s|$|[),.;])/i, min: 1, labels: ['candidature', 'candidatures'] },
  { canonical: 'leçons', pattern: /(\d{1,3})\s*(leçons?|lecons?)(?=\s|$|[),.;])/i, min: 1, labels: ['leçon', 'leçons'] },
  { canonical: 'cartes', pattern: /(\d{1,3})\s*(cartes?|pièces?|pieces?)(?=\s|$|[),.;])/i, min: 1, labels: ['carte', 'cartes'] },
  { canonical: 'jours', pattern: /(\d{1,3})\s*(jours?)(?=\s|$|[),.;])/i, min: 1, labels: ['jour', 'jours'] },
];

function text(value, max = 300) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function normalizeText(value) {
  return stripTimeMarker(String(value || ''))
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Clé stable d'une tâche, sans nombre ni unité : « Lire 40 pages » → « lire ». */
function taskKey(title) {
  let key = normalizeText(title);
  for (const unit of UNITS) {
    // Plus robuste que de réutiliser le motif complet : on retire le nombre
    // suivi de l'unité, quel que soit le séparateur (« 40 pages », « 30 min »).
    const words = new Set(unit.labels.map((label) => label.toLowerCase()));
    if (unit.canonical === 'minutes') {
      words.add('min');
      words.add('mn');
    }
    if (unit.canonical === 'kilomètres') words.add('km');
    const labels = [...words]
      .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
    const regex = new RegExp(`\\b\\d{1,4}(?:[.,]\\d+)?\\s*(?:${labels})\\b`, 'gi');
    key = key.replace(regex, ' ');
  }
  key = key
    .replace(/\b\d{1,2}[:h]\d{2}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return key || normalizeText(title);
}

/** Repère une quantité dans un titre : 40 pages, 30 min, 3 tests… */
function parseQuantity(title) {
  const value = String(title || '');
  let best = null;
  for (const unit of UNITS) {
    const match = unit.pattern.exec(value);
    if (!match) continue;
    if (best && match.index >= best.index) continue;
    const rawValue = Number(match[1].replace(',', '.'));
    if (!Number.isFinite(rawValue) || rawValue <= 0) continue;
    best = {
      value: rawValue,
      unit: unit.canonical,
      rawUnit: match[2],
      min: unit.min,
      index: match.index,
      length: match[0].length,
      match: match[0],
      labels: unit.labels,
    };
  }
  if (!best) return null;
  return {
    value: best.value,
    unit: best.unit,
    rawUnit: best.rawUnit,
    min: best.min,
    index: best.index,
    length: best.length,
    match: best.match,
  };
}

function unitLabel(unit, value) {
  const def = UNITS.find((entry) => entry.canonical === unit);
  if (!def) return unit;
  const [singular, plural] = def.labels;
  return Math.abs(value) <= 1 ? singular : plural;
}

/** Remplace la quantité du titre en conservant le reste. */
function replaceQuantity(title, value) {
  const parsed = parseQuantity(title);
  if (!parsed) return String(title || '');
  const label = unitLabel(parsed.unit, value);
  const replacement = `${formatNumber(value)} ${label}`;
  return `${title.slice(0, parsed.index)}${replacement}${title.slice(parsed.index + parsed.length)}`
    .replace(/\s+/g, ' ')
    .trim();
}

function formatNumber(value) {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded).replace('.', ',');
}

function roundToStep(value, step) {
  return Math.max(step, Math.round(value / step) * step);
}

/**
 * Baisse une quantité pour rendre la tâche faisable.
 * @param {{value:number, unit:string, base?:number}} quantity
 * @param {{ratio?:number, micro?:boolean, failStreak?:number}} options
 */
function lowerQuantity(quantity, options = {}) {
  const current = Number(quantity && quantity.value);
  if (!Number.isFinite(current) || current <= 1) return current || null;
  const unit = quantity.unit || null;
  const def = UNITS.find((entry) => entry.canonical === unit);
  const min = def ? def.min : 1;
  let ratio = options.micro ? 0.25 : Number(options.ratio) || 0.75;
  if ((options.failStreak || 0) >= 2) ratio = Math.min(ratio, 0.5);
  // Les nombres ronds sont plus faciles à retenir : 40 → 30 → 20 → 10.
  const step = unit === 'pages' || unit === 'minutes' || current >= 20 ? 5 : 1;
  let next = roundToStep(current * ratio, step);
  if (current >= 10 && step === 5) next = Math.max(min, Math.round(next / 5) * 5);
  if (next >= current) next = current - Math.min(step, current - min || step);
  return Math.max(min, next);
}

/** Remonte doucement vers l'objectif de départ après des réussites. */
function raiseQuantity(current, base, unit) {
  const value = Number(current);
  const target = Number(base);
  if (!Number.isFinite(value) || !Number.isFinite(target) || value >= target) return value;
  const step = unit === 'pages' || unit === 'minutes' || target >= 20 ? 5 : Math.max(1, Math.round(target / 4));
  return Math.min(target, value + step);
}

function reasonLabel(value) {
  return REASON_LABELS[value] || value;
}

function reasonHelp(value) {
  return (REASONS.find((reason) => reason.value === value) || {}).help || null;
}

function defaultAction(reason) {
  switch (reason) {
    case 'too_big':
    case 'no_motivation':
      return 'reduce';
    case 'no_time':
    case 'forgot':
    case 'external':
      return 'move_today';
    case 'unclear':
      return 'keep';
    case 'too_many':
      return 'keep';
    case 'not_priority':
      return 'move_tomorrow';
    default:
      return 'keep';
  }
}

function decideAction(answer, quantity) {
  const requested = ACTION_VALUES.has(answer.action) && answer.action !== 'auto' ? answer.action : null;
  if (requested) return requested;
  const fallback = defaultAction(answer.reason);
  if (fallback === 'reduce' && !quantity) return 'split';
  return fallback;
}

function normalizeAnswers(input) {
  if (!Array.isArray(input)) return [];
  const byTask = new Map();
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const taskId = text(raw.taskId, 80);
    if (!taskId) continue;
    if (!REASON_VALUES.has(raw.reason)) continue;
    const answer = {
      taskId,
      reason: raw.reason,
      action: ACTION_VALUES.has(raw.action) ? raw.action : 'auto',
      note: text(raw.note, 200) || null,
    };
    byTask.set(taskId, answer);
  }
  return [...byTask.values()].slice(0, 40);
}

function goalForTask(task, goals) {
  if (!task || !Array.isArray(goals)) return null;
  const haystack = normalizeText(
    `${task.display_title || task.content || ''} ${task.project_name || ''} ${
      Array.isArray(task.labels) ? task.labels.join(' ') : ''
    }`
  );
  let best = null;
  for (const goal of goals) {
    const keywords = Array.isArray(goal.keywords) ? goal.keywords : [];
    let score = 0;
    for (const keyword of keywords) {
      const needle = normalizeText(keyword);
      if (needle && haystack.includes(needle)) score += needle.length >= 5 ? 3 : 2;
    }
    if (score > 0 && (!best || score > best.score)) best = { goal, score };
  }
  return best ? best.goal : null;
}

function activeTasks(snapshot) {
  return Array.isArray(snapshot?.tasks)
    ? snapshot.tasks.filter((task) => task && !task.project_archived)
    : [];
}

function taskTitle(task) {
  return String(task?.display_title || task?.content || '').trim();
}

function targetFromTask(task) {
  return {
    kind: 'task',
    id: task.id,
    name: taskTitle(task),
    project_id: task.project_id || null,
    project_name: task.project_name || null,
    section_id: task.section_id || null,
  };
}

function makeId(parts) {
  return `review:${crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 14)}`;
}

/** Tâches terminées un jour donné (fuseau de l'utilisateur). */
function completedOn(snapshot, date, timezone = 'Europe/Paris') {
  const recent = Array.isArray(snapshot?.completed?.recent) ? snapshot.completed.recent : [];
  const seen = new Set();
  const items = [];
  for (const item of recent) {
    if (!item || !item.completed_at) continue;
    let day = null;
    try {
      day = todayInTimeZone(timezone, new Date(item.completed_at));
    } catch {
      day = null;
    }
    if (day !== date) continue;
    const id = item.id ? String(item.id) : null;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    const title = String(item.title || '').trim();
    items.push({
      id,
      title: title.slice(0, 160),
      key: taskKey(title),
      project_id: item.project_id || null,
    });
    if (items.length >= 100) break;
  }
  return items;
}

function emptyState() {
  return {
    version: 1,
    updated_at: null,
    reviews: {},
    tasks: {},
    goals: {},
    days: {},
  };
}

function clone(value) {
  return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function pushHistory(list, entry, max = 60) {
  list.push(entry);
  if (list.length > max) list.splice(0, list.length - max);
}

function resolveGoalState(state, goal, task, quantity) {
  if (!goal || !goal.id) return null;
  const existing = state.goals[goal.id];
  const pace = goal.pace && typeof goal.pace === 'object' ? goal.pace : null;
  const base =
    Number(existing?.base) ||
    Number(pace?.base) ||
    Number(quantity?.value) ||
    Number(pace?.value) ||
    null;
  const current = Number(existing?.current) || base;
  if (!existing) {
    state.goals[goal.id] = {
      id: goal.id,
      title: String(goal.title || goal.id).slice(0, 160),
      unit: existing?.unit || quantity?.unit || pace?.unit || null,
      base,
      current,
      success_streak: 0,
      fail_streak: 0,
      paused_until: null,
      history: [],
      updated_at: null,
    };
  } else {
    if (base && existing.base !== base) existing.base = Math.max(Number(existing.base) || 0, base);
    if (!existing.unit) existing.unit = quantity?.unit || pace?.unit || null;
    if (!Number(existing.current) && base) existing.current = base;
    if (!existing.title && goal.title) existing.title = String(goal.title).slice(0, 160);
  }
  const entry = state.goals[goal.id];
  if (task && taskKey(taskTitle(task))) {
    entry.task_key = taskKey(taskTitle(task));
  }
  return entry;
}

function resolveTaskState(state, task, goal, quantity) {
  const title = taskTitle(task);
  const key = taskKey(title);
  if (!state.tasks[key]) {
    state.tasks[key] = {
      task_key: key,
      task_id: task.id || null,
      title: title.slice(0, 160),
      goal_id: goal?.id || null,
      unit: quantity?.unit || null,
      base: quantity?.value || null,
      current: quantity?.value || null,
      success_streak: 0,
      fail_streak: 0,
      last_result: null,
      last_review_date: null,
      last_target_date: null,
      last_success_date: null,
      recurring: Boolean(task.due_is_recurring),
      history: [],
      updated_at: null,
    };
  }
  const entry = state.tasks[key];
  entry.task_id = task.id || entry.task_id;
  entry.title = title.slice(0, 160) || entry.title;
  entry.recurring = Boolean(task.due_is_recurring) || Boolean(entry.recurring);
  if (goal?.id) entry.goal_id = goal.id;
  if (quantity) {
    entry.unit = entry.unit || quantity.unit;
    entry.base = Math.max(Number(entry.base) || 0, quantity.value) || quantity.value;
    if (!Number(entry.current)) entry.current = quantity.value;
  }
  return entry;
}

/** Reconstruit l'état à partir de l'instantané pour la revue de la veille. */
function buildReview({ snapshot, date, state, goals = [] }) {
  const today = isValidIsoDate(date) ? date : snapshot?.meta?.today;
  const yesterday = addDaysIso(today, -1);
  const workState = state || emptyState();
  const tasks = activeTasks(snapshot);
  const unfinished = tasks
    .filter((task) => task.due_date === yesterday)
    .slice(0, 30)
    .map((task) => {
      const title = taskTitle(task);
      const key = taskKey(title);
      const goal = goalForTask(task, goals);
      const quantity = parseQuantity(title);
      const goalState = goal ? workState.goals?.[goal.id] : null;
      const taskState = workState.tasks?.[key] || null;
      return {
        task_id: task.id,
        title,
        project_name: task.project_name || null,
        priority: task.priority_label || null,
        size: null,
        goal_id: goal?.id || taskState?.goal_id || null,
        goal_title: goal?.title || goalState?.title || null,
        quantity: quantity
          ? { value: quantity.value, unit: quantity.unit, label: `${formatNumber(quantity.value)} ${unitLabel(quantity.unit, quantity.value)}` }
          : null,
        base: goalState?.base || taskState?.base || quantity?.value || null,
        current: goalState?.current || taskState?.current || quantity?.value || null,
        unit: goalState?.unit || taskState?.unit || quantity?.unit || null,
        last_reason: (taskState?.history || []).slice(-1)[0]?.reason || null,
        last_outcome: taskState?.last_result || null,
      };
    });

  const completed = completedOn(snapshot, yesterday, snapshot?.meta?.timezone);
  const review = workState.reviews?.[yesterday] || null;
  const answeredIds = new Set(
    (Array.isArray(review?.answers) ? review.answers : []).map((answer) => String(answer.taskId))
  );
  const pending = unfinished.filter((task) => !answeredIds.has(String(task.task_id)));

  return {
    date: today,
    yesterday,
    unfinished,
    pending_count: pending.length,
    completed_count: completed.length,
    completed: completed.slice(0, 20),
    reviewed: Boolean(review),
    answers: Array.isArray(review?.answers) ? review.answers : [],
    last_adjustments: Array.isArray(review?.proposals) ? review.proposals : [],
    review_summary: review?.summary || null,
    reasons: REASONS,
    actions: ACTIONS,
    hints: workState.days?.[today]?.hints || [],
    cap: workState.days?.[today]?.cap || null,
    goals: Object.values(workState.goals || {})
      .filter((goal) => goal && goal.id)
      .map((goal) => ({
        id: goal.id,
        title: goal.title,
        unit: goal.unit,
        base: goal.base,
        current: goal.current,
        direction: Number(goal.current) < Number(goal.base) ? 'down' : Number(goal.current) > Number(goal.base) ? 'up' : 'flat',
        paused_until: goal.paused_until || null,
      })),
  };
}

function quantityForTask(task, goalState, parsed, taskState = null) {
  const unit = goalState?.unit || taskState?.unit || parsed?.unit || null;
  const base = Number(goalState?.base) || Number(taskState?.base) || Number(parsed?.value) || null;
  const current =
    Number(goalState?.current) || Number(taskState?.current) || Number(parsed?.value) || base;
  if (!unit || !current) return null;
  return { value: current, base, unit };
}

function splitSubtasks(title, quantity) {
  if (!quantity) {
    return [`2 minutes : démarrer « ${title.slice(0, 60)} »`, 'Continuer et finir la tâche'];
  }
  const total = Number(quantity.value);
  if (!Number.isFinite(total) || total <= 1) {
    return [`2 minutes : démarrer « ${title.slice(0, 60)} »`, 'Continuer et finir la tâche'];
  }
  const first = Math.max(1, Math.round(total / 2));
  const second = Math.max(1, total - first);
  return [
    replaceQuantity(title, first),
    replaceQuantity(title, second),
  ].filter((item, index, list) => item && list.indexOf(item) === index);
}

function buildHint(answer, task, action, nextValue, quantity, goal) {
  const label = taskTitle(task);
  switch (answer.reason) {
    case 'too_big':
      return nextValue
        ? `${label} était trop grosse : aujourd’hui, viser ${formatNumber(nextValue)} ${unitLabel(quantity?.unit, nextValue)} maximum.`
        : `${label} était trop grosse : aujourd’hui, proposer une version courte ou un découpage.`;
    case 'no_motivation':
      return nextValue
        ? `${label} manquait de motivation : commencer par ${formatNumber(nextValue)} ${unitLabel(quantity?.unit, nextValue)} (micro-démarrage), puis augmenter si ça va.`
        : `${label} manquait de motivation : commencer par 2 minutes seulement.`;
    case 'no_time':
      return `Hier, le temps a manqué : aujourd’hui, privilégier des tâches courtes et ne pas surcharger.`;
    case 'too_many':
      return `Hier, il y avait trop de choses : aujourd’hui, limiter le plan à 3 tâches maximum et reporter le reste.`;
    case 'forgot':
      return `${label} a été oubliée : la remettre en évidence aujourd’hui, avec un rappel.`;
    case 'unclear':
      return `${label} n’était pas claire : commencer par une version préparée, avec une première étape explicite.`;
    case 'external':
      return `Un imprévu a empêché ${label} : la replanifier sans culpabiliser.`;
    case 'not_priority':
      return `${goal?.title || label} passe en pause quelques jours : ne pas le proposer comme priorité.`;
    default:
      return null;
  }
}

/**
 * Applique les réponses du bilan.
 * @returns {{answers:object[], proposals:object[], adjustments:object[], hints:string[],
 *   cap:number|null, goal_updates:object[], summary:string, reviewed_date:string}}
 */
function applyReview({ snapshot, date, state, goals = [], answers = [] }) {
  const today = isValidIsoDate(date) ? date : snapshot?.meta?.today;
  const yesterday = addDaysIso(today, -1);
  const workState = state || emptyState();
  workState.reviews = workState.reviews || {};
  workState.tasks = workState.tasks || {};
  workState.goals = workState.goals || {};
  workState.days = workState.days || {};

  const byId = new Map(activeTasks(snapshot).map((task) => [String(task.id), task]));
  const allTasks = activeTasks(snapshot);
  const normalized = normalizeAnswers(answers);
  const proposals = [];
  const adjustments = [];
  const hints = [];
  const goalUpdates = new Map();
  const graded = [];
  let cap = null;

  for (const answer of normalized) {
    const task = byId.get(answer.taskId);
    if (!task) continue;

    const title = taskTitle(task);
    const key = taskKey(title);
    const parsed = parseQuantity(title);
    const goal = goalForTask(task, goals);
    const taskState = resolveTaskState(workState, task, goal, parsed);
    const goalState = resolveGoalState(workState, goal, task, parsed);
    const quantity = quantityForTask(task, goalState, parsed, taskState);
    const action = decideAction(answer, quantity);
    const previous = Number(goalState?.current) || Number(quantity?.value) || null;
    // Un imprévu ou une journée surchargée ne remet pas en cause le rythme de
    // l'objectif : seules les raisons liées à la tâche comptent comme échec.
    const affectsGoal = ['too_big', 'no_motivation', 'no_time', 'unclear'].includes(
      answer.reason
    );
    let nextValue = previous;

    if (quantity && (action === 'reduce' || action === 'micro')) {
      nextValue = lowerQuantity(quantity, {
        micro: action === 'micro',
        ratio: answer.reason === 'no_motivation' ? 0.5 : 0.75,
        failStreak: affectsGoal
          ? Number(goalState?.fail_streak) || Number(taskState?.fail_streak) || 0
          : 0,
      });
    }

    const targetDate =
      action === 'move_tomorrow'
        ? addDaysIso(today, 1)
        : action === 'skip'
          ? null
          : today;

    // Mémorise l'échec et la cible pour détecter une réussite demain.
    taskState.last_result = 'failed';
    taskState.last_review_date = yesterday;
    taskState.last_target_date = targetDate || yesterday;
    taskState.fail_streak = (Number(taskState.fail_streak) || 0) + 1;
    taskState.success_streak = 0;
    taskState.updated_at = new Date().toISOString();
    pushHistory(taskState.history, {
      date: yesterday,
      reason: answer.reason,
      action,
      from: previous,
      to: nextValue,
      note: answer.note,
    });
    if (nextValue !== null && nextValue !== previous) {
      taskState.current = nextValue;
      taskState.unit = taskState.unit || quantity?.unit || null;
      taskState.base = Math.max(Number(taskState.base) || 0, Number(quantity?.base) || 0) || null;
    }

    if (goalState) {
      const previousGoal = Number(goalState.current) || nextValue;
      if (nextValue !== null && nextValue !== undefined) goalState.current = nextValue;
      if (affectsGoal) {
        goalState.fail_streak = (Number(goalState.fail_streak) || 0) + 1;
        goalState.success_streak = 0;
      }
      if (action === 'not_priority') goalState.paused_until = addDaysIso(today, 7);
      goalState.updated_at = new Date().toISOString();
      pushHistory(goalState.history, {
        date: yesterday,
        reason: answer.reason,
        action,
        from: previousGoal,
        to: goalState.current,
        note: answer.note,
      });
      if (Number(goalState.current) !== Number(previousGoal)) {
        goalUpdates.set(goal.id, {
          id: goal.id,
          title: goal.title,
          unit: goalState.unit,
          base: goalState.base,
          current: goalState.current,
          previous: previousGoal,
          direction: goalState.current < previousGoal ? 'down' : 'up',
          pace: {
            value: goalState.current,
            unit: goalState.unit,
            base: goalState.base,
            updated_at: new Date().toISOString(),
            reason: `Bilan du ${yesterday} : ${reasonLabel(answer.reason).toLowerCase()}`,
          },
        });
      }
      if (action === 'not_priority') {
        goalUpdates.set(goal.id, {
          id: goal.id,
          title: goal.title,
          unit: goalState.unit,
          base: goalState.base,
          current: goalState.current,
          previous: previousGoal,
          direction: 'paused',
          paused_until: goalState.paused_until,
          pace: {
            value: goalState.current,
            unit: goalState.unit,
            base: goalState.base,
            updated_at: new Date().toISOString(),
            reason: `Objectif mis en pause après le bilan du ${yesterday}`,
            paused_until: goalState.paused_until,
          },
        });
      }
    }

    const targetTask =
      targetDate === today
        ? allTasks.find(
            (candidate) =>
              candidate.id !== task.id &&
              candidate.due_date === today &&
              taskKey(taskTitle(candidate)) === key
          ) || task
        : task;
    const moved = targetDate && targetDate !== (targetTask.due_date || null);

    // 1) Baisser la quantité : renomme la tâche (ou son occurrence du jour).
    if (quantity && nextValue !== null && nextValue !== previous) {
      const newTitle = replaceQuantity(taskTitle(targetTask), nextValue);
      if (newTitle && newTitle !== taskTitle(targetTask)) {
        const proposal = {
          id: makeId(['rename', task.id, newTitle]),
          source: 'review',
          type: 'rename_task',
          type_label: 'Baisser',
          tone: 'warn',
          title: 'Réduire la quantité',
          rationale: `${reasonLabel(answer.reason)} hier : ${formatNumber(previous)} → ${formatNumber(
            nextValue
          )} ${unitLabel(quantity.unit, nextValue)}. On essaie cette dose pour retrouver l’élan.`,
          preview: `« ${taskTitle(targetTask)} » → « ${newTitle} »`,
          target: targetFromTask(targetTask),
          action: { content: newTitle },
          editable: [],
          adjustment: {
            kind: 'reduce_quantity',
            from: previous,
            to: nextValue,
            unit: quantity.unit,
            goal_id: goal?.id || null,
          },
        };
        proposals.push(proposal);
        adjustments.push(proposal);
      }
    }

    // 2) Découper en petites étapes.
    if (action === 'split' || (!quantity && action === 'reduce')) {
      const subtasks = splitSubtasks(taskTitle(targetTask), quantity);
      if (subtasks.length >= 2) {
        const proposal = {
          id: makeId(['split', task.id, subtasks.join('|')]),
          source: 'review',
          type: 'split_task',
          type_label: 'Découper',
          tone: 'warn',
          title: 'Découper en petites étapes',
          rationale: `${reasonLabel(answer.reason)} hier : une seule petite étape suffit pour redémarrer.`,
          preview: `Créer ${subtasks.length} sous-tâche(s) : ${subtasks.join(' · ')}`,
          target: targetFromTask(targetTask),
          action: { subtasks, update_description: false },
          subtasks,
          editable: [],
          adjustment: { kind: 'split', goal_id: goal?.id || null },
        };
        proposals.push(proposal);
        adjustments.push(proposal);
      }
    }

    // 3) Reformuler si la personne a écrit un titre plus clair.
    if (answer.reason === 'unclear' && answer.note && answer.note.length >= 3) {
      const proposal = {
        id: makeId(['rename-clarity', task.id, answer.note]),
        source: 'review',
        type: 'rename_task',
        type_label: 'Clarifier',
        tone: 'ok',
        title: 'Rendre la tâche plus claire',
        rationale: 'La tâche n’était pas claire hier : le nouveau titre dit par quoi commencer.',
        preview: `« ${taskTitle(targetTask)} » → « ${answer.note} »`,
        target: targetFromTask(targetTask),
        action: { content: answer.note },
        editable: [],
        adjustment: { kind: 'clarify', goal_id: goal?.id || null },
      };
      proposals.push(proposal);
      adjustments.push(proposal);
    }

    // 4) Reporter la tâche (sans changer l'objectif).
    if (moved) {
      const proposal = {
        id: makeId(['move', task.id, targetDate]),
        source: 'review',
        type: 'set_due_date',
        type_label: 'Reporter',
        tone: 'ok',
        title: targetDate === today ? 'Reporter à aujourd’hui' : 'Reporter à demain',
        rationale:
          action === 'move_tomorrow'
            ? `${reasonLabel(answer.reason)} : on décale d’un jour sans changer l’objectif.`
            : `${reasonLabel(answer.reason)} : la tâche revient aujourd’hui, sans modifier l’objectif.`,
        preview: `Échéance → ${targetDate}`,
        target: targetFromTask(targetTask),
        action: { due_date: targetDate },
        editable: ['due_date'],
        adjustment: { kind: 'move', due_date: targetDate, goal_id: goal?.id || null },
      };
      proposals.push(proposal);
      adjustments.push(proposal);
    }

    const hint = buildHint(answer, task, action, nextValue, quantity, goal);
    if (hint) hints.push(hint);

    if (answer.reason === 'too_many') cap = cap === null ? 3 : Math.min(cap, 3);
    if (answer.reason === 'no_time') cap = cap === null ? 4 : Math.min(cap, 4);

    graded.push({
      task_id: task.id,
      title,
      reason: answer.reason,
      action,
      from: previous,
      to: nextValue,
      goal_id: goal?.id || null,
      note: answer.note,
    });
  }

  const uniqueHints = [...new Set(hints.filter(Boolean))].slice(0, 12);
  const previousDay = workState.days[today] || {};
  workState.days[today] = {
    ...previousDay,
    hints: [...new Set([...(previousDay.hints || []), ...uniqueHints])].slice(0, 12),
    cap: cap === null ? previousDay.cap || null : cap,
    reviewed_at: new Date().toISOString(),
  };

  const goalUpdateList = [...goalUpdates.values()];
  const summaryParts = [];
  if (graded.length > 0) summaryParts.push(`${graded.length} tâche(s) analysée(s)`);
  if (goalUpdateList.length > 0) summaryParts.push(`${goalUpdateList.length} objectif(s) ajusté(s)`);
  if (proposals.length > 0) summaryParts.push(`${proposals.length} action(s) à valider`);
  const summary = summaryParts.length > 0 ? `${summaryParts.join(' · ')}.` : 'Rien à adapter.';

  workState.reviews[yesterday] = {
    reviewed_at: new Date().toISOString(),
    submitted_on: today,
    answers: normalized,
    graded,
    proposals,
    summary,
  };
  workState.updated_at = new Date().toISOString();

  return {
    date: today,
    yesterday,
    reviewed_date: yesterday,
    answers: normalized,
    graded,
    proposals,
    adjustments,
    hints: uniqueHints,
    cap,
    goal_updates: goalUpdateList,
    summary,
  };
}

/**
 * Détecte les réussites de la veille sur des tâches qui avaient été adaptées.
 * Deux réussites consécutives font remonter la quantité d'un cran.
 */
function recordSuccesses({ snapshot, state, date, timezone }) {
  const today = isValidIsoDate(date) ? date : snapshot?.meta?.today;
  const yesterday = addDaysIso(today, -1);
  const workState = state || emptyState();
  workState.tasks = workState.tasks || {};
  workState.goals = workState.goals || {};
  const completed = completedOn(snapshot, yesterday, timezone || snapshot?.meta?.timezone);
  const completedKeys = new Set(completed.map((item) => item.key));
  const items = [];

  for (const [key, taskState] of Object.entries(workState.tasks)) {
    if (!taskState || taskState.last_target_date !== yesterday) continue;
    if (taskState.last_success_date === yesterday) continue;
    if (!completedKeys.has(key)) continue;

    taskState.last_result = 'success';
    taskState.last_success_date = yesterday;
    taskState.last_target_date = taskState.recurring ? addDaysIso(yesterday, 1) : null;
    taskState.success_streak = (Number(taskState.success_streak) || 0) + 1;
    taskState.fail_streak = 0;
    taskState.updated_at = new Date().toISOString();
    pushHistory(taskState.history, {
      date: yesterday,
      outcome: 'success',
      from: taskState.current,
      to: taskState.current,
    });

    const goalState = taskState.goal_id ? workState.goals[taskState.goal_id] : null;
    let raised = null;
    if (goalState) {
      goalState.success_streak = (Number(goalState.success_streak) || 0) + 1;
      goalState.fail_streak = 0;
      if (
        goalState.success_streak >= 2 &&
        Number(goalState.current) < Number(goalState.base)
      ) {
        const previous = goalState.current;
        goalState.current = raiseQuantity(goalState.current, goalState.base, goalState.unit);
        goalState.success_streak = 0;
        raised = { from: previous, to: goalState.current };
        items.push({
          kind: 'raise',
          goal_id: goalState.id,
          title: goalState.title,
          unit: goalState.unit,
          from: previous,
          to: goalState.current,
        });
      }
      goalState.updated_at = new Date().toISOString();
      pushHistory(goalState.history, {
        date: yesterday,
        outcome: 'success',
        from: raised?.from ?? goalState.current,
        to: goalState.current,
      });
    }
    items.push({
      kind: 'success',
      task_key: key,
      title: taskState.title,
      goal_id: taskState.goal_id || null,
    });
  }

  if (items.length > 0) workState.updated_at = new Date().toISOString();
  return { changed: items.length > 0, items, completed_count: completed.length };
}

/** Réinitialise un objectif à son rythme de départ. */
function resetGoalPace(state, goalId, date = null) {
  const workState = state || emptyState();
  const goal = workState.goals?.[goalId];
  if (!goal) return null;
  const previous = goal.current;
  goal.current = goal.base;
  goal.success_streak = 0;
  goal.fail_streak = 0;
  goal.paused_until = null;
  goal.updated_at = new Date().toISOString();
  pushHistory(goal.history, {
    date: date || (workState.updated_at ? String(workState.updated_at).slice(0, 10) : null),
    action: 'reset',
    from: previous,
    to: goal.base,
  });
  return {
    id: goal.id,
    title: goal.title,
    unit: goal.unit,
    base: goal.base,
    current: goal.current,
    previous,
  };
}

/** Retire une proposition appliquée de la mémoire des bilans. */
function removeReviewProposal(state, proposalId) {
  const workState = state || emptyState();
  let changed = false;
  for (const entry of Object.values(workState.reviews || {})) {
    if (!entry || !Array.isArray(entry.proposals)) continue;
    const before = entry.proposals.length;
    entry.proposals = entry.proposals.filter(
      (proposal) => String(proposal?.id || '') !== String(proposalId)
    );
    if (entry.proposals.length !== before) changed = true;
  }
  return changed;
}

/** Contexte injecté dans la planification du jour (hints + plafond de tâches). */
function reviewContextFor(state, date) {
  const day = state?.days?.[date];
  if (!day) return { hints: [], cap: null };
  return {
    hints: Array.isArray(day.hints) ? day.hints.slice(0, 12) : [],
    cap: Number.isFinite(Number(day.cap)) && Number(day.cap) > 0 ? Number(day.cap) : null,
  };
}

module.exports = {
  REASONS,
  ACTIONS,
  REASON_LABELS,
  ACTION_LABELS,
  UNITS,
  normalizeText,
  taskKey,
  parseQuantity,
  replaceQuantity,
  formatNumber,
  lowerQuantity,
  raiseQuantity,
  defaultAction,
  decideAction,
  normalizeAnswers,
  goalForTask,
  completedOn,
  emptyState,
  clone,
  buildReview,
  applyReview,
  recordSuccesses,
  resetGoalPace,
  removeReviewProposal,
  reviewContextFor,
  unitLabel,
};
