'use strict';

/**
 * Propositions datées par l'IA (itération 4).
 *
 * L'IA ne fait qu'une chose : choisir une échéance pertinente pour chaque tâche
 * retenue, en répartissant la charge et en respectant les priorités. Elle ne
 * peut rien créer ni supprimer : les seules actions acceptées sont des
 * échéances (`set_due_date`), validées une par une par l'utilisateur puis
 * relues via l'API.
 *
 * Le résultat est mis en cache et identifié par une empreinte des données
 * d'entrée : pas de nouvel appel si rien n'a changé, et les identifiants
 * restent stables entre l'affichage et la validation.
 */

const crypto = require('node:crypto');
const { config } = require('./config');
const { chatJson, AiError } = require('./ai');
const { addDaysIso } = require('./dates');
const { targetFromTask, normalizeDueDate } = require('./proposals');
const { estimateTaskSize, enforceCapacity, SIZE_LABELS } = require('./capacity');

const SYSTEM_PROMPT = [
  'Tu es un assistant d’organisation personnelle, spécialisé dans la replanification',
  'd’un Todoist surchargé. Tu proposes des échéances réalistes et variées.',
  'Réfléchis brièvement, sans digression.',
  'Tu réponds UNIQUEMENT par un objet JSON valide, sans texte autour, sans balises Markdown.',
].join(' ');

let cache = { signature: null, items: [], summary: null, generatedAt: 0, usage: null, model: null };

// Les propositions déjà présentées restent résolvables (pour la validation)
// même si les données changent ou si le lot est régénéré : on les garde dans un
// magasin à part, avec expiration.
const STORE_TTL_MS = 2 * 60 * 60 * 1000;
const STORE_MAX = 300;
let store = new Map(); // id -> { proposal, at }

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

function sha1(value) {
  return crypto.createHash('sha1').update(value).digest('hex');
}

function hashId(parts) {
  return sha1(parts.join('|')).slice(0, 12);
}

/**
 * Construit un condensé compact et déterministe des données à envoyer à l'IA.
 * Aucune donnée sensible n'y figure.
 */
function buildDigest(snapshot) {
  const active = snapshot.tasks.filter((task) => !task.project_archived);

  const overdue = active
    .filter((task) => task.is_overdue)
    .sort((a, b) => (b.days_overdue || 0) - (a.days_overdue || 0))
    .slice(0, 8);

  const undated = active
    .filter((task) => !task.due_date)
    .sort((a, b) => (b.priority || 0) - (a.priority || 0) || (b.age_days || 0) - (a.age_days || 0))
    .slice(0, 22);

  const seen = new Set();
  const candidates = [];
  for (const task of [...overdue, ...undated]) {
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    candidates.push({
      id: task.id,
      title: String(task.display_title || task.content || '').slice(0, 120),
      project: task.project_name || null,
      priority: task.priority_label,
      due: task.due_date || null,
      days_overdue: task.days_overdue || null,
      age_days: task.age_days,
      labels: (task.labels || []).slice(0, 3),
      has_note: Boolean(task.description && task.description.trim()),
      size_hint: estimateTaskSize(task, task.subtask_count || 0),
    });
  }

  const tasks = candidates.slice(0, 25);

  // Charge déjà posée, jour par jour : le modèle doit respecter la place restante.
  const plannedByDate = new Map();
  for (const task of active) {
    if (!task.due_date || task.due_date < snapshot.meta.today) continue;
    if (!plannedByDate.has(task.due_date)) plannedByDate.set(task.due_date, []);
    const list = plannedByDate.get(task.due_date);
    if (list.length < 3) list.push(String(task.display_title || task.content || '').slice(0, 40));
  }

  const capacity = snapshot.capacity || { rule: config.capacityRule, days: [] };
  const agenda = (capacity.days || []).map((day) => ({
    date: day.date,
    weekday: day.weekday,
    remaining: day.remaining,
    planned: plannedByDate.get(day.date) || [],
  }));

  const projects = snapshot.projects
    .filter((project) => !project.is_archived)
    .map((project) => ({
      id: project.id,
      name: project.name,
      tasks: project.stats.tasks,
      overdue: project.stats.overdue,
      no_due: project.stats.no_due,
      completed_90d: project.stats.completed_lookback,
    }));

  return {
    today: snapshot.meta.today,
    timezone: snapshot.meta.timezone,
    horizon_days: config.aiHorizonDays,
    max_proposals: config.aiMaxProposals,
    capacity_rule: capacity.rule || config.capacityRule,
    agenda,
    projects,
    tasks,
  };
}

