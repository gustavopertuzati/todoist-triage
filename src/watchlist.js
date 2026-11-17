'use strict';

/**
 * Veille technologique issue des notes personnelles (itération 51).
 *
 * Six petits tasks de veille, datés sur des jours creux, proposés dans Triage.
 * Rien n'est écrit dans Todoist avant validation individuelle. Une fois la
 * tâche créée (ou déjà existante), la proposition disparaît.
 */

const { normalizeTitle } = require('./proposals');

const PROJECT_ID = '6fVFQXGQmXGq83WF'; // 🧠 QG – Vie Gustavo
const PROJECT_NAME = 'QG – Vie Gustavo';

const WATCH_TASKS = [
  {
    id: 'vite',
    title: 'Veille : tester Vite.js (30 min)',
    date: '2026-11-27',
    priority: 3,
    rationale: 'Comprendre le build front-end utilisé par les projets web modernes.',
  },
  {
    id: 'cesium',
    title: 'Veille : explorer CesiumJS (30 min)',
    date: '2026-11-30',
    priority: 4,
    rationale: 'Voir si le moteur 3D/globe peut servir à un projet cartographique.',
  },
  {
    id: 'robocopy',
    title: 'Veille : automatiser une sauvegarde Robocopy (30 min)',
    date: '2026-12-02',
    priority: 4,
    rationale: 'Mettre en place une sauvegarde Windows simple et vérifiable.',
  },
  {
    id: 'excel',
    title: 'Veille : Excel Pro — Power Query et TCD (30 min)',
    date: '2026-12-04',
    priority: 4,
    rationale: 'Gagner du temps sur les tableaux et les rapports récurrents.',
  },
  {
    id: 'visualstudio',
    title: 'Veille : Visual Studio Pro — nouveautés (30 min)',
    date: '2026-12-07',
    priority: 4,
    rationale: 'Repérer les fonctions utiles pour les projets .NET/C++.',
  },
  {
    id: 'windev',
    title: 'Veille : Windev — prise en main (30 min)',
    date: '2026-12-09',
    priority: 4,
    rationale: 'Évaluer l’outil sans engagement, pour un besoin rapide desktop/mobile.',
  },
];

function existingTitles(snapshot) {
  const titles = new Set();
  for (const task of Array.isArray(snapshot?.tasks) ? snapshot.tasks : []) {
    const value = normalizeTitle(task.display_title || task.content || '');
    if (value) titles.add(value);
  }
  for (const item of Array.isArray(snapshot?.completed?.recent) ? snapshot.completed.recent : []) {
    const value = normalizeTitle(item.title || '');
    if (value) titles.add(value);
  }
  return titles;
}

function findProject(snapshot) {
  const projects = Array.isArray(snapshot?.projects) ? snapshot.projects : [];
  return (
    projects.find((project) => String(project.id) === PROJECT_ID) ||
    projects.find((project) => project.name === PROJECT_NAME && !project.is_archived) ||
    null
  );
}

/**
 * Construit les propositions de veille encore pertinentes.
 * Si la date est passée, la tâche est proposée pour aujourd'hui.
 */
function buildWatchProposals(snapshot) {
  const today = snapshot?.meta?.today;
  if (!today) return [];
  const titles = existingTitles(snapshot);
  const project = findProject(snapshot);
  const items = [];

  for (const task of WATCH_TASKS) {
    const key = normalizeTitle(task.title);
    if (titles.has(key)) continue;
    const dueDate = task.date >= today ? task.date : today;
    items.push({
      id: `watch:create:${task.id}`,
      type: 'create_task',
      source: 'watchlist',
      type_label: 'Veille',
      tone: 'ok',
      title: 'Nouvelle veille technologique',
      rationale: task.rationale,
      preview: `Créer « ${task.title} » le ${dueDate}.`,
      target: project
        ? { kind: 'project', id: project.id, name: project.name }
        : null,
      action: {
        content: task.title,
        due_date: dueDate,
        priority: task.priority,
        project_id: project ? project.id : null,
        life_area: 'Veille technologique',
      },
      editable: ['due_date'],
      size: 'S',
      size_label: 'Petit',
    });
  }
  return items;
}

function summarizeItems(items) {
  const byType = {};
  for (const item of items) byType[item.type] = (byType[item.type] || 0) + 1;
  return byType;
}

/** Ajoute les propositions de veille à un instantané déjà construit. */
function injectWatchProposals(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const items = buildWatchProposals(snapshot);
  if (items.length === 0) return snapshot;

  const existing = Array.isArray(snapshot.proposals) ? snapshot.proposals : [];
  const ids = new Set(existing.map((proposal) => proposal.id));
  const added = items.filter((proposal) => !ids.has(proposal.id));
  if (added.length === 0) return snapshot;

  snapshot.proposals = [...added, ...existing];
  snapshot.summary = snapshot.summary || {};
  const summary = snapshot.summary.proposals || { truncated: {} };
  snapshot.summary.proposals = {
    ...summary,
    total: snapshot.proposals.length,
    by_type: summarizeItems(snapshot.proposals),
  };
  return snapshot;
}

/** Propositions de veille pour une date précise (plan du jour). */
function watchProposalsForDate(snapshot, date) {
  return buildWatchProposals(snapshot).filter(
    (proposal) => proposal.action.due_date === date
  );
}

module.exports = {
  PROJECT_ID,
  PROJECT_NAME,
  WATCH_TASKS,
  buildWatchProposals,
  injectWatchProposals,
  watchProposalsForDate,
};
