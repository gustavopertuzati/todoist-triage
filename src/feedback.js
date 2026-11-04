'use strict';

/**
 * Retour sur les propositions ignorées (itérations 10 et 11).
 *
 * Le questionnaire s'ADAPTE au type de proposition :
 *   - « place » (ajouter une tâche à un jour) : pourquoi pas maintenant / quand / taille ;
 *   - « defer » (reporter une tâche hors du jour) : pourquoi la GARDER aujourd'hui et
 *     comment l'ADAPTER (découper, version courte, garder telle quelle…) ;
 *   - « split » (découper) : pourquoi pas de découpage, et quoi faire à la place ;
 *   - « rename » (reformuler) : le titre convient-il ;
 *   - « cleanup » (archiver/supprimer) : pourquoi la garder.
 *
 * Les réponses servent à ne plus reproposer (ou pas avant une date), à corriger la
 * taille, et à orienter l'IA (identifiée pour « à améliorer », adaptation demandée…).
 *
 * Module pur : normalisation des réponses + profil exploitable.
 */

const { addDaysIso, isValidIsoDate } = require('./dates');

const WINDOWS = [
  { value: 'tomorrow', label: 'Demain', days: 1 },
  { value: 'this_week', label: 'Cette semaine', days: 4 },
  { value: 'next_week', label: 'La semaine prochaine', days: 10 },
  { value: 'weekend', label: 'Ce week-end', days: 5 },
  { value: 'never', label: 'Jamais', days: null },
];

const SIZES = [
  { value: 'S', label: 'Petit' },
  { value: 'M', label: 'Moyen' },
  { value: 'L', label: 'Gros' },
];

const SCOPES = [
  { value: 'once', label: 'Juste cette fois' },
  { value: 'always', label: 'Toujours pour cette tâche' },
];

