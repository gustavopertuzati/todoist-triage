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
const { todayInTimeZone, addDaysIso } = require('./dates');
const { timeMode, clockOf } = require('./timeMode');

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

/** Temps d'attente passive : 0 à 480 min, jamais négatif. */
function normalizeWait(value) {
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes > 0
    ? Math.min(480, Math.round(minutes))
    : 0;
}

/** Temps de préparation avant une apparition publique (30 min par défaut). */
function normalizePrep(value, isPublic) {
  if (!isPublic) return 0;
  const minutes = Number(value);
  if (Number.isFinite(minutes) && minutes > 0) {
    return Math.min(120, Math.round(minutes));
  }
  return 30;
}

function formatMinutes(total) {
  const minutes = Math.max(0, Math.round(total));
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function parseTime(value, fallback) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''));
  if (!match) return fallback;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return fallback;
  return hours * 60 + minutes;
}

/** Normalise les horaires et pauses reçus du client. */
function normalizeSchedule(input = {}) {
  const rawPhone = parseTime(input.phoneStart ?? input.start, 9 * 60);
  const rawOther = parseTime(input.otherStart, 11 * 60);
  const rawEnd = parseTime(input.end, 17 * 60);
  const rawBreak = Number(input.breakMinutes);
  const breakMinutes = Number.isFinite(rawBreak)
    ? Math.min(120, Math.max(0, Math.round(rawBreak)))
    : 10;

  let phoneStart = rawPhone;
  let end = rawEnd;
  if (phoneStart >= end) phoneStart = 9 * 60;
  if (end <= phoneStart) end = 17 * 60;

  let otherStart = Math.max(rawOther, phoneStart);
  if (otherStart >= end) otherStart = Math.max(phoneStart, end - 60);

  let lunchStart = parseTime(input.lunchStart, 12 * 60);
  let lunchEnd = parseTime(input.lunchEnd, 13 * 60);
  if (lunchEnd <= lunchStart) {
    lunchStart = 12 * 60;
    lunchEnd = 13 * 60;
  }

  return {
    phoneStart: formatMinutes(phoneStart),
    otherStart: formatMinutes(otherStart),
    end: formatMinutes(end),
    breakMinutes,
    lunchStart: formatMinutes(lunchStart),
    lunchEnd: formatMinutes(lunchEnd),
  };
}

/** Heure courante (minutes depuis minuit) dans un fuseau donné. */
function clockMinutesInTimeZone(timeZone, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const value = (type) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0) || 0;
  return (value('hour') % 24) * 60 + value('minute');
}

/**
 * Pour la journée en cours, un horaire de début déjà passé est décalé à
 * l'heure actuelle (arrondie aux 5 minutes suivantes). Les jours passés ou
 * futurs ne bougent pas. L'heure de fin n'est pas modifiée : après la fin de
 * journée, on laisse le plan tel que l'utilisateur l'a réglé.
 */
function clampScheduleToNow(schedule, date, { timeZone = config.timezone, now = new Date() } = {}) {
  if (!date || date !== todayInTimeZone(timeZone, now)) return schedule;

  const end = parseTime(schedule.end, 17 * 60);
  const nowMinutes = Math.ceil(clockMinutesInTimeZone(timeZone, now) / 5) * 5;
  if (nowMinutes >= end) return schedule;

  const phoneStart = Math.max(parseTime(schedule.phoneStart, 9 * 60), nowMinutes);
  const otherStart = Math.max(parseTime(schedule.otherStart, 11 * 60), phoneStart);
  return {
    ...schedule,
    phoneStart: formatMinutes(phoneStart),
    otherStart: formatMinutes(otherStart),
  };
}

/** Décale une tâche pour ne jamais chevaucher la pause déjeuner. */
function avoidLunch(start, minutes, lunchStart, lunchEnd) {
  if (lunchEnd <= lunchStart) return start;
  const end = start + minutes;
  if (start >= lunchStart && start < lunchEnd) return lunchEnd;
  if (start < lunchStart && end > lunchStart) return lunchEnd;
  return start;
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
    parent_id: task.parent_id || null,
    is_subtask: Boolean(task.parent_id),
    depth: 0,
    time_mode: timeMode(task),
    fixed_time: timeMode(task) === 'fixed' ? clockOf(task) : null,
    parent_title: parentTitle ? parentTitle.slice(0, 120) : null,
    labels: (task.labels || []).slice(0, 5),
    note: String(task.description || '').slice(0, 220) || null,
  };
}

