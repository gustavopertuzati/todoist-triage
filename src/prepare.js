'use strict';

/**
 * Préparation d'une tâche (itération 12).
 *
 * Pour une tâche donnée (« Ranger la cave »), l'IA propose des **tâches de
 * préparation** courtes et concrètes (« Sortir les cartons », « Préparer ce
 * qu'il faut descendre »), planifiées AVANT la tâche — ou le jour même si elle
 * est aujourd'hui. Elles deviennent des **sous-tâches** du parent, avec leur
 * propre date, ce qui rend la tâche principale plus légère.
 *
 * L'IA ne crée jamais rien : elle propose, et chaque préparation est validée
 * puis relue via l'API. Module pur pour la construction et la validation ;
 * l'appel au modèle vit dans `generatePreparation`.
 */

const crypto = require('node:crypto');
const { config } = require('./config');
const { chatJson, AiError } = require('./ai');
const { addDaysIso, daysBetweenIso, isValidIsoDate } = require('./dates');
const { estimateTaskSize } = require('./capacity');
const { normalizeTitle, targetFromTask } = require('./proposals');
const { rememberItems } = require('./aiProposals');

const SYSTEM_PROMPT = [
  'Tu aides une personne à PRÉPARER une tâche pour qu’elle soit moins difficile.',
  'Tu proposes des tâches de préparation courtes, concrètes et réellement utiles.',
  'Réfléchis brièvement. Tu réponds UNIQUEMENT par un objet JSON valide, sans texte autour.',
].join(' ');

let cache = new Map(); // taskId -> { signature, items, summary, generatedAt, usage, model }

function hashId(parts) {
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12);
}

/** Retire un éventuel préfixe « 1. » / « 2) » pour ne jamais le doubler. */
function stripOrderPrefix(value) {
  return String(value || '')
    .replace(/^\s*\d+[.)]\s*/, '')
    .trim();
}

/** Numérote une sous-tâche selon sa position d'exécution. */
function numberedTitle(value, index) {
  const clean = stripOrderPrefix(value);
  return `${index + 1}. ${clean}`;
}

function signatureOf(value) {
  return crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex');
}

/**
 * Dates disponibles pour la préparation : de today à la date de la tâche,
 * plafonnées à 31 jours pour ne pas étaler une préparation dans le lointain.
 */
function prepWindow(task, today) {
  const target = isValidIsoDate(task.due_date) ? task.due_date : today;
  const end = target < today ? today : target;
  const dates = [];
  let current = today;
  for (let i = 0; i < 31; i += 1) {
    dates.push(current);
    if (current >= end) break;
    current = addDaysIso(current, 1);
  }
  const windowEnd = dates[dates.length - 1];
  return { target, windowEnd, dates, tooEarly: target > windowEnd };
}

function buildPrepareDigest(task, snapshot, { maxPrep = 3 } = {}) {
  const today = snapshot.meta.today;
  const { target, windowEnd, dates } = prepWindow(task, today);
  const days = ((snapshot.capacity && snapshot.capacity.days) || []).filter((day) =>
    dates.includes(day.date)
  );

  const existing = snapshot.tasks
    .filter((item) => item.parent_id === task.id)
    .map((item) => ({
      title: stripOrderPrefix(item.display_title || item.content || '').slice(0, 80),
      date: item.due_date || null,
    }));

  return {
    today,
    timezone: snapshot.meta.timezone,
    max_prep: maxPrep,
    window_end: windowEnd,
    task: {
      id: task.id,
      title: String(task.display_title || task.content || '').slice(0, 140),
      project: task.project_name || null,
      date: target,
      in_days: Math.max(0, daysBetweenIso(today, target)),
      size: estimateTaskSize(task, task.subtask_count || 0),
      note: String(task.description || '').slice(0, 300),
      existing_subtasks: existing,
    },
    capacity: days.map((day) => ({ date: day.date, remaining: day.remaining })),
  };
}

