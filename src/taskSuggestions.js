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
const { stripTimeMarker } = require('./taskTitles');
const { getTaskComments } = require('./todoist');

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
    '- Propose plusieurs idées différentes (au moins 3 si possible), pas une seule.',
    '- Anti-surcharge : privilégie 1 priorité + 2 petites actions ; si la charge est élevée, propose une micro-action de 2 minutes au lieu d’une grosse tâche.',
    '- Varie les objectifs/projets quand c’est pertinent.',
    '- Ne propose pas les titres listés dans "exclude" (déjà suggérés ou créés).',
    '- Chaque tâche doit faire avancer un projet/objectif réel de "life_context", pas une tâche générique.',
    '- Ajoute "life_area" : le nom exact du projet/objectif de life_context concerné',
    '  (ex. « Étudier AWS Developer Associate », « Suivi calorique », « n8n »).',
    '- Chaque tâche doit être une action concrète (verbe + objet + résultat), pas une tâche vague.',
    '- Elle doit avoir un lien clair avec un projet existant (project_id exact).',
    '- Propose majoritairement pour aujourd’hui (' + digest.date + '),',
    '  et 1 à 2 tâches à une date future (max ' + addDaysIso(digest.date, 30) + ')',
    '  si c’est un jalon utile pour l’avancement du projet.',
    '- Ne duplique aucune tâche existante, et ne propose JAMAIS une tâche déjà',
    '  complétée aujourd’hui (voir "completed_today"), même reformulée.',
    '- Respecte la place restante "can_add" et "agenda" (L/M/S).',
    '- Priorité 1 (P1) à 4 (P4) ; taille L, M ou S.',
    '- Les projets de "life_context" marqués comme quasi quotidiens ou avec une échéance proche doivent être proposés presque chaque jour, en variant les actions (sport : gym ou maison ; lecture : 40 pages ; permis : tests).',
    '- Si un projet est bloqué, propose une petite action qui débloque concrètement.',
    '- Lis "completed_with_comments". Si un commentaire indique que la tâche n’est pas réellement terminée (ex. « juste séparé les bords encore ensemble »), propose une nouvelle tâche pour finir le travail et mets l’identifiant dans "partial_completions".',
    '- Une tâche partielle ne doit pas être considérée comme accomplie dans les jalons.',
    '- Évite les tâches de communication personnelle non demandées (mail, WhatsApp, appels).',
    digest.exclude?.length
      ? `- À NE PAS PROPOSER (déjà suggérées/créées) : ${digest.exclude.join(' ; ')}.`
      : '',
    digest.instruction
      ? `- Consigne libre de la personne : « ${digest.instruction} ». Respecte-la en priorité.`
      : '',
    ...(Array.isArray(digest.goals) && digest.goals.length > 0
      ? [
          '',
          'Objectifs validés et prochains jalons :',
          ...digest.goals.map(
            (goal) =>
              `- ${goal.title} (${goal.progress}%) - prochain jalon : ${
                goal.next_milestone || 'à définir'
              }${
                goal.pace && Number(goal.pace.current || goal.pace.value) > 0
                  ? ` - rythme adapté : ${goal.pace.current || goal.pace.value} ${
                      goal.pace.unit || ''
                    }/jour (objectif de départ : ${goal.pace.base || '?'})`
                  : ''
              }`
          ),
          'Propose des tâches concrètes qui font avancer le prochain jalon non terminé.',
          'Si un rythme adapté est indiqué, respecte-le (ne repropose pas la quantité de départ).',
        ]
      : []),
    '',
    'Réponds EXACTEMENT par ce JSON :',
    '{"summary":"phrase courte expliquant tes suggestions",',
    ' "tasks":[{"title":"...","project_id":"...","life_area":"...","due_date":"AAAA-MM-JJ",',
    ' "size":"L|M|S","priority":1,"reason":"..."}],',
    ' "partial_completions":[{"task_id":"...","reason":"..."}]}',
    '',
    'Données :',
    JSON.stringify(digest),
  ].join('\n');
}

