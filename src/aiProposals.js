'use strict';

/**
 * Planification par jour assistée par l'IA (itérations 6 et 7).
 *
 * Pour une date donnée, l'app :
 *   1. mesure ce qui est déjà prévu ce jour-là (taille estimée de chaque tâche) ;
 *   2. applique le check-in du jour (énergie, forme, temps, envie, humeur) pour
 *      calculer la charge AUTORISÉE, plus légère si tu es fatigué ou malade ;
 *   3. demande à l'IA quelles tâches conviennent le mieux à ce jour — et, si la
 *      journée est trop chargée, quelles tâches **reporter** vers d'autres jours.
 *
 * L'IA ne peut produire que des échéances (`set_due_date`, ajout ou report) et des
 * scissions (`split_task`). Aucune écriture ici.
 */

const crypto = require('node:crypto');
const { config } = require('./config');
const { chatJson, AiError } = require('./ai');
const { weekdayName, estimateTaskSize, SIZE_LABELS } = require('./capacity');
const { addDaysIso } = require('./dates');
const { targetFromTask } = require('./proposals');
const { computeAllowed, describeCheckin, normalizeCheckin } = require('./checkin');
const { buildProfile, normalizeFeedback, describeForPrompt, REASON_TEXT } = require('./feedback');

const SYSTEM_PROMPT = [
  'Tu es un assistant d’organisation personnelle, spécialisé dans la planification d’une',
  'journée précise d’un Todoist surchargé. Tu tiens compte de l’état et de l’humeur de la',
  'personne, et tu respectes strictement la charge autorisée.',
  'Réfléchis brièvement, sans digression.',
  'Tu réponds UNIQUEMENT par un objet JSON valide, sans texte autour, sans balises Markdown.',
].join(' ');

function hashId(parts) {
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12);
}

function signatureOf(value) {
  return crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex');
}

function total(load) {
  return load.L + load.M + load.S;
}

const STORE_TTL_MS = 2 * 60 * 60 * 1000;
const STORE_MAX = 400;
let store = new Map();
let dayCache = new Map();

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
  const day = ((snapshot.capacity && snapshot.capacity.days) || []).find((d) => d.date === date);

  const planned = snapshot.tasks
    .filter((task) => !task.project_archived && task.due_date === date)
    .map((task) => ({
      id: task.id,
      title: task.display_title || task.content,
      size: estimateTaskSize(task),
      size_label: SIZE_LABELS[estimateTaskSize(task)],
      priority_label: task.priority_label,
      project_name: task.project_name,
      subtasks: task.subtask_count || 0,
    }));

  const load = day ? { ...day.load } : { L: 0, M: 0, S: 0 };
  const remaining = day ? { ...day.remaining } : { ...rule };

  return { date, weekday: weekdayName(date), rule, load, remaining, total: planned.length, planned };
}

