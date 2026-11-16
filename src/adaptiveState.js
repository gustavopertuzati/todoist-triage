'use strict';

/**
 * Mémoire des bilans quotidiens et des rythmes adaptés (itération 48).
 *
 * L'état vit dans un fichier JSON privé (par défaut
 * `data/adaptive-state.json`, surchargeable avec `ADAPTIVE_STATE_FILE`) :
 *   - `reviews` : les réponses déjà données, par date de la veille ;
 *   - `tasks`   : la dernière quantité connue par tâche ;
 *   - `goals`   : le rythme courant de chaque objectif ;
 *   - `days`    : les consignes/plafonds du jour issus du bilan.
 *
 * Les écritures sont atomiques (fichier temporaire + renommage) et l'état est
 * borné pour ne pas grossir indéfiniment.
 */

const fs = require('node:fs');
const path = require('node:path');

const VERSION = 1;
const MAX_HISTORY = 60;
const MAX_REVIEWS = 60;
const MAX_DAYS = 60;
const MAX_TASKS = 250;
const MAX_GOALS = 80;

function defaultFile() {
  return process.env.ADAPTIVE_STATE_FILE
    ? path.resolve(process.env.ADAPTIVE_STATE_FILE)
    : path.join(__dirname, '..', 'data', 'adaptive-state.json');
}

function emptyState() {
  return { version: VERSION, updated_at: null, reviews: {}, tasks: {}, goals: {}, days: {} };
}

function objectOf(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function boundHistory(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(-MAX_HISTORY);
}

function boundByDate(entries, max) {
  const keys = Object.keys(entries || {}).sort();
  const removed = keys.slice(0, Math.max(0, keys.length - max));
  const result = { ...(entries || {}) };
  for (const key of removed) delete result[key];
  return result;
}

function boundByUpdatedAt(entries, max) {
  const list = Object.entries(entries || {});
  if (list.length <= max) return Object.fromEntries(list);
  list.sort((a, b) => String(a[1]?.updated_at || '').localeCompare(String(b[1]?.updated_at || '')));
  return Object.fromEntries(list.slice(-max));
}

function sanitizeTask(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    task_key: String(value.task_key || '').slice(0, 160),
    task_id: value.task_id ? String(value.task_id).slice(0, 80) : null,
    title: String(value.title || '').slice(0, 160),
    goal_id: value.goal_id ? String(value.goal_id).slice(0, 80) : null,
    unit: value.unit ? String(value.unit).slice(0, 24) : null,
    base: Number.isFinite(Number(value.base)) ? Number(value.base) : null,
    current: Number.isFinite(Number(value.current)) ? Number(value.current) : null,
    success_streak: Math.max(0, Number(value.success_streak) || 0),
    fail_streak: Math.max(0, Number(value.fail_streak) || 0),
    last_result: ['success', 'failed'].includes(value.last_result) ? value.last_result : null,
    last_review_date: value.last_review_date ? String(value.last_review_date).slice(0, 10) : null,
    last_target_date: value.last_target_date ? String(value.last_target_date).slice(0, 10) : null,
    last_success_date: value.last_success_date ? String(value.last_success_date).slice(0, 10) : null,
    recurring: value.recurring === true,
    history: boundHistory(value.history),
    updated_at: value.updated_at ? String(value.updated_at).slice(0, 40) : null,
  };
}

function sanitizeGoal(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    id: String(value.id || '').slice(0, 80),
    title: String(value.title || '').slice(0, 160),
    unit: value.unit ? String(value.unit).slice(0, 24) : null,
    base: Number.isFinite(Number(value.base)) ? Number(value.base) : null,
    current: Number.isFinite(Number(value.current)) ? Number(value.current) : null,
    success_streak: Math.max(0, Number(value.success_streak) || 0),
    fail_streak: Math.max(0, Number(value.fail_streak) || 0),
    paused_until: value.paused_until ? String(value.paused_until).slice(0, 10) : null,
    history: boundHistory(value.history),
    updated_at: value.updated_at ? String(value.updated_at).slice(0, 40) : null,
  };
}

function sanitizeDay(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    hints: (Array.isArray(value.hints) ? value.hints : [])
      .map((hint) => String(hint || '').slice(0, 300))
      .filter(Boolean)
      .slice(0, 12),
    cap: Number.isFinite(Number(value.cap)) && Number(value.cap) > 0 ? Number(value.cap) : null,
    reviewed_at: value.reviewed_at ? String(value.reviewed_at).slice(0, 40) : null,
  };
}

function sanitizeState(raw) {
  const source = objectOf(raw);
  const tasks = {};
  for (const [key, value] of Object.entries(objectOf(source.tasks))) {
    const task = sanitizeTask(value);
    if (task && task.task_key) tasks[task.task_key] = task;
  }
  const goals = {};
  for (const [key, value] of Object.entries(objectOf(source.goals))) {
    const goal = sanitizeGoal(value);
    if (goal && goal.id) goals[goal.id] = goal;
  }
  const days = {};
  for (const [key, value] of Object.entries(objectOf(source.days))) {
    const day = sanitizeDay(value);
    if (day) days[String(key).slice(0, 10)] = day;
  }
  const reviews = {};
  for (const [key, value] of Object.entries(objectOf(source.reviews))) {
    if (!value || typeof value !== 'object') continue;
    reviews[String(key).slice(0, 10)] = {
      reviewed_at: value.reviewed_at ? String(value.reviewed_at).slice(0, 40) : null,
      submitted_on: value.submitted_on ? String(value.submitted_on).slice(0, 10) : null,
      answers: Array.isArray(value.answers) ? value.answers.slice(0, 40) : [],
      graded: Array.isArray(value.graded) ? value.graded.slice(0, 40) : [],
      proposals: Array.isArray(value.proposals) ? value.proposals.slice(0, 40) : [],
      summary: value.summary ? String(value.summary).slice(0, 300) : null,
    };
  }
  return {
    version: VERSION,
    updated_at: source.updated_at ? String(source.updated_at).slice(0, 40) : null,
    reviews: boundByDate(reviews, MAX_REVIEWS),
    tasks: boundByUpdatedAt(tasks, MAX_TASKS),
    goals: boundByUpdatedAt(goals, MAX_GOALS),
    days: boundByDate(days, MAX_DAYS),
  };
}

/**
 * Fabrique un magasin sur un fichier donné (injectable pour les tests).
 */
function createStore({ file = defaultFile() } = {}) {
  let state = null;

  function load() {
    if (state) return state;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      state = sanitizeState(parsed);
    } catch {
      state = emptyState();
    }
    return state;
  }

  function persist() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(load(), null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  }

  function get() {
    return load();
  }

  function replace(next) {
    state = sanitizeState(next);
    persist();
    return state;
  }

  function update(fn) {
    const draft = JSON.parse(JSON.stringify(load()));
    const result = fn(draft);
    state = sanitizeState(draft);
    persist();
    return result;
  }

  return { file, get, replace, update, load };
}

const store = createStore();

module.exports = {
  VERSION,
  MAX_HISTORY,
  defaultFile,
  emptyState,
  sanitizeState,
  createStore,
  store,
};