function buildPreparePrompt(digest) {
  const t = digest.task;
  return [
    `Prépare la tâche « ${t.title} » prévue le ${t.date} (dans ${t.in_days} jour(s)).`,
    '',
    'Propose jusqu’à ' + digest.max_prep + ' tâches de PRÉPARATION, courtes et concrètes,',
    'à faire AVANT la tâche (ou le jour même si c’est aujourd’hui) pour qu’elle soit plus facile.',
    'Exemples : « Sortir les cartons à descendre », « Faire la liste de ce qu’il faut trier »,',
    '« Préparer les sacs et la lampe ».',
    '',
    'Règles :',
    '- Chaque préparation est une PETITE tâche, vraiment utile (pas de remplissage).',
    '- "date" au format AAAA-MM-JJ, entre today et la date de la tâche.',
    '- Les préparations sont LÉGÈRES : elles n’occupent pas de créneau 1-3-5.',
    '  Tu peux en proposer même si la journée paraît pleine (voir "capacity" comme une indication).',
    '- N’ajoute pas une préparation qui existe déjà (voir "existing_subtasks").',
    '- Si la tâche n’a pas besoin de préparation, renvoie une liste vide.',
    '',
    'Réponds EXACTEMENT par ce JSON :',
    '{"summary":"phrase courte expliquant ta préparation",',
    ' "preparations":[{"title":"...","date":"AAAA-MM-JJ","reason":"..."}]}',
    '',
    'Données :',
    JSON.stringify(digest),
  ].join('\n');
}

/**
 * Valide la réponse du modèle : titres uniques, dates dans la fenêtre, pas de
 * doublon avec l’existant. La capacité 1-3-5 ne bloque **pas** une préparation :
 * ce sont de petites actions de mise en route, pas des tâches de la journée.
 * @returns {{items: object[], dropped: number}}
 */
function validatePrepareResponse(parsed, task, snapshot, digest) {
  const today = snapshot.meta.today;
  const target = digest.task.date;
  const existing = new Set(
    (digest.task.existing_subtasks || []).map((s) => normalizeTitle(stripOrderPrefix(s.title)))
  );

  const raw = Array.isArray(parsed?.preparations) ? parsed.preparations : [];
  const seen = new Set([...existing].filter(Boolean));
  const subtasks = [];

  for (const entry of raw) {
    if (subtasks.length >= digest.max_prep) break;
    const cleanTitle = stripOrderPrefix(entry?.title).slice(0, 160);
    if (cleanTitle.length < 3) continue;
    const normalized = normalizeTitle(cleanTitle);
    if (!normalized || seen.has(normalized)) continue;

    const date = String(entry?.date || '').trim();
    const windowEnd = isValidIsoDate(digest.window_end) ? digest.window_end : target;
    if (!isValidIsoDate(date) || date < today || date > windowEnd) continue;

    seen.add(normalized);
    subtasks.push({
      title: numberedTitle(cleanTitle, subtasks.length),
      date,
      reason: String(entry?.reason || '').trim().slice(0, 200) || null,
    });
  }

  if (subtasks.length === 0) return { items: [], dropped: raw.length };

  const item = {
    id: `ai:prepare_task:${task.id}:${hashId(subtasks.map((s) => `${s.title}@${s.date}`))}`,
    type: 'prepare_task',
    type_label: 'Préparer',
    action_label: 'Créer la préparation',
    source: 'ai',
    tone: 'ok',
    score: 48,
    size: null,
    size_label: null,
    title: 'Préparer cette tâche',
    rationale:
      typeof parsed?.summary === 'string' && parsed.summary.trim()
        ? parsed.summary.trim().slice(0, 300)
        : 'Ces tâches rendront la tâche principale plus légère.',
    ai_group: null,
    target: targetFromTask(task),
    action: { subtasks, parent_id: task.id },
    editable: [],
    preview: `${subtasks.length} préparation(s) : ${subtasks
      .map((s) => `${s.title} (${s.date})`)
      .slice(0, 3)
      .join(' · ')}${subtasks.length > 3 ? '…' : ''}`,
    format: 'prepare',
    prep_items: subtasks,
  };

  return { items: [item], dropped: raw.length - subtasks.length };
}

/**
 * Génère (ou récupère) les préparations d'une tâche.
 */
