'use strict';

/**
 * Suggestions de NOUVELLES tâches (itération 23).
 *
 * À la demande, l'IA propose quelques tâches à créer pour une journée, en
 * s'appuyant sur les projets, les échéances proches, la charge restante et le
 * check-in. Rien n'est créé sans validation : chaque suggestion est une
 * proposition `create_task`.
 */

const crypto = require('node:crypto');
const { config } = require('./config');
const { chatJson, AiError } = require('./ai');
const { SIZE_LABELS } = require('./capacity');
const { normalizeTitle } = require('./proposals');
const { buildDayDigest, rememberItems } = require('./aiProposals');
const { normalizeCheckin } = require('./checkin');
const { addDaysIso, isValidIsoDate } = require('./dates');
const { readLifeContext } = require('./lifeContext');

const SYSTEM_PROMPT = [
  'Tu proposes quelques nouvelles tâches concrètes pour une journée.',
  'Tu t’appuies sur les projets, les échéances proches et la charge restante.',
  'Tu ne crées aucune tâche : tu proposes, la personne valide.',
  'Tu réponds UNIQUEMENT par un objet JSON valide, sans texte autour.',
].join(' ');

let cache = new Map(); // date -> { signature, items, summary, generatedAt, usage, model }

function signatureOf(value) {
  return crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex');
}

function buildSuggestPrompt(digest, maxTasks) {
  return [
    `Propose jusqu’à ${maxTasks} NOUVELLES tâches à créer pour la journée du ${digest.date}.`,
    '',
    'Contexte : utilise "life_context" (objectifs de vie, projets, blocages), "project_context",',
    '"due_soon", "tasks", "checkin" et "can_add".',
    '',
    'Règles :',
    '- Chaque tâche doit faire avancer un projet/objectif réel de "life_context", pas une tâche générique.',
    '- Ajoute "life_area" : le nom exact du projet/objectif de life_context concerné',
    '  (ex. « Étudier AWS Developer Associate », « Suivi calorique », « n8n »).',
    '- Chaque tâche doit être une action concrète (verbe + objet + résultat), pas une tâche vague.',
    '- Elle doit avoir un lien clair avec un projet existant (project_id exact).',
    '- Propose majoritairement pour aujourd’hui (' + digest.date + '),',
    '  et 1 à 2 tâches à une date future (max ' + addDaysIso(digest.date, 30) + ')',
    '  si c’est un jalon utile pour l’avancement du projet.',
    '- Ne duplique aucune tâche existante (même sens, même titre).',
    '- Respecte la place restante "can_add" et "agenda" (L/M/S).',
    '- Priorité 1 (P1) à 4 (P4) ; taille L, M ou S.',
    '- Si un projet est bloqué, propose une petite action qui débloque concrètement.',
    '- Évite les tâches de communication personnelle non demandées (mail, WhatsApp, appels).',
    '',
    'Réponds EXACTEMENT par ce JSON :',
    '{"summary":"phrase courte expliquant tes suggestions",',
    ' "tasks":[{"title":"...","project_id":"...","life_area":"...","due_date":"AAAA-MM-JJ",',
    ' "size":"L|M|S","priority":1,"reason":"..."}]}',
    '',
    'Données :',
    JSON.stringify(digest),
  ].join('\n');
}

