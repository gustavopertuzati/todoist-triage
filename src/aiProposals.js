'use strict';

/**
 * Planification par jour assistée par l'IA (itération 6).
 *
 * Le principe a changé : au lieu d'un lot global de propositions, on raisonne
 * JOUR PAR JOUR. Pour une date donnée, l'app :
 *   1. mesure ce qui est déjà prévu ce jour-là (taille estimée de chaque tâche) ;
 *   2. en déduit la place restante selon la règle « 1-3-5 » (1 gros, 3 moyens,
 *      5 petits) ;
 *   3. demande à l'IA quelles tâches non planifiées conviennent le mieux à ce
 *      jour, sans dépasser la place restante.
 *
 * L'IA ne peut produire que des échéances (`set_due_date`) et, éventuellement,
 * des scissions (`split_task`). Rien n'est écrit ici.
 */

const crypto = require('node:crypto');
const { config } = require('./config');
const { chatJson, AiError } = require('./ai');
const { weekdayName, estimateTaskSize, SIZE_LABELS } = require('./capacity');
const { targetFromTask } = require('./proposals');

const SYSTEM_PROMPT = [
  'Tu es un assistant d’organisation personnelle, spécialisé dans la planification d’une',
  'journée précise d’un Todoist surchargé. Tu respectes strictement la place disponible.',
  'Réfléchis brièvement, sans digression.',
  'Tu réponds UNIQUEMENT par un objet JSON valide, sans texte autour, sans balises Markdown.',
].join(' ');

function hashId(parts) {
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12);
}

function signatureOf(value) {
  return crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex');
}

// Propositions déjà présentées mais pas encore tranchées : elles restent
// résolvables pour la validation, même après une écriture.
const STORE_TTL_MS = 2 * 60 * 60 * 1000;
const STORE_MAX = 400;
let store = new Map(); // id -> { proposal, at }
let dayCache = new Map(); // date -> { signature, items, summary, generatedAt, usage, model }

function rememberItems(items) {
  const now = Date.now();
  for (const item of items) store.set(item.id, { proposal: item, at: now });
  for (const [id, record] of store) {
    if (now - record.at > STORE_TTL_MS) store.delete(id);
  }
  if (store.size > STORE_MAX) {
    const oldest = [...store.entries()].sort((a, b) => a[1].at - b[1].at);
    for (let i = 0; i < oldest.length - STORE_MAX; i += 1) store.delete(oldest[i][0]);
  }
}

function findAiProposal(id) {
  const record = store.get(id);
  if (!record) return null;
  if (Date.now() - record.at > STORE_TTL_MS) {
    store.delete(id);
    return null;
  }
  return record.proposal;
}

function removeAiProposal(id) {
  store.delete(id);
}

function clearAiCache() {
  store = new Map();
  dayCache = new Map();
}

/** Informations brutes d'une journée (sans IA). */
function dayInfo(snapshot, date) {
  const rule = (snapshot.capacity && snapshot.capacity.rule) || config.capacityRule;
  const day = (snapshot.capacity && snapshot.capacity.days || []).find((d) => d.date === date);

  const planned = snapshot.tasks
    .filter((task) => !task.project_archived && task.due_date === date)
    .map((task) => ({
      id: task.id,
      title: task.display_title || task.content,
      size: estimateTaskSize(task),
      size_label: SIZE_LABELS[estimateTaskSize(task)],
      priority_label: task.priority_label,
      project_name: task.project_name,
      is_overdue: task.is_overdue,
      is_done: false,
    }));

  const load = day ? { ...day.load } : { L: 0, M: 0, S: 0 };
  const remaining = day ? { ...day.remaining } : { ...rule };

  return {
    date,
    weekday: weekdayName(date),
    rule,
    load,
    remaining,
    total: planned.length,
    planned,
  };
}