/** Condensé envoyé au modèle pour une journée (avec le check-in). */
function buildDayDigest(snapshot, date, checkin, profile) {
  const info = dayInfo(snapshot, date);
  const { allowed, label, notes, answers } = computeAllowed(checkin, info.rule);
  const active = snapshot.tasks.filter((task) => !task.project_archived);

  const never = new Set(profile ? profile.never : []);
  const postpone = new Map((profile ? profile.postpone : []).map((p) => [p.taskId, p.until]));
  const sizeCorrections = new Map((profile ? profile.sizes : []).map((s) => [s.taskId, s.size]));

  const overdue = active
    .filter((task) => task.is_overdue)
    .sort((a, b) => (b.days_overdue || 0) - (a.days_overdue || 0))
    .slice(0, 12);

  const undated = active
    .filter((task) => !task.due_date)
    .sort((a, b) => (b.priority || 0) - (a.priority || 0) || (b.age_days || 0) - (a.age_days || 0))
    .slice(0, 30);

  // Tâches qui arrivent dans les 14 jours : utiles pour anticiper/préparer un
  // projet, mais à ne pas sortir de leur échéance sans raison.
  const soonLimit = addDaysIso(date, 14);
  const upcoming = active
    .filter(
      (task) =>
        task.due_date &&
        task.due_date > date &&
        task.due_date <= soonLimit &&
        !task.is_overdue
    )
    .sort((a, b) => a.due_date.localeCompare(b.due_date) || (b.priority || 0) - (a.priority || 0))
    .slice(0, 25);

  const seen = new Set();
  const tasks = [];
  const titleById = new Map(
    active.map((task) => [task.id, String(task.display_title || task.content || '').slice(0, 60)])
  );
  const taskById = new Map(active.map((task) => [task.id, task]));

  for (const task of [...overdue, ...undated, ...upcoming]) {
    if (seen.has(task.id)) continue;
    if (never.has(task.id)) continue; // ne jamais reproposer
    // Un parent qui a des sous-tâches est un conteneur : on ne le propose pas
    // directement, ce sont ses sous-tâches (les « feuilles ») qu'on planifie.
    if ((task.subtask_count || 0) > 0) continue;
    seen.add(task.id);
    tasks.push({
      id: task.id,
      title: String(task.display_title || task.content || '').slice(0, 120),
      project: task.project_name || null,
      project_id: task.project_id || null,
      priority: task.priority_label,
      due: task.due_date || null,
      due_in_days: task.due_date
        ? Math.max(0, Math.round((new Date(`${task.due_date}T12:00:00Z`) - new Date(`${date}T12:00:00Z`)) / 86400000))
        : null,
      days_overdue: task.days_overdue || null,
      age_days: task.age_days,
      labels: (task.labels || []).slice(0, 3),
      has_note: Boolean(task.description && task.description.trim()),
      is_subtask: Boolean(task.parent_id),
      parent: task.parent_id ? titleById.get(task.parent_id) || null : null,
      size_hint: sizeCorrections.get(task.id) || estimateTaskSize(task),
      reported_size: sizeCorrections.get(task.id) || null,
      avoid_until: postpone.get(task.id) || null,
    });
  }

  const excess = {
    L: Math.max(0, info.load.L - allowed.L),
    M: Math.max(0, info.load.M - allowed.M),
    S: Math.max(0, info.load.S - allowed.S),
  };
  const room = {
    L: Math.max(0, allowed.L - info.load.L),
    M: Math.max(0, allowed.M - info.load.M),
    S: Math.max(0, allowed.S - info.load.S),
  };

  const otherDays = ((snapshot.capacity && snapshot.capacity.days) || [])
    .filter((day) => day.date !== date)
    .map((day) => ({ date: day.date, weekday: day.weekday, remaining: day.remaining }));

  const selectedDayTasks = info.planned.slice(0, 20).map((task) => ({
    id: task.id,
    title: String(task.title).slice(0, 80),
    size: task.size,
    priority: task.priority_label,
    has_subtasks: (taskById.get(task.id)?.subtask_count || 0) > 0,
  }));

  return {
    today: snapshot.meta.today,
    timezone: snapshot.meta.timezone,
    date,
    weekday: info.weekday,
    checkin: {
      answers: describeCheckin(answers),
      notes,
      label,
    },
    capacity_rule: info.rule,
    allowed,
    day_load: info.load,
    can_add: room,
    to_remove: excess,
    max_proposals: Math.min(config.aiMaxProposals, Math.max(0, total(room))),
    max_defers: Math.min(config.aiMaxProposals, Math.max(0, total(excess))),
    selected_day_tasks: selectedDayTasks,
    agenda: otherDays,
    feedback: describeForPrompt(profile) || null,
    todoist_filters: (snapshot.filters || [])
      .slice(0, 20)
      .map((filter) => ({ name: filter.name, query: filter.query })),
    project_context: snapshot.projects
      .filter((project) => !project.is_archived)
      .map((project) => ({
        id: project.id,
        name: project.name,
        is_inbox: Boolean(project.is_inbox),
        verdict: project.diagnosis?.verdict || null,
        score: project.diagnosis?.score ?? null,
        tasks: project.stats?.tasks ?? null,
        overdue: project.stats?.overdue ?? null,
        no_due: project.stats?.no_due ?? null,
        completed_lookback: project.stats?.completed_lookback ?? null,
        description: String(project.description || '').slice(0, 180) || null,
      })),
    due_soon: upcoming.slice(0, 15).map((task) => ({
      id: task.id,
      title: String(task.display_title || task.content || '').slice(0, 100),
      project: task.project_name || null,
      due: task.due_date,
      priority: task.priority_label,
    })),
    completed_today: ((snapshot.completed && snapshot.completed.today) || [])
      .slice(0, 50)
      .map((item) => ({ title: item.title, project: item.project_name || null })),
    tasks,
  };
}

