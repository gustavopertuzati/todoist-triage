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
    .map((item) => ({ title: String(item.display_title || item.content || '').slice(0, 80), date: item.due_date || null }));

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
    '- Respecte la place restante des jours (voir "capacity") ; ne dépasse jamais.',
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
 * Valide la réponse du modèle : titres uniques, dates dans la fenêtre, place
 * restante respectée (petites tâches), pas de doublon avec l’existant.
 * @returns {{items: object[], dropped: number}}
 */
function validatePrepareResponse(parsed, task, snapshot, digest) {
  const today = snapshot.meta.today;
  const target = digest.task.date;
  const existing = new Set(
    (digest.task.existing_subtasks || []).map((s) => normalizeTitle(s.title))
  );
  const remaining = new Map(
    (digest.capacity || []).map((day) => [day.date, { ...day.remaining }])
  );

  const raw = Array.isArray(parsed?.preparations) ? parsed.preparations : [];
  const seen = new Set([...existing].filter(Boolean));
  const subtasks = [];

  for (const entry of raw) {
    if (subtasks.length >= digest.max_prep) break;
    const title = String(entry?.title || '').trim().slice(0, 160);
    if (title.length < 3) continue;
    const normalized = normalizeTitle(title);
    if (!normalized || seen.has(normalized)) continue;

    const date = String(entry?.date || '').trim();
    const windowEnd = isValidIsoDate(digest.window_end) ? digest.window_end : target;
    if (!isValidIsoDate(date) || date < today || date > windowEnd) continue;

    const slot = remaining.get(date);
    if (!slot || slot.S <= 0) continue; // les préparations sont de petites tâches
    slot.S -= 1;

    seen.add(normalized);
    subtasks.push({ title, date, reason: String(entry?.reason || '').trim().slice(0, 200) || null });
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
}

module.exports = {
  SYSTEM_PROMPT,
  prepWindow,
  buildPrepareDigest,
  buildPreparePrompt,
  validatePrepareResponse,
  generatePreparation,
  clearPrepareCache,
};