function validateTaskSuggestions(parsed, snapshot, date, digest, maxTasks = 3) {
  const activeProjects = (snapshot.projects || []).filter((project) => !project.is_archived);
  const projectById = new Map(activeProjects.map((project) => [project.id, project]));
  const existingTitles = new Set(
    (snapshot.tasks || [])
      .filter((task) => !task.project_archived)
      .map((task) => normalizeTitle(task.display_title || task.content))
      .filter(Boolean)
  );

  const horizonEnd = addDaysIso(date, 30);
  const rooms = new Map();
  const roomFor = (dueDate) => {
    if (rooms.has(dueDate)) return rooms.get(dueDate);
    let room;
    if (dueDate === date) {
      room = {
        L: Math.max(0, Number(digest.can_add?.L) || 0),
        M: Math.max(0, Number(digest.can_add?.M) || 0),
        S: Math.max(0, Number(digest.can_add?.S) || 0),
      };
    } else {
      const day = (digest.agenda || []).find((item) => item.date === dueDate);
      room = day?.remaining
        ? { ...day.remaining }
        : { L: 99, M: 99, S: 99 };
    }
    rooms.set(dueDate, room);
    return room;
  };

  const raw = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
  const items = [];
  const seen = new Set();

  for (const entry of raw) {
    if (items.length >= maxTasks) break;
    const title = String(entry?.title || '').trim().slice(0, 160);
    if (title.length < 3) continue;
    const normalized = normalizeTitle(title);
    if (!normalized || existingTitles.has(normalized) || seen.has(normalized)) continue;

    const project = projectById.get(String(entry?.project_id || ''));
    if (!project) continue;

    const size = ['L', 'M', 'S'].includes(entry?.size) ? entry.size : 'M';
    const dueDate = String(entry?.due_date || '');
    if (!isValidIsoDate(dueDate) || dueDate < date || dueDate > horizonEnd) continue;
    const room = roomFor(dueDate);
    if (room[size] <= 0) continue;

    const priority = Math.min(4, Math.max(1, Number(entry?.priority) || 2));
    const daysAhead = Math.max(
      0,
      Math.round(
        (new Date(`${dueDate}T12:00:00Z`) - new Date(`${date}T12:00:00Z`)) / 86400000
      )
    );
    room[size] -= 1;
    seen.add(normalized);
    items.push({
      id: `ai:create_task:${dueDate}:${crypto
        .createHash('sha1')
        .update(`${normalized}|${project.id}`)
        .digest('hex')
        .slice(0, 12)}`,
      type: 'create_task',
      type_label: 'Nouvelle tâche',
      action_label: 'Créer la tâche',
      source: 'ai-new',
      tone: 'ok',
      score: Math.max(10, 40 - daysAhead * 2),
      size,
      size_label: SIZE_LABELS[size],
      title,
      rationale:
        typeof entry?.reason === 'string' && entry.reason.trim()
          ? entry.reason.trim().slice(0, 300)
          : 'Nouvelle tâche proposée pour cette journée.',
      ai_group: null,
      target: {
        kind: 'project',
        id: project.id,
        name: project.name,
        project_id: project.id,
        project_name: project.name,
        section_id: null,
      },
      action: {
        content: title,
        due_date: dueDate,
        priority,
        project_id: project.id,
        life_area:
          String(entry?.life_area || '').trim().slice(0, 120) || project.name,
      },
      editable: ['due_date'],
      preview: `${SIZE_LABELS[size]} · P${5 - priority} · échéance ${dueDate}`,
      format: 'create',
    });
  }

  return {
    items,
    summary:
      typeof parsed?.summary === 'string' && parsed.summary.trim()
        ? parsed.summary.trim().slice(0, 300)
        : null,
    dropped: raw.length - items.length,
  };
}

async function generateTaskSuggestions(
  snapshot,
  date,
  { checkin = null, force = false } = {}
) {
  if (!config.aiEnabled) {
    throw new AiError('AI_DISABLED', 'L’IA n’est pas configurée (OPENROUTER_API_KEY manquant).');
  }

  const digest = {
    ...buildDayDigest(snapshot, date, normalizeCheckin(checkin)),
    life_context: readLifeContext(),
  };
  const signature = signatureOf(digest);
  const cached = cache.get(String(date));
  const fresh =
    cached &&
    cached.signature === signature &&
    (config.aiCacheTtlMs === 0 || Date.now() - cached.generatedAt < config.aiCacheTtlMs);

  if (fresh && !force) return { ...cached, cached: true };

  const { data, usage, model } = await chatJson({
    system: SYSTEM_PROMPT,
    user: buildSuggestPrompt(digest, config.aiMaxNewTasks),
  });

  const { items, summary, dropped } = validateTaskSuggestions(
    data,
    snapshot,
    date,
    digest,
    config.aiMaxNewTasks
  );

  let finalSummary = summary;
  if (items.length === 0 && !finalSummary) {
    finalSummary = 'Rien de pertinent à créer pour cette journée.';
  }
  if (dropped > 0 && items.length > 0) {
    finalSummary = `${finalSummary ? `${finalSummary} ` : ''}(${dropped} suggestion(s) écartée(s).)`;
  }

  const entry = { signature, items, summary: finalSummary, generatedAt: Date.now(), usage, model };
  cache.set(String(date), entry);
  if (items.length > 0) rememberItems(items);

  return { ...entry, cached: false };
}

function clearSuggestionCache() {
  cache = new Map();
}

module.exports = {
  SYSTEM_PROMPT,
  buildSuggestPrompt,
  validateTaskSuggestions,
  generateTaskSuggestions,
  clearSuggestionCache,
};