const QUESTIONNAIRES = {
  place: {
    title: 'Pourquoi tu l’ignores ?',
    questions: [
      {
        key: 'reason',
        label: 'Pourquoi ?',
        options: [
          { value: 'now', label: 'Pas maintenant' },
          { value: 'wrong_day', label: 'Pas le bon jour' },
          { value: 'too_big', label: 'Trop gros pour aujourd’hui' },
          { value: 'not_priority', label: 'Pas prioritaire' },
          { value: 'unclear', label: 'Titre pas clair' },
          { value: 'done', label: 'Déjà fait / obsolète' },
          { value: 'never', label: 'Ne plus la proposer' },
        ],
      },
      { key: 'window', label: 'Quand la revoir ?', options: WINDOWS, showIf: { key: 'reason', in: ['now', 'wrong_day', 'not_priority'] } },
      { key: 'size', label: 'Sa taille ?', options: SIZES, showIf: { key: 'reason', in: ['too_big'] } },
      { key: 'scope', label: 'Valable', options: SCOPES },
    ],
    quick: [
      { label: '⏳ Plus tard', entry: { reason: 'now', window: 'this_week' } },
      { label: '🚫 Jamais', entry: { reason: 'never' } },
    ],
  },

  defer: {
    title: 'Tu la gardes aujourd’hui ?',
    questions: [
      {
        key: 'reason',
        label: 'Pourquoi la garder aujourd’hui ?',
        options: [
          { value: 'deadline', label: 'Date limite aujourd’hui' },
          { value: 'someone', label: 'Quelqu’un l’attend' },
          { value: 'quick', label: 'C’est très rapide' },
          { value: 'important', label: 'Important pour moi' },
          { value: 'can_wait', label: 'En fait, ça peut attendre' },
        ],
      },
      { key: 'window', label: 'Alors quand ?', options: WINDOWS, showIf: { key: 'reason', in: ['can_wait'] } },
      {
        key: 'adapt',
        label: 'Comment l’adapter ?',
        options: [
          { value: 'split', label: 'La découper, ne garder que l’essentiel' },
          { value: 'shorten', label: 'Faire une version courte' },
          { value: 'swap', label: 'La garder et reporter autre chose' },
          { value: 'keep', label: 'La garder telle quelle' },
        ],
        showIf: { key: 'reason', in: ['deadline', 'someone', 'quick', 'important'] },
      },
      { key: 'scope', label: 'Valable', options: SCOPES },
    ],
    quick: [
      { label: '📍 J’y tiens aujourd’hui', entry: { reason: 'important', adapt: 'keep' } },
      { label: '➡️ Ça peut attendre', entry: { reason: 'can_wait', window: 'this_week' } },
    ],
  },

  split: {
    title: 'Pourquoi pas de découpage ?',
    questions: [
      {
        key: 'reason',
        label: 'Pourquoi ?',
        options: [
          { value: 'already_split', label: 'Déjà assez découpée' },
          { value: 'single', label: 'C’est une seule action' },
          { value: 'too_many', label: 'Trop de sous-tâches' },
          { value: 'not_now', label: 'Pas le bon moment' },
          { value: 'unclear', label: 'Je ne vois pas comment' },
        ],
      },
      {
        key: 'alt',
        label: 'Que faire à la place ?',
        options: [
          { value: 'rename', label: 'Juste reformuler le titre' },
          { value: 'schedule', label: 'Juste choisir une date' },
          { value: 'delete', label: 'L’abandonner' },
          { value: 'nothing', label: 'Rien pour l’instant' },
        ],
      },
      { key: 'scope', label: 'Valable', options: SCOPES },
    ],
    quick: [
      { label: '✂️ Déjà assez découpée', entry: { reason: 'already_split', alt: 'nothing', scope: 'always' } },
      { label: '🕐 Pas maintenant', entry: { reason: 'not_now', alt: 'nothing' } },
    ],
  },

  rename: {
    title: 'Le titre te convient ?',
    questions: [
      {
        key: 'reason',
        label: 'Pourquoi ?',
        options: [
          { value: 'fine', label: 'Le titre me va' },
          { value: 'no_idea', label: 'Je ne sais pas quoi mettre' },
          { value: 'different', label: 'Je préfère l’écrire moi-même' },
          { value: 'useless', label: 'Cette tâche ne sert à rien' },
        ],
      },
      { key: 'scope', label: 'Valable', options: SCOPES },
    ],
    quick: [
      { label: '✅ Le titre me va', entry: { reason: 'fine', scope: 'always' } },
      { label: '🗑️ Tâche inutile', entry: { reason: 'useless', scope: 'always' } },
    ],
  },

  cleanup: {
    title: 'Pourquoi la garder ?',
    questions: [
      {
        key: 'reason',
        label: 'Pourquoi ?',
        options: [
          { value: 'useful', label: 'Encore utile' },
          { value: 'not_dup', label: 'Ce n’est pas un doublon' },
          { value: 'active', label: 'Le projet est encore actif' },
          { value: 'later', label: 'Je verrai plus tard' },
        ],
      },
      { key: 'scope', label: 'Valable', options: SCOPES },
    ],
    quick: [
      { label: '👍 Encore utile', entry: { reason: 'useful', scope: 'always' } },
      { label: '⏳ Plus tard', entry: { reason: 'later' } },
    ],
  },
};

const KINDS = Object.keys(QUESTIONNAIRES);

/** Type de questionnaire adapté à une proposition. */
function kindForProposal(proposal) {
  if (!proposal || typeof proposal !== 'object') return 'place';
  if (proposal.type === 'delete_task' || proposal.type === 'archive_project') return 'cleanup';
  if (proposal.type === 'split_task') return 'split';
  if (proposal.type === 'rename_task') return 'rename';
  if (proposal.type === 'set_due_date' && proposal.move) return 'defer';
  return 'place';
}