/** Condensé envoyé au modèle pour une journée. */
function buildDayDigest(snapshot, date) {
  const info = dayInfo(snapshot, date);
  const active = snapshot.tasks.filter((task) => !task.project_archived);

  const overdue = active
    .filter((task) => task.is_overdue)
    .sort((a, b) => (b.days_overdue || 0) - (a.days_overdue || 0))
    .slice(0, 12);

  const undated = active
    .filter((task) => !task.due_date)
    .sort((a, b) => (b.priority || 0) - (a.priority || 0) || (b.age_days || 0) - (a.age_days || 0))
    .slice(0, 30);

  const seen = new Set();
  const tasks = [];
  for (const task of [...overdue, ...undated]) {
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    tasks.push({
      id: task.id,
      title: String(task.display_title || task.content || '').slice(0, 120),
      project: task.project_name || null,
      priority: task.priority_label,
      due: task.due_date || null,
      days_overdue: task.days_overdue || null,
      age_days: task.age_days,
      labels: (task.labels || []).slice(0, 3),
      has_note: Boolean(task.description && task.description.trim()),
      size_hint: estimateTaskSize(task),
    });
  }

  const remainingTotal = info.remaining.L + info.remaining.M + info.remaining.S;

  const projects = snapshot.projects
    .filter((project) => !project.is_archived)
    .map((project) => ({ id: project.id, name: project.name }));

  return {
    today: snapshot.meta.today,
    timezone: snapshot.meta.timezone,
    date,
    weekday: info.weekday,
    capacity_rule: info.rule,
    remaining: info.remaining,
    already_planned: info.planned.slice(0, 12).map((task) => ({
      title: task.title.slice(0, 40),
      size: task.size,
    })),
    max_proposals: Math.min(config.aiMaxProposals, Math.max(0, remainingTotal)),
    projects,
    tasks,
  };
}

function buildUserPrompt(digest) {
  return [
    `Remplis la journée du ${digest.date} (${digest.weekday}).`,
    '',
    'Place disponible ce jour (règle 1-3-5) :',
    `- gros (L) : ${digest.remaining.L}`,
    `- moyens (M) : ${digest.remaining.M}`,
    `- petits (S) : ${digest.remaining.S}`,
    'Tu ne dois PAS dépasser ces quantités. Si une taille est à 0, ne propose rien de cette taille.',
    '',
    'Règles :',
    '- Choisis les tâches les plus adaptées à ce jour parmi celles listées (retards d’abord,',
    '  puis priorités hautes et tâches anciennes), sans dépasser la place disponible.',
    '- Regroupe si possible des tâches d’un même thème ce jour-là.',
    '- Donne pour chaque proposition une taille "L", "M" ou "S" (indice : "size_hint").',
    '- due_date doit être EXACTEMENT ' + digest.date + '.',
    '- reason : une phrase courte, concrète et en français.',
    '- group : un thème court et optionnel.',
    `- Propose au maximum ${digest.max_proposals} tâches, uniquement parmi celles listées.`,
    '',
    'En plus, pour une tâche listée qui te semble un « fourre-tout » trop gros pour une',
    'seule journée, tu peux proposer de la scinder (2 à 10 sous-tâches) dans "splits".',
    'N’utilise pas "splits" pour une tâche déjà présente dans "proposals".',
    '',
    'Réponds EXACTEMENT par ce JSON :',
    '{"summary":"phrase décrivant tes choix pour cette journée",',
    ' "proposals":[{"task_id":"...","due_date":"' + digest.date + '","size":"L|M|S","reason":"...","group":"..."}],',
    ' "splits":[{"task_id":"...","reason":"...","subtasks":["...","..."]}]}',
    '',
    'Données :',
    JSON.stringify(digest),
  ].join('\n');
}

/**
 * Valide la réponse du modèle pour la journée et la borne à la place restante.
 * @returns {{items: object[], dropped: number}}
 */