async function generatePreparation(snapshot, taskId, { force = false } = {}) {
  if (!config.aiEnabled) {
    throw new AiError('AI_DISABLED', 'L’IA n’est pas configurée (OPENROUTER_API_KEY manquant).');
  }

  const task = snapshot.tasks.find((item) => item.id === String(taskId));
  if (!task || task.project_archived) {
    throw new AiError('TASK_NOT_FOUND', 'Tâche introuvable (elle a peut-être changé).');
  }
  if ((task.subtask_count || 0) > 0) {
    // Une tâche déjà découpée se prépare via ses sous-tâches : rien à proposer.
    return { items: [], summary: 'Cette tâche a déjà des sous-tâches.', cached: false };
  }

  const window = prepWindow(task, snapshot.meta.today);
  if (window.tooEarly) {
    // Inutile de préparer un événement à neuf mois : on le fera dans le mois
    // qui précède, quand les idées seront concrètes.
    return {
      items: [],
      summary:
        'Trop tôt : cette tâche est encore lointaine. La préparation sera proposée dans les 30 jours qui précèdent.',
      cached: false,
    };
  }

  const digest = buildPrepareDigest(task, snapshot, { maxPrep: config.prepMaxItems });
  const signature = signatureOf(digest);
  const cached = cache.get(String(taskId));

  const fresh =
    cached &&
    cached.signature === signature &&
    (config.aiCacheTtlMs === 0 || Date.now() - cached.generatedAt < config.aiCacheTtlMs);

  if (fresh && !force) return { ...cached, cached: true };

  const { data, usage, model } = await chatJson({
    system: SYSTEM_PROMPT,
    user: buildPreparePrompt(digest),
  });

  const { items, dropped } = validatePrepareResponse(data, task, snapshot, digest);

  let summary = typeof data?.summary === 'string' ? data.summary.trim().slice(0, 400) : null;
  if (items.length === 0 && !summary) {
    summary = 'Rien de nécessaire : cette tâche peut se faire telle quelle.';
  }
  if (dropped > 0 && items.length > 0) {
    summary = `${summary ? `${summary} ` : ''}(${dropped} suggestion(s) écartée(s).)`;
  }

  const entry = { signature, items, summary, generatedAt: Date.now(), usage, model };
  cache.set(String(taskId), entry);
  if (items.length > 0) rememberItems(items);

  return { ...entry, cached: false };
}

function clearPrepareCache() {
  cache = new Map();
  decomposeCache = new Map();
}

// ---------------------------------------------------------------------------
// Découpage d'une tâche feuille en sous-tâches (depuis l'explorateur)
// ---------------------------------------------------------------------------

const DECOMPOSE_SYSTEM_PROMPT = [
  'Tu aides une personne à DÉCOUPER une tâche trop grosse en sous-tâches concrètes.',
  'Chaque sous-tâche doit être une action claire, autonome et réalisable.',
  'Réfléchis brièvement. Tu réponds UNIQUEMENT par un objet JSON valide, sans texte autour.',
].join(' ');

let decomposeCache = new Map();

function buildDecomposeDigest(task, snapshot, { maxItems = 5 } = {}) {
  const existing = snapshot.tasks
    .filter((item) => item.parent_id === task.id)
    .map((item) => stripOrderPrefix(item.display_title || item.content || '').slice(0, 120));

  return {
    today: snapshot.meta.today,
    max_items: maxItems,
    task: {
      id: task.id,
      title: String(task.display_title || task.content || '').slice(0, 160),
      project: task.project_name || null,
      date: task.due_date || null,
      size: estimateTaskSize(task, task.subtask_count || 0),
      note: String(task.description || '').slice(0, 500),
      existing_subtasks: existing,
    },
  };
}

function buildDecomposePrompt(digest) {
  return [
    `Découpe la tâche « ${digest.task.title} » en 2 à ${digest.max_items} sous-tâches.`,
    '',
    'Règles :',
    '- Chaque sous-tâche est une action concrète, à l’infinitif, réalisable seule.',
    '- Ne recopie pas la tâche parente et n’ajoute pas de sous-tâche déjà existante.',
    '- Pas de dates : ce sont des morceaux de la tâche, pas un planning.',
    '- Si la tâche est déjà atomique (une seule action), renvoie une liste vide.',
    '- Ordonne les sous-tâches dans l’ordre logique d’exécution.',
    '',
    'Réponds EXACTEMENT par ce JSON :',
    '{"summary":"phrase courte expliquant le découpage",',
    ' "subtasks":["première action","deuxième action"]}',
    '',
    'Données :',
    JSON.stringify(digest),
  ].join('\n');
}