/** Ordre stable des enfants d'un même parent (comme l'interface Todoist). */
function sortChildren(a, b) {
  return (
    String(a.order_key || '').localeCompare(String(b.order_key || '')) ||
    Number(a.child_order ?? 0) - Number(b.child_order ?? 0) ||
    String(a.display_title || a.content || '').localeCompare(
      String(b.display_title || b.content || ''),
      'fr-FR'
    )
  );
}

/**
 * Tâches visibles pour ce jour : principales + préparations, avec **tout
 * l'arbre de leurs sous-tâches** (tous niveaux), même si une sous-tâche n'a pas
 * d'échéance ce jour-là. L'ordre les place ensuite avant leur parent.
 */
function listDayTasks(snapshot, date) {
  const today = snapshot.meta.today;
  const isToday = date === today;
  const all = (snapshot.tasks || []).filter((task) => !task.project_archived);
  const byId = new Map(all.map((task) => [task.id, task]));
  const childrenByParent = new Map();
  for (const task of all) {
    if (!task.parent_id || !byId.has(task.parent_id)) continue;
    if (!childrenByParent.has(task.parent_id)) childrenByParent.set(task.parent_id, []);
    childrenByParent.get(task.parent_id).push(task);
  }
  for (const list of childrenByParent.values()) list.sort(sortChildren);

  const seen = new Set();
  const tasks = [];

  const addSubtree = (task, depth) => {
    if (!task || seen.has(task.id) || tasks.length >= MAX_TASKS) return;
    seen.add(task.id);
    const parent = task.parent_id ? byId.get(task.parent_id) : null;
    const meta = taskMeta(task, parent ? titleOf(parent) : null);
    meta.depth = depth;
    meta.is_subtask = Boolean(parent);
    tasks.push(meta);
    for (const child of childrenByParent.get(task.id) || []) addSubtree(child, depth + 1);
  };

  for (const task of all) {
    // Toute tâche due ce jour compte, y compris une sous-tâche dont le parent
    // n'est pas planifié aujourd'hui. Ses propres sous-tâches suivent.
    const onDay = task.due_date === date;
    const overdue = isToday && task.is_overdue && task.due_date !== date;
    if (!onDay && !overdue) continue;
    addSubtree(task, 0);
    if (tasks.length >= MAX_TASKS) break;
  }

  // Une tâche dont une sous-tâche est planifiée doit apparaître comme parent,
  // même si sa propre échéance est demain : sinon elle ne peut pas finir après
  // la dernière sous-tâche. On s'arrête aux parents proches (au plus demain)
  // pour ne pas tirer un projet lointain dans la journée.
  const horizon = addDaysIso(date, 1);
  for (const task of [...tasks]) {
    let current = byId.get(task.parent_id);
    const guard = new Set([task.id]);
    while (current && !seen.has(current.id) && !guard.has(current.id)) {
      guard.add(current.id);
      const due = (current.due_date || '').slice(0, 10);
      if (due && due > horizon) break;
      seen.add(current.id);
      const parent = current.parent_id ? byId.get(current.parent_id) : null;
      const meta = taskMeta(current, parent ? titleOf(parent) : null);
      meta.depth = 0;
      tasks.push(meta);
      if (tasks.length >= MAX_TASKS) break;
      current = byId.get(current.parent_id);
    }
  }

  // Profondeur réelle une fois l'arbre du jour constitué (une sous-tâche dont
  // le parent n'est pas dans le plan redevient une racine).
  for (const task of tasks) {
    let depth = 0;
    let current = byId.get(task.parent_id);
    const guard = new Set([task.id]);
    while (current && seen.has(current.id) && !guard.has(current.id)) {
      guard.add(current.id);
      depth += 1;
      current = byId.get(current.parent_id);
    }
    task.depth = depth;
    task.is_subtask = Boolean(task.parent_id && seen.has(task.parent_id));
  }

  return tasks;
}

/**
 * Réordonne une liste pour qu'aucune tâche ne passe avant ses sous-tâches :
 * parcours post-ordre (niveau le plus profond d'abord, puis le parent).
 * L'ordre relatif fourni (priorité, IA, manuel) est conservé entre frères.
 */