function validateDayResponse(parsed, snapshot, date, digest) {
  const allowed = new Map(digest.tasks.map((task) => [task.id, task]));
  const tasksById = new Map(snapshot.tasks.map((task) => [task.id, task]));
  const remaining = { ...digest.remaining };
  const seen = new Set();
  const items = [];

  const rawProposals = Array.isArray(parsed?.proposals) ? parsed.proposals : [];

  for (const raw of rawProposals) {
    if (items.filter((item) => item.type === 'set_due_date').length >= digest.max_proposals) break;

    const taskId = String(raw?.task_id || '');
    if (!allowed.has(taskId) || seen.has(taskId)) continue;

    const due = String(raw?.due_date || '').trim();
    if (due !== date) continue;

    const task = tasksById.get(taskId);
    if (!task || task.project_archived) continue;
    if (task.due_date === date) continue;

    const size = ['L', 'M', 'S'].includes(raw?.size)
      ? raw.size
      : estimateTaskSize(task, task.subtask_count || 0);
    if (remaining[size] <= 0) continue;
    remaining[size] -= 1;

    const reason = String(raw?.reason || '').trim().slice(0, 300);
    const group = raw?.group ? String(raw.group).trim().slice(0, 40) : null;

    seen.add(taskId);
    items.push({
      id: `ai:set_due_date:${taskId}:${hashId([date, reason, group || '', size])}`,
      type: 'set_due_date',
      type_label: 'Dater',
      source: 'ai',
      tone: 'warn',
      score: 55,
      size,
      size_label: SIZE_LABELS[size],
      title: `Placer le ${date}`,
      rationale: reason || 'Tâche adaptée à cette journée.',
      ai_group: group,
      target: targetFromTask(task),
      action: { due_date: date },
      editable: ['due_date'],
      preview: `Échéance → ${date}`,
      format: 'date',
    });
  }

  // Scissions : utiles mais non rattachées à une date.
  const splits = [];
  const rawSplits = config.aiAllowSplits && Array.isArray(parsed?.splits) ? parsed.splits : [];
  for (const raw of rawSplits) {
    if (splits.length >= 3) break;
    const taskId = String(raw?.task_id || '');
    if (!allowed.has(taskId) || seen.has(taskId)) continue;
    const task = tasksById.get(taskId);
    if (!task || task.project_archived) continue;

    const titles = (Array.isArray(raw?.subtasks) ? raw.subtasks : [])
      .map((sub) => (typeof sub === 'string' ? sub : sub?.title))
      .map((title) => String(title || '').trim().slice(0, 200))
      .filter(Boolean)
      .slice(0, 10);
    if (titles.length < 2) continue;

    seen.add(taskId);
    splits.push({
      id: `ai:split_task:${taskId}:${hashId([taskId, titles.join('|')])}`,
      type: 'split_task',
      type_label: 'Scinder',
      source: 'ai',
      tone: 'ok',
      score: 40,
      size: null,
      size_label: null,
      title: 'Scinder en sous-tâches',
      rationale: String(raw?.reason || '').trim().slice(0, 300) || 'Tâche trop grosse.',
      ai_group: null,
      target: targetFromTask(task),
      action: { subtasks: titles, update_description: false },
      editable: [],
      preview: `Créer ${titles.length} sous-tâche(s) : ${titles.slice(0, 4).join(' · ')}${
        titles.length > 4 ? '…' : ''
      }`,
      format: 'split',
      subtasks: titles,
    });
  }

  return { items, splits, dropped: rawProposals.length - items.length };
}

/**
 * Génère (ou récupère depuis le cache) les propositions pour une journée.
 */
async function generateDayProposals(snapshot, date, { force = false } = {}) {
  if (!config.aiEnabled) {
    throw new AiError('AI_DISABLED', 'L’IA n’est pas configurée (OPENROUTER_API_KEY manquant).');
  }

  const digest = buildDayDigest(snapshot, date);
  const signature = signatureOf(digest);
  const cached = dayCache.get(date);

  const fresh =
    cached &&
    cached.signature === signature &&
    (config.aiCacheTtlMs === 0 || Date.now() - cached.generatedAt < config.aiCacheTtlMs);

  if (fresh && !force) {
    return { ...cached, cached: true };
  }

  const remainingTotal = digest.remaining.L + digest.remaining.M + digest.remaining.S;
  if (remainingTotal <= 0) {
    const empty = {
      signature,
      items: [],
      splits: [],
      summary: 'Cette journée est déjà complète selon la règle 1-3-5.',
      generatedAt: Date.now(),
      usage: null,
      model: null,
    };
    dayCache.set(date, empty);
    return { ...empty, cached: false };
  }

  if (digest.tasks.length === 0) {
    const empty = {
      signature,
      items: [],
      splits: [],
      summary: 'Aucune tâche non planifiée à proposer pour cette journée.',
      generatedAt: Date.now(),
      usage: null,
      model: null,
    };
    dayCache.set(date, empty);
    return { ...empty, cached: false };
  }

  const { data, usage, model } = await chatJson({
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(digest),
  });

  const { items, splits, dropped } = validateDayResponse(data, snapshot, date, digest);

  let summary = typeof data?.summary === 'string' ? data.summary.trim().slice(0, 400) : null;
  if (dropped > 0) {
    summary = `${summary ? `${summary} ` : ''}(${dropped} proposition(s) écartée(s) : place insuffisante.)`;
  }

  const entry = { signature, items, splits, summary, generatedAt: Date.now(), usage, model };
  dayCache.set(date, entry);
  rememberItems([...items, ...splits]);

  return { ...entry, cached: false };
}

/** Propositions déjà en cache pour une date (sans appel réseau). */
function peekDay(date) {
  const entry = dayCache.get(date);
  if (!entry) return null;
  return entry;
}

module.exports = {
  SYSTEM_PROMPT,
  buildDayDigest,
  buildUserPrompt,
  validateDayResponse,
  dayInfo,
  generateDayProposals,
  peekDay,
  findAiProposal,
  removeAiProposal,
  clearAiCache,
};