function validateDecomposeResponse(parsed, task, digest) {
  const raw = Array.isArray(parsed?.subtasks) ? parsed.subtasks : [];
  const existing = new Set(
    (digest.task.existing_subtasks || []).map((title) => normalizeTitle(stripOrderPrefix(title)))
  );
  const seen = new Set([...existing].filter(Boolean));
  const titles = [];

  for (const entry of raw) {
    if (titles.length >= digest.max_items) break;
    const value = typeof entry === 'string' ? entry : entry?.title;
    const cleanTitle = stripOrderPrefix(value).slice(0, 160);
    if (cleanTitle.length < 3) continue;
    const normalized = normalizeTitle(cleanTitle);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    titles.push(numberedTitle(cleanTitle, titles.length));
  }

  // Un découpage d'un seul morceau n'apporte rien.
  if (titles.length < 2) return { item: null, dropped: raw.length };

  const item = {
    id: `ai:decompose:${task.id}:${hashId(titles)}`,
    type: 'split_task',
    type_label: 'Découper',
    action_label: 'Créer les sous-tâches',
    source: 'ai',
    tone: 'ok',
    score: 46,
    size: null,
    size_label: null,
    title: 'Découper cette tâche',
    rationale:
      typeof parsed?.summary === 'string' && parsed.summary.trim()
        ? parsed.summary.trim().slice(0, 300)
        : 'Ces morceaux rendront la tâche plus facile à démarrer.',
    ai_group: null,
    target: targetFromTask(task),
    action: { subtasks: titles },
    editable: [],
    preview: `${titles.length} sous-tâche(s) : ${titles.slice(0, 4).join(' · ')}${
      titles.length > 4 ? '…' : ''
    }`,
    format: 'split',
    subtasks: titles,
  };

  return { item, dropped: raw.length - titles.length };
}

/**
 * Génère (ou récupère) un découpage de la tâche en sous-tâches.
 */
async function generateDecomposition(snapshot, taskId, { force = false } = {}) {
  if (!config.aiEnabled) {
    throw new AiError('AI_DISABLED', 'L’IA n’est pas configurée (OPENROUTER_API_KEY manquant).');
  }

  const task = snapshot.tasks.find((item) => item.id === String(taskId));
  if (!task || task.project_archived) {
    throw new AiError('TASK_NOT_FOUND', 'Tâche introuvable (elle a peut-être changé).');
  }
  if ((task.subtask_count || 0) > 0) {
    return {
      items: [],
      summary: 'Cette tâche a déjà des sous-tâches : ouvre-en une pour la découper à son tour.',
      cached: false,
    };
  }

  const digest = buildDecomposeDigest(task, snapshot, { maxItems: config.decomposeMaxItems });
  const signature = signatureOf(digest);
  const cached = decomposeCache.get(String(taskId));

  const fresh =
    cached &&
    cached.signature === signature &&
    (config.aiCacheTtlMs === 0 || Date.now() - cached.generatedAt < config.aiCacheTtlMs);

  if (fresh && !force) return { ...cached, cached: true };

  const { data, usage, model } = await chatJson({
    system: DECOMPOSE_SYSTEM_PROMPT,
    user: buildDecomposePrompt(digest),
  });

  const { item, dropped } = validateDecomposeResponse(data, task, digest);

  let summary = typeof data?.summary === 'string' ? data.summary.trim().slice(0, 400) : null;
  if (!item && !summary) {
    summary = 'Cette tâche semble déjà atomique : elle n’a pas besoin d’être découpée.';
  }
  if (dropped > 0 && item) {
    summary = `${summary ? `${summary} ` : ''}(${dropped} proposition(s) écartée(s).)`;
  }

  const items = item ? [item] : [];
  const entry = { signature, items, summary, generatedAt: Date.now(), usage, model };
  decomposeCache.set(String(taskId), entry);
  if (items.length > 0) rememberItems(items);

  return { ...entry, cached: false };
}

module.exports = {
  SYSTEM_PROMPT,
  DECOMPOSE_SYSTEM_PROMPT,
  stripOrderPrefix,
  numberedTitle,
  prepWindow,
  buildPrepareDigest,
  buildPreparePrompt,
  validatePrepareResponse,
  validateDecomposeResponse,
  buildDecomposeDigest,
  buildDecomposePrompt,
  generatePreparation,
  generateDecomposition,
  clearPrepareCache,
};