function subtasksFirstOrder(tasks) {
  if (!Array.isArray(tasks) || tasks.length < 2) return Array.isArray(tasks) ? tasks : [];
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const children = new Map();
  const roots = [];
  for (const task of tasks) {
    if (task.parent_id && byId.has(task.parent_id)) {
      if (!children.has(task.parent_id)) children.set(task.parent_id, []);
      children.get(task.parent_id).push(task);
    } else {
      roots.push(task);
    }
  }
  if (children.size === 0) return tasks;

  const out = [];
  const visit = (task) => {
    for (const child of children.get(task.id) || []) visit(child);
    out.push(task);
  };
  for (const root of roots) visit(root);
  return out.length === tasks.length ? out : tasks;
}

/** Ordre de priorité : P1 d'abord, puis retards, puis titre, sous-tâches avant parent. */
function priorityOrder(tasks) {
  const sorted = [...tasks].sort(
    (a, b) =>
      (b.priority || 1) - (a.priority || 1) ||
      Number(b.overdue) - Number(a.overdue) ||
      a.title.localeCompare(b.title, 'fr-FR')
  );
  return subtasksFirstOrder(sorted);
}

/** Applique l'ordre « sous-tâches d'abord » à une exécution {id,...}. */
function orderExecution(execution, tasks) {
  if (!Array.isArray(execution) || execution.length < 2) return execution;
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const entries = new Map(execution.map((entry) => [entry.id, entry]));
  const taskList = execution.map((entry) => byId.get(entry.id)).filter(Boolean);
  if (taskList.length < 2) return execution;

  const ordered = subtasksFirstOrder(taskList);
  const placed = new Set(ordered.map((task) => task.id));
  return [
    ...ordered.map((task) => entries.get(task.id)).filter(Boolean),
    ...execution.filter((entry) => !placed.has(entry.id)),
  ];
}

function buildDayOrderDigest(tasks, date, schedule = null, instruction = '') {
  return {
    date,
    schedule: normalizeSchedule(schedule || {}),
    instruction: String(instruction || '').trim().slice(0, 500) || null,
    profile: {
      public_prep: true,
      default_prep_minutes: 30,
      note: 'Prévoir douche/soin/tenue avant une apparition publique.',
    },
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      priority: task.priority_label,
      size: task.size,
      minutes_hint: task.minutes,
      context_hint: task.context,
      wait_minutes_hint: task.wait_minutes || 0,
      parallel_hint: Array.isArray(task.parallel_with) ? task.parallel_with : [],
      public_hint: Boolean(task.public),
      prep_minutes_hint: task.prep_minutes || 0,
      time_mode_hint: task.time_mode || 'untimed',
      fixed_time: task.fixed_time || null,
      overdue: task.overdue,
      is_preparation: task.is_prep,
      is_subtask: Boolean(task.is_subtask),
      depth: task.depth || 0,
      parent: task.parent_title,
      labels: task.labels,
      note: task.note,
    })),
  };
}