function signatureFor(digest) {
  return sha1(JSON.stringify(digest));
}

function buildUserPrompt(digest) {
  return [
    'Voici l’état d’un compte Todoist. Choisis les tâches à planifier et donne à chacune',
    'une échéance, en respectant impérativement la charge des journées.',
    '',
    'Charge (règle « 1-3-5 ») : par jour, au plus 1 grosse tâche (L), 3 moyennes (M) et',
    '5 petites (S). Le tableau "agenda" donne pour chaque jour la place RESTANTE',
    '("remaining") : ne place une tâche un jour donné que s’il reste de la place pour sa',
    'taille. Étale la charge, ne remplis pas un jour au-delà de sa capacité.',
    '',
    'Règles :',
    '- Traite en priorité les tâches en retard (days_overdue non nul).',
    '- Donne pour chaque proposition une taille : "L", "M" ou "S" (indice fourni dans',
    '  "size_hint", ajuste-le selon l’ampleur réelle du travail).',
    '- Regroupe les tâches d’un même thème sur un jour cohérent, SI la place le permet.',
    '- Priorise : P1 plus tôt, P4 plus tard ; tiens compte de age_days.',
    '- due_date au format AAAA-MM-JJ, entre today et today + horizon_days.',
    '- Ne propose rien pour une tâche déjà à jour.',
    '- reason : une phrase courte, concrète et en français.',
    '- group : un thème court et optionnel (ex. « Maison », « Admin »).',
    `- Au maximum ${digest.max_proposals} propositions, uniquement parmi les tâches listées.`,
    '',
    'Scission : si une tâche est un « fourre-tout » trop gros, tu peux proposer de la',
    'scinder en 2 à 10 sous-tâches concrètes dans "splits". N’utilise pas "splits" pour une',
    'tâche déjà présente dans "proposals".',
    '',
    'Réponds EXACTEMENT par ce JSON :',
    '{"summary":"phrase décrivant ta stratégie",',
    ' "proposals":[{"task_id":"...","due_date":"AAAA-MM-JJ","size":"L|M|S","reason":"...","group":"..."}],',
    ' "splits":[{"task_id":"...","reason":"...","subtasks":["...","..."]}]}',
    '',
    'Données :',
    JSON.stringify(digest),
  ].join('\n');
}

/**
 * Valide la réponse de l'IA et la transforme en propositions sûres.
 * Tout ce qui n'est pas une tâche connue, une date valide dans l'horizon, ou qui
 * dépasserait la capacité d'une journée, est écarté.
 * @returns {{items: object[], dropped: number}}
 */