const REASON_TEXT = {
  // place
  now: 'pas maintenant',
  wrong_day: 'pas le bon jour',
  too_big: 'trop gros',
  not_priority: 'pas prioritaire',
  unclear: 'titre pas clair',
  done: 'déjà fait',
  never: 'ne plus proposer',
  // defer
  deadline: 'date limite aujourd’hui',
  someone: 'quelqu’un l’attend',
  quick: 'très rapide',
  important: 'important aujourd’hui',
  can_wait: 'peut attendre',
  // split
  already_split: 'déjà assez découpée',
  single: 'action unique',
  too_many: 'trop de sous-tâches',
  not_now: 'pas le bon moment',
  // rename
  fine: 'titre ok',
  no_idea: 'pas d’idée de titre',
  different: 'titre écrit soi-même',
  useless: 'tâche inutile',
  // cleanup
  useful: 'encore utile',
  not_dup: 'pas un doublon',
  active: 'projet encore actif',
  later: 'plus tard',
};

const ADAPT_TEXT = {
  split: 'découper en sous-tâches',
  shorten: 'version courte',
  swap: 'garder et reporter autre chose',
  keep: 'garder telle quelle',
};

function optionsFor(kind, key) {
  const q = QUESTIONNAIRES[kind];
  const question = q && q.questions.find((item) => item.key === key);
  return question ? question.options : [];
}

function isAllowed(kind, key, value) {
  return optionsFor(kind, key).some((option) => option.value === value);
}

/** Valide et normalise une entrée de feedback reçue du client. */
function normalizeEntry(input) {
  if (!input || typeof input !== 'object') return null;
  const taskId = String(input.taskId || '').trim();
  if (!taskId) return null;

  const kind = KINDS.includes(input.kind) ? input.kind : 'place';
  const reason = isAllowed(kind, 'reason', input.reason) ? input.reason : null;
  if (!reason) return null;

  const entry = {
    taskId,
    kind,
    reason,
    window: isAllowed(kind, 'window', input.window) ? input.window : null,
    size: isAllowed(kind, 'size', input.size) ? input.size : null,
    adapt: isAllowed(kind, 'adapt', input.adapt) ? input.adapt : null,
    alt: isAllowed(kind, 'alt', input.alt) ? input.alt : null,
    scope: isAllowed(kind, 'scope', input.scope) ? input.scope : 'once',
    title: typeof input.title === 'string' ? input.title.slice(0, 120) : null,
    at: typeof input.at === 'string' && !Number.isNaN(Date.parse(input.at)) ? input.at : new Date().toISOString(),
  };
  return entry;
}

function normalizeFeedback(list) {
  if (!Array.isArray(list)) return [];
  const byTask = new Map();
  for (const raw of list) {
    const entry = normalizeEntry(raw);
    if (!entry) continue;
    const previous = byTask.get(entry.taskId);
    // La dernière réponse pour une tâche l'emporte.
    if (!previous || entry.at >= previous.at) byTask.set(entry.taskId, entry);
  }
  return [...byTask.values()];
}

function addSet(set, id) {
  set.add(id);
}

/**
 * Déduit un profil exploitable depuis les réponses.
 * @param {object[]} entries
 * @param {string} today
 */