function validateTaskSuggestions(parsed, snapshot, date, digest, maxTasks = 3, exclude = []) {
  const activeProjects = (snapshot.projects || []).filter((project) => !project.is_archived);
  const projectById = new Map(activeProjects.map((project) => [project.id, project]));
  const existingTitles = new Set(
    (snapshot.tasks || [])
      .filter((task) => !task.project_archived)
      .map((task) => normalizeTitle(stripTimeMarker(task.display_title || task.content)))
      .filter(Boolean)
  );
  // Une tâche déjà terminée aujourd'hui ne doit pas être reproposée, même
  // reformulée (ex. « enregistrer mes 3 repas »).
  for (const item of (snapshot.completed && snapshot.completed.today) || []) {
    const normalized = normalizeTitle(stripTimeMarker(item.title));
    if (normalized) existingTitles.add(normalized);
  }

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

  const excluded = new Set(
    (Array.isArray(exclude) ? exclude : [])
      .map((title) => normalizeTitle(title))
      .filter(Boolean)
  );
  const raw = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
  const items = [];
  const seen = new Set();

  for (const entry of raw) {
    if (items.length >= maxTasks) break;
    const title = String(entry?.title || '').trim().slice(0, 160);
    if (title.length < 3) continue;
    const normalized = normalizeTitle(title);
    if (
      !normalized ||
      existingTitles.has(normalized) ||
      excluded.has(normalized) ||
      seen.has(normalized)
    ) {
      continue;
    }

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
  { checkin = null, force = false, exclude = [], instruction = '', goals = [] } = {}
) {
  if (!config.aiEnabled) {
    throw new AiError('AI_DISABLED', 'L’IA n’est pas configurée (OPENROUTER_API_KEY manquant).');
  }

  const cleanExclude = [...new Set(
    (Array.isArray(exclude) ? exclude : [])
      .map((title) => String(title || '').trim())
      .filter(Boolean)
  )].slice(0, 80);

  const cleanGoals = (Array.isArray(goals) ? goals : [])
    .map((goal) => ({
      id: String(goal?.id || '').slice(0, 80),
      title: String(goal?.title || '').slice(0, 160),
      progress: Math.max(0, Math.min(100, Number(goal?.progress) || 0)),
      next_milestone: goal?.next_milestone
        ? String(goal.next_milestone).slice(0, 180)
        : null,
    }))
    .filter((goal) => goal.id && goal.title)
    .slice(0, 10);

  // Les commentaires des tâches terminées aujourd'hui peuvent révéler une
  // complétion partielle (« j'ai juste séparé les bords »). On les lit au
  // moment des suggestions (pas à chaque chargement) pour économiser le quota.
  const completedToday = Array.isArray(snapshot?.completed?.today)
    ? snapshot.completed.today.slice(0, 12)
    : [];
  const completedWithComments = (
    await Promise.all(
      completedToday.map(async (item) => {
        if (!item.id) return null;
        try {
          const result = await getTaskComments(item.id);
          const comments = (Array.isArray(result?.results) ? result.results : [])
            .filter((comment) => comment && comment.is_deleted !== true)
            .map((comment) => String(comment.content || '').trim())
            .filter(Boolean)
            .slice(0, 3);
          if (comments.length === 0) return null;
          return {
            id: String(item.id),
            title: String(item.title || '').slice(0, 160),
            comments: comments.join(' | ').slice(0, 600),
          };
        } catch {
          return null;
        }
      })
    )
  ).filter(Boolean);

  const digest = {
    ...buildDayDigest(snapshot, date, normalizeCheckin(checkin)),
    life_context: readLifeContext(),
    exclude: cleanExclude,
    instruction: String(instruction || '').trim().slice(0, 500) || null,
    goals: cleanGoals,
    completed_with_comments: completedWithComments,
  };
  const signature = signatureOf(digest);
  const cached = cache.get(String(date));
  const fresh =
    cached &&
    cached.signature === signature &&
    (config.aiCacheTtlMs === 0 || Date.now() - cached.generatedAt < config.aiCacheTtlMs);

  if (fresh && !force) return { ...cached, cached: true };

  const first = await chatJson({
    system: SYSTEM_PROMPT,
    user: buildSuggestPrompt(digest, config.aiMaxNewTasks),
  });

  const firstValidation = validateTaskSuggestions(
    first.data,
    snapshot,
    date,
    digest,
    config.aiMaxNewTasks,
    cleanExclude
  );

  let candidates = Array.isArray(first.data?.tasks) ? first.data.tasks : [];
  let summary = firstValidation.summary;
  let second = null;

  // Le modèle s'arrête parfois à une seule idée : on relance une fois en lui
  // demandant explicitement de compléter avec d'autres tâches.
  if (firstValidation.items.length < Math.min(3, config.aiMaxNewTasks)) {
    const already = [
      ...cleanExclude,
      ...firstValidation.items.map((item) => item.title),
    ];
    const complementDigest = { ...digest, exclude: already };
    try {
      second = await chatJson({
        system: SYSTEM_PROMPT,
        user: buildSuggestPrompt(complementDigest, config.aiMaxNewTasks),
      });
      if (Array.isArray(second.data?.tasks)) {
        candidates = [...candidates, ...second.data.tasks];
      }
      if (second.data?.summary) summary = second.data.summary;
    } catch (error) {
      console.warn('[suggestions] complément impossible :', error?.code || error?.message);
    }
  }

  const { items, summary: validatedSummary, dropped } = validateTaskSuggestions(
    { ...first.data, tasks: candidates },
    snapshot,
    date,
    digest,
    config.aiMaxNewTasks,
    cleanExclude
  );

  let finalSummary = summary || validatedSummary;
  if (items.length === 0 && !finalSummary) {
    finalSummary = 'Aucune nouvelle tâche pertinente trouvée pour l’instant.';
  }
  if (dropped > 0 && items.length > 0) {
    finalSummary = `${finalSummary ? `${finalSummary} ` : ''}(${dropped} suggestion(s) écartée(s).)`;
  }

  const commentIds = new Set(completedWithComments.map((item) => item.id));
  const partials = new Map();
  for (const source of [first.data, second?.data]) {
    const raw = Array.isArray(source?.partial_completions)
      ? source.partial_completions
      : [];
    for (const item of raw) {
      const id = String(item?.task_id || '');
      if (!commentIds.has(id) || partials.has(id)) continue;
      partials.set(id, {
        task_id: id,
        reason: String(item?.reason || '').trim().slice(0, 240) || null,
      });
    }
  }

  const entry = {
    signature,
    items,
    summary: finalSummary,
    partial_completions: [...partials.values()],
    generatedAt: Date.now(),
    usage: first.usage,
    model: first.model,
  };
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