function validateResponse(parsed, snapshot, digest) {
  const allowed = new Map(digest.tasks.map((task) => [task.id, task]));
  const tasksById = new Map(snapshot.tasks.map((task) => [task.id, task]));
  const today = snapshot.meta.today;
  const maxDate = addDaysIso(today, config.aiHorizonDays);
  const capacity = snapshot.capacity || { days: [], rule: config.capacityRule };

  const rawProposals = Array.isArray(parsed?.proposals) ? parsed.proposals : [];
  const seen = new Set();
  const dateItems = [];

  for (const raw of rawProposals) {
    const taskId = String(raw?.task_id || '');
    if (!allowed.has(taskId) || seen.has(taskId)) continue;

    const due = normalizeDueDate(raw?.due_date);
    if (!due || due < today || due > maxDate) continue;

    const task = tasksById.get(taskId);
    if (!task || task.project_archived) continue;
    if (task.due_date === due) continue;

    const size = ['L', 'M', 'S'].includes(raw?.size)
      ? raw.size
      : estimateTaskSize(task, task.subtask_count || 0);
    const reason = String(raw?.reason || '').trim().slice(0, 300);
    const group = raw?.group ? String(raw.group).trim().slice(0, 40) : null;

    seen.add(taskId);
    dateItems.push({
      id: `ai:set_due_date:${taskId}:${hashId([due, reason, group || '', size])}`,
      type: 'set_due_date',
      type_label: 'Dater',
      source: 'ai',
      tone: 'warn',
      score: 55,
      size,
      size_label: SIZE_LABELS[size],
      title: 'Échéance proposée par l’IA',
      rationale: reason || 'Échéance proposée par l’IA.',
      ai_group: group,
      target: targetFromTask(task),
      action: { due_date: due },
      editable: ['due_date'],
      preview: `Échéance → ${due}`,
      format: 'date',
    });
  }

  // Capacité : on garde l'ordre proposé par l'IA et on refuse le surplus.
  const capped = dateItems.slice(0, config.aiMaxProposals);
  const { accepted, rejected } = enforceCapacity(capped, capacity.days || [], capacity.rule);
  const dropped = rejected.length + (dateItems.length - capped.length);

  // Scissions proposées par l'IA.
  const splitItems = [];
  const rawSplits = config.aiAllowSplits && Array.isArray(parsed?.splits) ? parsed.splits : [];

  for (const raw of rawSplits) {
    if (splitItems.length >= 5) break;
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
    const reason = String(raw?.reason || '').trim().slice(0, 300);
    splitItems.push({
      id: `ai:split_task:${taskId}:${hashId([taskId, titles.join('|')])}`,
      type: 'split_task',
      type_label: 'Scinder',
      source: 'ai',
      tone: 'ok',
      score: 40,
      size: null,
      size_label: null,
      title: 'Scinder en sous-tâches',
      rationale: reason || `Tâche trop grosse : ${titles.length} étapes identifiées.`,
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

  return { items: [...accepted, ...splitItems], dropped };
}

/** État du cache (sans générer). */
function peek(snapshot) {
  if (!snapshot) return null;
  const signature = signatureFor(buildDigest(snapshot));
  if (cache.signature === signature && cache.items.length > 0) {
    return { items: cache.items, summary: cache.summary, generatedAt: cache.generatedAt, signature };
  }
  return null;
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
  cache = { signature: null, items: [], summary: null, generatedAt: 0, usage: null, model: null };
  store = new Map();
}

/**
 * Génère (ou récupère depuis le cache) les propositions de l'IA.
 * @param {object} snapshot
 * @param {{force?: boolean}} options
 */
async function generateAiProposals(snapshot, { force = false } = {}) {
  if (!config.aiEnabled) {
    throw new AiError('AI_DISABLED', 'L’IA n’est pas configurée (OPENROUTER_API_KEY manquant).');
  }

  const digest = buildDigest(snapshot);
  const signature = signatureFor(digest);

  const fresh =
    cache.signature === signature &&
    cache.items.length > 0 &&
    (config.aiCacheTtlMs === 0 || Date.now() - cache.generatedAt < config.aiCacheTtlMs);

  if (fresh && !force) {
    return {
      items: cache.items,
      summary: cache.summary,
      usage: cache.usage,
      model: cache.model,
      cached: true,
      generatedAt: cache.generatedAt,
    };
  }

  if (digest.tasks.length === 0) {
    cache = { signature, items: [], summary: 'Aucune tâche à planifier.', generatedAt: Date.now(), usage: null, model: null };
    return { items: [], summary: 'Aucune tâche à planifier.', cached: false, generatedAt: cache.generatedAt };
  }

  const { data, usage, model } = await chatJson({
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(digest),
  });

  const { items, dropped } = validateResponse(data, snapshot, digest);
  let summary = typeof data?.summary === 'string' ? data.summary.trim().slice(0, 400) : null;
  if (dropped > 0) {
    summary = `${summary ? `${summary} ` : ''}(${dropped} proposition(s) écartée(s) pour respecter la capacité des journées.)`;
  }

  cache = { signature, items, summary, generatedAt: Date.now(), usage, model };
  rememberItems(items);

  return { items, summary, usage, model, cached: false, generatedAt: cache.generatedAt };
}

module.exports = {
  buildDigest,
  signatureFor,
  validateResponse,
  peek,
  findAiProposal,
  removeAiProposal,
  clearAiCache,
  generateAiProposals,
  buildUserPrompt,
  SYSTEM_PROMPT,
};