function buildUserPrompt(digest) {
  const answers = digest.checkin.answers
    .map((answer) => `- ${answer.label} : ${answer.option}`)
    .join('\n');

  const lines = [
    `Planifie la journée du ${digest.date} (${digest.weekday}).`,
    '',
    'Check-in de la personne :',
    answers,
  ];

  if (digest.checkin.notes.length > 0) {
    lines.push('Consignes liées au check-in :', ...digest.checkin.notes.map((n) => `- ${n}`));
  }

  if (Array.isArray(digest.todoist_filters) && digest.todoist_filters.length > 0) {
    lines.push(
      '',
      'Filtres Todoist de la personne (indices de contextes, ne les invente pas) :',
      ...digest.todoist_filters.map(
        (filter) => `- ${filter.name}${filter.query ? ` : ${filter.query}` : ''}`
      )
    );
  }

  if (digest.feedback) {
    const fb = digest.feedback;
    lines.push('', 'Retours de la personne sur tes propositions précédentes :');
    if (fb.signaux) {
      const signals = Object.entries(fb.signaux)
        .map(([reason, count]) => `${REASON_TEXT[reason] || reason} ×${count}`)
        .join(', ');
      if (signals) lines.push(`- Raisons fréquentes d’ignorer : ${signals}.`);
    }
    if (fb.ne_pas_proposer.length) {
      lines.push(`- NE PLUS PROPOSER : ${fb.ne_pas_proposer.join(' ; ')}.`);
    }
    if (fb.reporter_apres.length) {
      lines.push(
        '- À NE PAS REPROGRAMMER AVANT : ' +
          fb.reporter_apres.map((p) => `${p.tache} (après ${p.apres})`).join(' ; ') +
          '.'
      );
    }
    if (fb.taille_reelle.length) {
      lines.push(
        '- Tailles corrigées par la personne : ' +
          fb.taille_reelle.map((s) => `${s.tache} = ${s.taille}`).join(' ; ') +
          '.'
      );
    }
    if (fb.a_ameliorer.length) {
      lines.push(
        '- TÂCHES À AMÉLIORER (titre pas clair ou trop grosses) : ' +
          fb.a_ameliorer.map((i) => `${i.tache} (${i.pourquoi})`).join(' ; ') +
          '. Tu peux proposer un titre plus clair dans "renames" ou une scission dans "splits".'
      );
    }
    if (fb.garder_aujourdhui && fb.garder_aujourdhui.length) {
      lines.push(
        '- À GARDER AUJOURD’HUI (ne PAS reporter) : ' +
          fb.garder_aujourdhui.map((g) => `${g.tache} (adapter : ${g.adapter})`).join(' ; ') +
          '. Ces tâches restent ce jour : ne les reporte jamais. Propose plutôt une ADAPTATION ' +
          '(les découper dans "splits", ou une version plus courte) ou garde-les telles quelles.'
      );
    }
    if (fb.ne_pas_decouper && fb.ne_pas_decouper.length) {
      lines.push('- NE PAS DÉCOUPER : ' + fb.ne_pas_decouper.join(' ; ') + '.');
    }
    if (fb.ne_pas_renommer && fb.ne_pas_renommer.length) {
      lines.push('- NE PAS REFORMULER LE TITRE DE : ' + fb.ne_pas_renommer.join(' ; ') + '.');
    }
  }

  lines.push(
    '',
    'Charge autorisée pour cette journée (règle adaptée à son état) :',
    `- gros (L) : ${digest.allowed.L}`,
    `- moyens (M) : ${digest.allowed.M}`,
    `- petits (S) : ${digest.allowed.S}`,
    '',
    `Déjà prévu ce jour : ${digest.day_load.L} gros, ${digest.day_load.M} moyens, ${digest.day_load.S} petits.`,
    ''
  );

  const remove = total(digest.to_remove);
  const add = total(digest.can_add);

  if (remove > 0) {
    lines.push(
      `La journée est TROP CHARGÉE : il faudrait reporter environ ${remove} tâche(s) pour`,
      `respecter la charge autorisée. Dans cette passe, propose au maximum ${digest.max_defers}`,
      'report(s) : choisis dans "selected_day_tasks" les tâches les moins essentielles',
      '(petites priorités d’abord) et mets-les dans "defer" avec une nouvelle date, en',
      'respectant la place restante des autres jours (voir "agenda").',
      ''
    );
  }

  if (add > 0) {
    lines.push(
      `Il reste de la place pour environ ${add} tâche(s) : choisis dans "tasks" les plus`,
      'adaptées à son état (voir le check-in) et mets-les dans "proposals" avec la date',
      `exacte ${digest.date}.`,
      ''
    );
  }

  lines.push(
    'Règles :',
    '- Ne dépasse jamais "allowed" pour les ajouts.',
    '- Donne pour chaque ajout une taille "L", "M" ou "S".',
    '- "due_date" des ajouts doit être EXACTEMENT ' + digest.date + '.',
    '- "reason" : une phrase courte en français, tenant compte de son état.',
    `- Au maximum ${digest.max_proposals} ajout(s).`,
    '- Les tâches listées sont des tâches « feuilles » (sans sous-tâches). Si une tâche a',
    '  "parent", tu peux la regrouper avec ses sœurs sur un même jour.',
    '',
    'Projets et échéances (TRÈS IMPORTANT) :',
    '- Utilise "project_context" : tiens compte du projet, de son verdict et de son état',
    '  (dormant, en retard, à dater…). Une tâche qui débloque un projet en difficulté passe avant.',
    '- Une tâche due aujourd’hui ou en retard est prioritaire.',
    '- Une tâche due plus tard (voir "due_in_days" et "due_soon") ne doit pas être sortie de',
    '  son échéance sans raison. Tu peux la proposer aujourd’hui seulement si c’est une petite',
    '  préparation utile, si elle débloque le projet, ou si la journée a vraiment de la place.',
    '- Dans ce cas, explique-le dans "reason" (ex. « préparation pour la tâche due vendredi »).',
    '- Ne propose pas une tâche d’un projet sans lien avec les priorités du jour si la place',
    '  est déjà occupée par des échéances proches.',
    '',
    'Scissions : uniquement pour une tâche SANS sous-tâches (une tâche fourre-tout).',
    'N’essaie JAMAIS de scinder une tâche qui a déjà des sous-tâches (voir "has_subtasks").',
    'Dans ce cas, propose plutôt des échéances pour ses sous-tâches existantes.',
    '',
    'Et, pour une tâche au titre peu clair (voir les retours ci-dessus), un titre plus clair',
    'dans "renames".',
    '',
    'Réponds EXACTEMENT par ce JSON :',
    '{"summary":"phrase décrivant la journée adaptée à son état",',
    ' "proposals":[{"task_id":"...","due_date":"' + digest.date + '","size":"L|M|S","reason":"...","group":"..."}],',
    ' "defer":[{"task_id":"...","due_date":"AAAA-MM-JJ","reason":"..."}],',
    ' "splits":[{"task_id":"...","reason":"...","subtasks":["...","..."]}],',
    ' "renames":[{"task_id":"...","title":"nouveau titre clair","reason":"..."}]}',
    '',
    'Données :',
    JSON.stringify(digest)
  );

  return lines.join('\n');
}