function buildProfile(entries, today) {
  const list = Array.isArray(entries) ? entries : [];
  const validToday = isValidIsoDate(today) ? today : null;

  const never = new Set();
  const postpone = new Map();
  const sizes = new Map();
  const improve = new Map();
  const keepToday = new Set();
  const adaptation = new Map();
  const noSplit = new Set();
  const noRename = new Set();
  const noCleanup = new Set();
  const signals = {};
  const titles = new Map();

  const withWindow = (taskId, window) => {
    const def = WINDOWS.find((w) => w.value === window);
    if (!def || !validToday) return false;
    if (def.value === 'never') {
      addSet(never, taskId);
      return true;
    }
    if (typeof def.days === 'number') {
      const until = addDaysIso(validToday, def.days);
      const current = postpone.get(taskId);
      if (!current || until > current) postpone.set(taskId, until);
    }
    return false;
  };

  for (const entry of list) {
    signals[entry.reason] = (signals[entry.reason] || 0) + 1;
    if (entry.title) titles.set(entry.taskId, entry.title);
    const id = entry.taskId;

    if (entry.kind === 'defer') {
      if (entry.reason === 'can_wait') {
        withWindow(id, entry.window || 'this_week');
      } else {
        keepToday.add(id);
        if (entry.adapt) adaptation.set(id, entry.adapt);
      }
      continue;
    }

    if (entry.kind === 'split') {
      if (['already_split', 'single', 'too_many'].includes(entry.reason)) noSplit.add(id);
      if (entry.reason === 'not_now') withWindow(id, entry.window || 'this_week');
      if (entry.reason === 'unclear' || entry.alt === 'rename') improve.set(id, 'unclear');
      if (entry.alt === 'delete') never.add(id);
      if (entry.scope === 'always' && entry.reason !== 'not_now') noSplit.add(id);
      continue;
    }

    if (entry.kind === 'rename') {
      if (['fine', 'no_idea', 'different'].includes(entry.reason)) noRename.add(id);
      if (entry.reason === 'useless') never.add(id);
      continue;
    }

    if (entry.kind === 'cleanup') {
      noCleanup.add(id);
      continue;
    }

    // kind === 'place'
    if (entry.reason === 'never') {
      never.add(id);
      continue;
    }
    if (entry.window && withWindow(id, entry.window)) continue;
    if (entry.scope === 'always' && ['done', 'not_priority'].includes(entry.reason)) {
      never.add(id);
      continue;
    }
    if (entry.size) sizes.set(id, entry.size);
    if (['unclear', 'too_big'].includes(entry.reason)) improve.set(id, entry.reason);
  }

  // Nettoyage : les reports sans date (marqueur null) sont retirés.
  const postponeClean = [...postpone.entries()].filter(([, until]) => typeof until === 'string');

  return {
    never: [...never],
    postpone: postponeClean.map(([taskId, until]) => ({ taskId, until })),
    sizes: [...sizes.entries()].map(([taskId, size]) => ({ taskId, size })),
    improve: [...improve.entries()].map(([taskId, reason]) => ({ taskId, reason })),
    keepToday: [...keepToday],
    adaptation: [...adaptation.entries()].map(([taskId, mode]) => ({ taskId, mode })),
    noSplit: [...noSplit],
    noRename: [...noRename],
    noCleanup: [...noCleanup],
    titles: Object.fromEntries(titles),
    signals,
    count: list.length,
  };
}

/** Traduit le profil en bloc compact pour l'invite de l'IA. */
function describeForPrompt(profile) {
  if (!profile || profile.count === 0) return null;
  const title = (id) => profile.titles[id] || 'tâche inconnue';

  return {
    ne_pas_proposer: profile.never.map((id) => title(id)),
    reporter_apres: profile.postpone.map((p) => ({ tache: title(p.taskId), apres: p.until })),
    taille_reelle: profile.sizes.map((s) => ({ tache: title(s.taskId), taille: s.size })),
    a_ameliorer: profile.improve.map((i) => ({ tache: title(i.taskId), pourquoi: REASON_TEXT[i.reason] || i.reason })),
    garder_aujourdhui: profile.keepToday.map((id) => ({
      tache: title(id),
      adapter: (profile.adaptation.find((a) => a.taskId === id) || {}).mode || 'keep',
    })),
    ne_pas_decouper: profile.noSplit.map((id) => title(id)),
    ne_pas_renommer: profile.noRename.map((id) => title(id)),
    ne_pas_nettoyer: profile.noCleanup.map((id) => title(id)),
    signaux: profile.signals,
  };
}

module.exports = {
  WINDOWS,
  SIZES,
  SCOPES,
  QUESTIONNAIRES,
  KINDS,
  kindForProposal,
  normalizeEntry,
  normalizeFeedback,
  buildProfile,
  describeForPrompt,
  REASON_TEXT,
  ADAPT_TEXT,
};