function buildOrderPrompt(digest) {
  const lines = [
    `Ordonne les tâches du ${digest.date} pour une exécution réelle.`,
    '',
    'Règles :',
    '- Les préparations (is_preparation) passent avant la tâche parente concernée.',
    '- Une sous-tâche passe TOUJOURS avant sa tâche parente. Commence par le niveau le plus profond, puis remonte niveau par niveau jusqu’à la tâche racine.',
    '- Les tâches dont time_mode_hint vaut "fixed" ont un horaire imposé : ne les déplace pas et garde-les à leur heure.',
    '- Respecte les dépendances logiques et les prérequis.',
    '- Commence par ce qui est urgent/en retard, puis les priorités hautes.',
    '- Alterne les grosses tâches avec des petites si c’est plus réaliste.',
    '- Ne tiens pas compte des tâches qui ne sont pas dans la liste.',
    '- Utilise chaque identifiant exactement une fois.',
    '- Cherche les temps d’attente passive (machine à laver, four, cuisson, séchage, pousse, trempage, téléchargement, réponse à attendre…). Pour ces tâches, mets le temps ACTIF dans "minutes" et le temps passif dans "wait_minutes" (0 à 480).',
    '- Si une autre tâche peut être faite pendant cette attente, liste jusqu’à 3 identifiants dans "parallel_with" et place ces tâches juste après dans l’ordre, pour remplir le temps mort.',
    '- "parallel_with" ne contient que des identifiants de la liste, jamais la tâche elle-même.',
    '- Profil : la personne est réservée en public et a besoin d’un temps de préparation (douche, soin, tenue) avant de se montrer. Pour toute tâche publique (rendez-vous, entretien, cours, présentation, réunion, guichet, sortie, photo, événement…), mets "public": true et "prep_minutes": 30 (ou plus).',
    '- S’il existe une tâche de douche, soin ou préparation, place-la juste avant la tâche publique. Ne marque pas "public" une tâche banale.',
    '',
    'Pour chaque tâche :',
    '- estime "minutes" de façon réaliste (5 à 480) d’après le titre, la note, la taille et le contexte ;',
    '- classe "context" parmi phone, computer, home, outside, office, other.',
    '- donne une raison courte (max 10 mots) dans "why".',
    '',
  ];

  if (digest.instruction) {
    lines.push(
      'Consignes impératives de la personne pour cette journée :',
      `« ${digest.instruction} »`,
      'Respecte-les en priorité (matinée, séquence précise, ordre imposé…), sans jamais passer une sous-tâche après sa tâche parente.',
      ''
    );
  }

  lines.push(
    'Réponds EXACTEMENT par ce JSON :',
    '{"summary":"phrase courte expliquant l’ordre",',
    ' "order":[{"id":"...","why":"...","minutes":30,"context":"computer","wait_minutes":0,"parallel_with":[],"public":false,"prep_minutes":0}]}',
    '',
    'Données :',
    JSON.stringify(digest)
  );
  return lines.join('\n');
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

    const waitMinutes = normalizeWait(entry?.wait_minutes);
    const parallelWith = [];
    if (Array.isArray(entry?.parallel_with)) {
      for (const rawId of entry.parallel_with) {
        const parallelId = String(rawId);
        if (parallelId === id || !byId.has(parallelId)) continue;
        if (parallelWith.includes(parallelId)) continue;
        parallelWith.push(parallelId);
        if (parallelWith.length >= 3) break;
      }
    }

    const isPublic = entry?.public === true;
    execution.push({
      id,
      why:
        typeof entry?.why === 'string' && entry.why.trim()
          ? entry.why.trim().slice(0, 120)
          : null,
      minutes: normalizeMinutes(entry?.minutes, fallbackMinutes(task)),
      context,
      wait_minutes: waitMinutes,
      parallel_with: parallelWith,
      public: isPublic,
      prep_minutes: normalizePrep(entry?.prep_minutes, isPublic),
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
        wait_minutes: 0,
        parallel_with: [],
        public: false,
        prep_minutes: 0,
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

function scheduleVariant(
  key,
  label,
  ordered,
  { phoneStart, otherStart, dayEnd, breakMinutes, lunchStart, lunchEnd }
) {
  let cursor = null;
  let lastEnd = null;
  let overflow = 0;
  let stopped = false;
  const items = [];
  const titleById = new Map(ordered.map((task) => [task.id, task.title]));
  const parentIds = new Set(
    ordered.map((task) => task.parent_id).filter((id) => id && titleById.has(id))
  );

  const place = (task) => {
    // Une tâche qui contient des sous-tâches n'a pas son propre créneau :
    // elle se termine avec la dernière sous-tâche de son arbre.
    if (parentIds.has(task.id)) {
      if (stopped || lastEnd === null) {
        items.push({
          id: task.id,
          start: null,
          end: null,
          minutes: 0,
          context: task.context,
          overflow: true,
          unscheduled: true,
          container: true,
          time_mode: task.time_mode || 'untimed',
          fixed: task.time_mode === 'fixed',
          fixed_time: task.fixed_time || null,
        });
        return;
      }
      items.push({
        id: task.id,
        start: formatMinutes(lastEnd),
        end: formatMinutes(lastEnd),
        minutes: 0,
        context: task.context,
        overflow: false,
        unscheduled: false,
        container: true,
        time_mode: task.time_mode || 'untimed',
        fixed: task.time_mode === 'fixed',
        fixed_time: task.fixed_time || null,
      });
      return;
    }

    const minStart = task.context === 'phone' ? phoneStart : otherStart;
    const earliest = cursor === null ? minStart : Math.max(cursor, minStart);
    const prepMinutes = normalizePrep(task.prep_minutes, task.public === true);
    let prepStart = null;
    let prepEnd = null;
    let start = earliest;
    if (!stopped && prepMinutes > 0) {
      prepStart = Math.max(avoidLunch(earliest, prepMinutes, lunchStart, lunchEnd), earliest);
      prepEnd = prepStart + prepMinutes;
      start = prepEnd;
    }
    start = avoidLunch(start, task.minutes, lunchStart, lunchEnd);
    start = Math.max(start, prepEnd === null ? earliest : prepEnd);

    // Plus de place avant la fin de journée : on arrête net. Les tâches
    // suivantes restent non planifiées (et seront proposées au report), au
    // lieu de glisser après minuit.
    if (stopped || start + task.minutes > dayEnd) {
      stopped = true;
      overflow += task.minutes;
      items.push({
        id: task.id,
        start: null,
        end: null,
        minutes: task.minutes,
        context: task.context,
        overflow: true,
        unscheduled: true,
        container: false,
        prep_minutes: prepMinutes,
        public: Boolean(task.public),
        time_mode: task.time_mode || 'untimed',
        fixed: task.time_mode === 'fixed',
        fixed_time: task.fixed_time || null,
      });
      return;
    }

    const end = start + task.minutes;
    const waitMinutes = normalizeWait(task.wait_minutes);
    const parallelIds = (Array.isArray(task.parallel_with) ? task.parallel_with : [])
      .filter((id) => id !== task.id && titleById.has(id))
      .slice(0, 3);
    const ready =
      waitMinutes > 0 && end + waitMinutes <= 23 * 60 + 59
        ? formatMinutes(end + waitMinutes)
        : null;
    lastEnd = end;
    cursor = end + breakMinutes;
    items.push({
      id: task.id,
      start: formatMinutes(start),
      end: formatMinutes(end),
      minutes: task.minutes,
      context: task.context,
      overflow: false,
      unscheduled: false,
      container: false,
      wait_minutes: waitMinutes,
      parallel_ids: parallelIds,
      parallel_titles: parallelIds.map((id) => titleById.get(id)).filter(Boolean),
      ready,
      prep_minutes: prepMinutes,
      public: Boolean(task.public),
      time_mode: task.time_mode || 'untimed',
      fixed: task.time_mode === 'fixed',
      fixed_time: task.fixed_time || null,
    });
  };

  for (const task of ordered) place(task);

  const scheduled = items.filter((item) => item.start && item.end);
  items.sort((a, b) => String(a.start || '99:99').localeCompare(String(b.start || '99:99')));

  return {
    key,
    label,
    start: scheduled.length
      ? scheduled.reduce((min, item) => (item.start < min ? item.start : min), '99:99')
      : null,
    end: scheduled.length
      ? scheduled.reduce((max, item) => (item.end > max ? item.end : max), '00:00')
      : null,
    overflow_minutes: overflow,
    items,
  };
}

/** Préfère les appels tôt, sans jamais passer un parent avant ses sous-tâches. */
function phoneFirstOrder(tasks) {
  return subtasksFirstOrder([
    ...tasks.filter((task) => task.context === 'phone'),
    ...tasks.filter((task) => task.context !== 'phone'),
  ]);
}

/** Trois planifications + une variante décalée (ordre et heure de départ). */
function buildScheduleVariants(tasks, execution, options = {}) {
  if (tasks.length === 0) return [];
  const schedule = normalizeSchedule(options);
  const phoneStart = parseTime(schedule.phoneStart, 9 * 60);
  const otherStart = parseTime(schedule.otherStart, 11 * 60);
  const dayEnd = parseTime(schedule.end, 17 * 60);
  const lunchStart = parseTime(schedule.lunchStart, 12 * 60);
  const lunchEnd = parseTime(schedule.lunchEnd, 13 * 60);
  const breakMinutes = schedule.breakMinutes;

  const byId = new Map(tasks.map((task) => [task.id, task]));
  const executionTasks = subtasksFirstOrder(
    execution.map((entry) => byId.get(entry.id)).filter(Boolean)
  );
  const priorityTasks = priorityOrder(tasks);
  const shortTasks = subtasksFirstOrder(
    [...tasks].sort(
      (a, b) =>
        a.minutes - b.minutes ||
        (b.priority || 1) - (a.priority || 1) ||
        a.title.localeCompare(b.title, 'fr-FR')
    )
  );

  return [
    scheduleVariant('equilibre', 'Exécution', phoneFirstOrder(executionTasks), {
      phoneStart,
      otherStart,
      dayEnd,
      breakMinutes,
      lunchStart,
      lunchEnd,
    }),
    scheduleVariant('priorite', 'Priorité', phoneFirstOrder(priorityTasks), {
      phoneStart,
      otherStart,
      dayEnd,
      breakMinutes,
      lunchStart,
      lunchEnd,
    }),
    scheduleVariant('court', 'Courtes d’abord', phoneFirstOrder(shortTasks), {
      phoneStart,
      otherStart,
      dayEnd,
      breakMinutes,
      lunchStart,
      lunchEnd,
    }),
    scheduleVariant('decale', 'Départ décalé', phoneFirstOrder(executionTasks), {
      phoneStart: Math.min(phoneStart + 60, dayEnd - 60),
      otherStart: Math.min(otherStart + 30, dayEnd - 30),
      dayEnd,
      breakMinutes,
      lunchStart,
      lunchEnd,
    }),
  ];
}

/** Premier jour futur où la taille de la tâche tient encore. */
function suggestPostponeDate(snapshot, date, size) {
  const key = ['L', 'M', 'S'].includes(size) ? size : 'M';
  const rule = (snapshot?.capacity && snapshot.capacity.rule) || config.capacityRule;
  const days = Array.isArray(snapshot?.capacity?.days) ? snapshot.capacity.days : [];
  const future = days
    .filter((day) => day.date > date)
    .sort((a, b) => a.date.localeCompare(b.date));
  for (const day of future) {
    const remaining = day.remaining || rule;
    if ((remaining[key] || 0) > 0) return day.date;
  }
  return addDaysIso(date, 1);
}

/**
 * Tâches qui ne tiennent pas dans la journée, en partant de l'ordre de
 * priorité. Les moins importantes sont proposées au report en premier, mais
 * une tâche importante qui déborde est aussi proposée (l'utilisateur tranche).
 */
function buildPostponePlan(tasks, schedule, snapshot, date) {
  if (!Array.isArray(tasks) || tasks.length === 0) return [];
  const normalized = normalizeSchedule(schedule || {});
  const end = parseTime(normalized.end, 17 * 60);
  const variant = scheduleVariant('priorite', 'Priorité', priorityOrder(tasks), {
    phoneStart: parseTime(normalized.phoneStart, 9 * 60),
    otherStart: parseTime(normalized.otherStart, 11 * 60),
    dayEnd: end,
    breakMinutes: normalized.breakMinutes,
    lunchStart: parseTime(normalized.lunchStart, 12 * 60),
    lunchEnd: parseTime(normalized.lunchEnd, 13 * 60),
  });

  const byId = new Map(tasks.map((task) => [task.id, task]));
  const rootOf = (task) => {
    let current = task;
    const seen = new Set();
    while (current?.parent_id && byId.has(current.parent_id) && !seen.has(current.id)) {
      seen.add(current.id);
      current = byId.get(current.parent_id);
    }
    return current || task;
  };

  // Nombre de tâches de chaque arbre encore planifiées aujourd'hui.
  const scheduledCounts = new Map();
  for (const item of variant.items) {
    if (item.unscheduled || item.container) continue;
    const task = byId.get(item.id);
    if (!task) continue;
    const root = rootOf(task);
    scheduledCounts.set(root.id, (scheduledCounts.get(root.id) || 0) + 1);
  }

  // Regroupe les tâches non planifiées par tâche racine : on reporte la racine,
  // ce qui emporte le reste de son arbre, tout en gardant la partie déjà faite.
  const groups = new Map();
  for (const item of variant.items) {
    if (!item.unscheduled) continue;
    const task = byId.get(item.id);
    if (!task) continue;
    const root = rootOf(task);
    if (!groups.has(root.id)) groups.set(root.id, { root, items: [] });
    groups.get(root.id).items.push(item);
  }

  return [...groups.values()]
    .map(({ root, items }) => {
      const work = items.filter((item) => !item.container);
      const unscheduled = work.reduce((sum, item) => sum + (item.minutes || 0), 0);
      return {
        task_id: root.id,
        title: root.title,
        priority: root.priority,
        priority_label: root.priority_label,
        size: root.size,
        minutes: root.minutes,
        start: null,
        end: null,
        over_minutes: unscheduled,
        unscheduled_count: work.length,
        scheduled_count: scheduledCounts.get(root.id) || 0,
        also_task_ids: items
          .map((item) => item.id)
          .filter((id) => id !== root.id)
          .slice(0, 60),
        due_date: suggestPostponeDate(snapshot, date, root.size),
      };
    })
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        b.over_minutes - a.over_minutes ||
        a.title.localeCompare(b.title, 'fr-FR')
    );
}

/** Ajoute la liste des reports possibles à un résultat d'ordre. */
function withPostpone(result, snapshot, date) {
  const postpone = buildPostponePlan(
    result.tasks || [],
    result.schedule || {},
    snapshot,
    date
  );
  return { ...result, postpone };
}

async function generateDayOrder(
  snapshot,
  date,
  { force = false, schedule = null, useAi = true, instruction = '' } = {}
) {
  const normalizedInstruction = String(instruction || '').trim().slice(0, 500);
  const normalizedSchedule = clampScheduleToNow(
    normalizeSchedule(schedule || {}),
    date
  );
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
    return withPostpone(
      {
        date,
        tasks,
        priority,
        execution: [],
        variants: [],
        schedule: normalizedSchedule,
        changed: 0,
        summary: 'Aucune tâche prévue ce jour-là.',
        cached: false,
        usage: null,
      },
      snapshot,
      date
    );
  }

  if (!useAi || !config.aiEnabled) {
    return withPostpone(
      {
        date,
        tasks,
        priority,
        execution: fallbackExecution,
        variants: buildScheduleVariants(tasks, fallbackExecution, normalizedSchedule),
        schedule: normalizedSchedule,
        changed: 0,
        summary: useAi
          ? 'IA désactivée : ordre de priorité utilisé.'
          : 'Ordre recalculé sans IA : priorité, sous-tâches et horaires.',
        cached: false,
        usage: null,
      },
      snapshot,
      date
    );
  }

  const digest = buildDayOrderDigest(tasks, date, normalizedSchedule, normalizedInstruction);
  const signature = signatureOf(digest);
  const cached = cache.get(String(date));
  const fresh =
    cached &&
    cached.signature === signature &&
    (config.aiCacheTtlMs === 0 || Date.now() - cached.generatedAt < config.aiCacheTtlMs);

  if (fresh && !force) return withPostpone({ ...cached, cached: true }, snapshot, date);

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
    return withPostpone(
      {
        date,
        tasks,
        priority,
        execution: fallbackExecution,
        variants: buildScheduleVariants(tasks, fallbackExecution, normalizedSchedule),
        schedule: normalizedSchedule,
        changed: 0,
        summary: 'IA indisponible : ordre de priorité utilisé.',
        cached: false,
        usage: null,
      },
      snapshot,
      date
    );
  }

  const { execution: aiExecution, changed, summary } = validateOrderResponse(data, tasks);
  // Une sous-tâche passe toujours avant son parent, même si l'IA les a
  // ordonnées autrement (niveau le plus profond d'abord).
  const execution = orderExecution(aiExecution, tasks);
  // Reporte les durées/contextes estimés par l'IA sur les tâches, pour les plans.
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const item of execution) {
    const task = byId.get(item.id);
    if (!task) continue;
    task.minutes = item.minutes;
    task.context = item.context;
    task.wait_minutes = item.wait_minutes || 0;
    task.parallel_with = item.parallel_with || [];
    task.public = Boolean(item.public);
    task.prep_minutes = item.prep_minutes || 0;
  }
  const variants = buildScheduleVariants(tasks, execution, normalizedSchedule);
  const entry = {
    signature,
    date,
    tasks,
    priority,
    execution,
    variants,
    schedule: normalizedSchedule,
    changed,
    summary: summary || 'Ordre proposé selon les priorités et les dépendances.',
    generatedAt: Date.now(),
    usage,
    model,
  };
  cache.set(String(date), entry);

  return withPostpone({ ...entry, cached: false }, snapshot, date);
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
  normalizeSchedule,
  clampScheduleToNow,
  subtasksFirstOrder,
  orderExecution,
  buildScheduleVariants,
  buildPostponePlan,
  suggestPostponeDate,
  estimateMinutes,
  detectContext,
  formatMinutes,
  DEFAULT_MINUTES,
  CONTEXTS,
  generateDayOrder,
  clearDayOrderCache,
  isPreparationTask,
};