/**
 * Valide la réponse du modèle pour la journée : ajouts bornés à la charge autorisée,
 * reports bornés à la place des jours cibles, scissions.
 */
function validateDayResponse(parsed, snapshot, date, digest, profile) {
  const tasksById = new Map(snapshot.tasks.map((task) => [task.id, task]));
  const allowedIds = new Set(digest.tasks.map((task) => task.id));
  const dayTaskIds = new Set(digest.selected_day_tasks.map((task) => task.id));
  const rule = digest.capacity_rule;

  const never = new Set(profile ? profile.never : []);
  const postpone = new Map((profile ? profile.postpone : []).map((p) => [p.taskId, p.until]));
  const sizeCorrections = new Map((profile ? profile.sizes : []).map((s) => [s.taskId, s.size]));
  const keepToday = new Set(profile && profile.keepToday ? profile.keepToday : []);
  const noSplit = new Set(profile && profile.noSplit ? profile.noSplit : []);
  const noRename = new Set(profile && profile.noRename ? profile.noRename : []);

  const dayRemaining = new Map(
    ((snapshot.capacity && snapshot.capacity.days) || []).map((day) => [
      day.date,
      { ...day.remaining },
    ])
  );

  const addBudget = { ...digest.can_add };
  let deferBudget = Math.min(
    config.aiMaxProposals,
    Math.max(0, total(digest.to_remove))
  );
  const seen = new Set();
  const items = [];

  // Ajouts à la journée.
  for (const raw of Array.isArray(parsed?.proposals) ? parsed.proposals : []) {
    if (items.filter((item) => !item.move).length >= digest.max_proposals) break;
    const taskId = String(raw?.task_id || '');
    if (!allowedIds.has(taskId) || seen.has(taskId) || never.has(taskId)) continue;

    const due = String(raw?.due_date || '').trim();
    if (due !== date) continue;

    const task = tasksById.get(taskId);
    if (!task || task.project_archived || task.due_date === date) continue;

    // Respecte un report demandé par l'utilisateur (« pas avant telle date »).
    const until = postpone.get(taskId);
    if (until && date < until) continue;

    // La taille corrigée par l'utilisateur prime sur l'estimation.
    const size = sizeCorrections.get(taskId) || (['L', 'M', 'S'].includes(raw?.size)
      ? raw.size
      : estimateTaskSize(task, task.subtask_count || 0));
    if (addBudget[size] <= 0) continue;
    addBudget[size] -= 1;

    const reason = String(raw?.reason || '').trim().slice(0, 300);
    const group = raw?.group ? String(raw.group).trim().slice(0, 40) : null;
    seen.add(taskId);

    items.push({
      id: `ai:set_due_date:${taskId}:${hashId([date, reason, group || '', size])}`,
      type: 'set_due_date',
      type_label: 'Placer',
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

  // Reports de tâches déjà prévues ce jour vers un autre jour.
  for (const raw of Array.isArray(parsed?.defer) ? parsed.defer : []) {
    if (deferBudget <= 0) break;
    const taskId = String(raw?.task_id || '');
    if (!dayTaskIds.has(taskId) || seen.has(taskId)) continue;
    // La personne a dit qu'elle GARDE cette tâche aujourd'hui : pas de report.
    if (keepToday.has(taskId)) continue;

    const due = String(raw?.due_date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || due === date) continue;

    const slot = dayRemaining.get(due);
    if (!slot) continue;

    const task = tasksById.get(taskId);
    if (!task || task.due_date !== date) continue;
    if (never.has(taskId)) continue;
    const until = postpone.get(taskId);
    if (until && due < until) continue;

    const size = estimateTaskSize(task, task.subtask_count || 0);
    if (slot[size] <= 0) continue;
    slot[size] -= 1;
    deferBudget -= 1;

    const reason = String(raw?.reason || '').trim().slice(0, 300);
    seen.add(taskId);

    items.push({
      id: `ai:defer:${taskId}:${hashId([due, reason])}`,
      type: 'set_due_date',
      type_label: 'Reporter',
      source: 'ai',
      move: true,
      tone: 'muted',
      score: 70,
      size,
      size_label: SIZE_LABELS[size],
      title: 'Reporter à plus tard',
      rationale: reason || 'Journée trop chargée : à reporter.',
      ai_group: null,
      target: targetFromTask(task),
      action: { due_date: due },
      editable: ['due_date'],
      preview: `Reporter au ${due}`,
      format: 'date',
    });
  }

  // Scissions.
  const splits = [];
  for (const raw of config.aiAllowSplits && Array.isArray(parsed?.splits) ? parsed.splits : []) {
    if (splits.length >= 3) break;
    const taskId = String(raw?.task_id || '');
    if (seen.has(taskId) || (!allowedIds.has(taskId) && !dayTaskIds.has(taskId))) continue;
    const task = tasksById.get(taskId);
    if (!task || task.project_archived) continue;
    // On ne scinde jamais une tâche qui a déjà des sous-tâches, ni une tâche « jamais »
    // ni une tâche que la personne ne veut pas voir découpée.
    if ((task.subtask_count || 0) > 0 || never.has(taskId) || noSplit.has(taskId)) continue;

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

  // Reformulations de titres peu clairs.
  const renames = [];
  for (const raw of Array.isArray(parsed?.renames) ? parsed.renames : []) {
    if (renames.length >= 3) break;
    const taskId = String(raw?.task_id || '');
    if (seen.has(taskId)) continue;
    if (!allowedIds.has(taskId) && !dayTaskIds.has(taskId)) continue;
    const task = tasksById.get(taskId);
    if (!task || task.project_archived) continue;
    if (never.has(taskId) || noRename.has(taskId)) continue;

    const title = String(raw?.title || '').trim().slice(0, 160);
    const current = String(task.display_title || task.content || '').trim();
    if (title.length < 3 || title === current) continue;

    seen.add(taskId);
    renames.push({
      id: `ai:rename_task:${taskId}:${hashId([title])}`,
      type: 'rename_task',
      type_label: 'Reformuler',
      source: 'ai',
      tone: 'warn',
      score: 42,
      size: null,
      size_label: null,
      title: 'Reformuler le titre',
      rationale: String(raw?.reason || '').trim().slice(0, 300) || 'Titre plus clair proposé.',
      ai_group: null,
      target: targetFromTask(task),
      action: { content: title },
      editable: [],
      preview: `Titre → « ${title} »`,
      format: 'rename',
    });
  }

  const rawCount =
    (Array.isArray(parsed?.proposals) ? parsed.proposals.length : 0) +
    (Array.isArray(parsed?.defer) ? parsed.defer.length : 0);

  return { items, splits, renames, dropped: Math.max(0, rawCount - items.length) };
}

/** Génère (ou récupère) les propositions pour une journée, avec check-in et retours. */
async function generateDayProposals(snapshot, date, { force = false, checkin = null, feedback = null } = {}) {
  if (!config.aiEnabled) {
    throw new AiError('AI_DISABLED', 'L’IA n’est pas configurée (OPENROUTER_API_KEY manquant).');
  }

  const answers = normalizeCheckin(checkin);
  const profile = buildProfile(normalizeFeedback(feedback), snapshot.meta.today);
  const digest = buildDayDigest(snapshot, date, answers, profile);
  const signature = signatureOf(digest);
  const cached = dayCache.get(date);

  const fresh =
    cached &&
    cached.signature === signature &&
    (config.aiCacheTtlMs === 0 || Date.now() - cached.generatedAt < config.aiCacheTtlMs);

  if (fresh && !force) {
    return { ...cached, cached: true };
  }

  const canAdd = total(digest.can_add);
  const toRemove = total(digest.to_remove);
  if (canAdd <= 0 && toRemove <= 0) {
    const empty = {
      signature,
      items: [],
      splits: [],
      renames: [],
      summary:
        canAdd === 0 && toRemove === 0
          ? 'Cette journée correspond déjà à ta charge autorisée.'
          : 'Rien à ajuster pour cette journée.',
      generatedAt: Date.now(),
      usage: null,
      model: null,
      checkin: digest.checkin,
      allowed: digest.allowed,
    };
    dayCache.set(date, empty);
    return { ...empty, cached: false };
  }

  const { data, usage, model } = await chatJson({
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(digest),
  });

  const { items, splits, renames, dropped } = validateDayResponse(data, snapshot, date, digest, profile);

  let summary = typeof data?.summary === 'string' ? data.summary.trim().slice(0, 400) : null;
  if (dropped > 0) {
    summary = `${summary ? `${summary} ` : ''}(${dropped} proposition(s) écartée(s) : charge non respectée.)`;
  }

  const entry = {
    signature,
    items,
    splits,
    renames,
    summary,
    generatedAt: Date.now(),
    usage,
    model,
    checkin: digest.checkin,
    allowed: digest.allowed,
  };
  dayCache.set(date, entry);
  rememberItems([...items, ...splits, ...renames]);

  return { ...entry, cached: false };
}

/** Résumé d'une journée selon le check-in (sans IA). */
function describeDay(snapshot, date, checkin) {
  const info = dayInfo(snapshot, date);
  const { allowed, label, notes } = computeAllowed(checkin, info.rule);
  const canAdd = {
    L: Math.max(0, allowed.L - info.load.L),
    M: Math.max(0, allowed.M - info.load.M),
    S: Math.max(0, allowed.S - info.load.S),
  };
  const toRemove = {
    L: Math.max(0, info.load.L - allowed.L),
    M: Math.max(0, info.load.M - allowed.M),
    S: Math.max(0, info.load.S - allowed.S),
  };
  return { ...info, allowed, canAdd, toRemove, label, notes };
}

/**
 * Consultation (lecture seule) : renvoie les propositions déjà calculées pour une
 * journée si l'empreinte (données + check-in) correspond, SINON rien — sans jamais
 * appeler le modèle. C'est ce quasi-lecture sur rechargement qui conserve les
 * propositions existantes sans en recréer de nouvelles.
 */
function peekDayPlan(snapshot, date, checkin, feedback) {
  if (!snapshot) return null;
  const answers = normalizeCheckin(checkin);
  const profile = buildProfile(normalizeFeedback(feedback), snapshot.meta.today);
  const digest = buildDayDigest(snapshot, date, answers, profile);
  const signature = signatureOf(digest);
  const entry = dayCache.get(date);

  const fresh =
    entry &&
    entry.signature === signature &&
    (config.aiCacheTtlMs === 0 || Date.now() - entry.generatedAt < config.aiCacheTtlMs);

  if (fresh) {
    return {
      items: entry.items || [],
      splits: entry.splits || [],
      renames: entry.renames || [],
      summary: entry.summary || null,
      strategy: entry.summary || null,
      checkin: entry.checkin || null,
      allowed: entry.allowed || null,
      cached: true,
      generatedAt: entry.generatedAt || null,
    };
  }
  return null;
}

module.exports = {
  SYSTEM_PROMPT,
  buildDayDigest,
  buildUserPrompt,
  validateDayResponse,
  dayInfo,
  describeDay,
  peekDayPlan,
  generateDayProposals,
  findAiProposal,
  removeAiProposal,
  clearAiCache,
  rememberItems,
};
