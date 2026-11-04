'use strict';

/**
 * Diagnostic par projet (itération 2 — analyse des projets).
 *
 * Lecture seule : ce module ne produit que des constats et des *propositions*
 * de nettoyage. Aucune action n'est envoyée à Todoist. L'exécution (archiver,
 * supprimer, replanifier) viendra dans une itération ultérieure, toujours avec
 * confirmation puis vérification via l'API.
 */

// Seuils d'alerte. Volontairement simples et lisibles pour rester prévisibles.
const THRESHOLDS = {
  overdueMin: 5, // tâches en retard à partir desquelles on alerte
  undatedMin: 10, // nombre mini de tâches sans échéance
  undatedRatio: 0.6, // part de tâches sans échéance pour parler de « flou »
  congestedMin: 50, // tâches actives à partir desquelles un projet est « surchargé »
  staleActivityDays: 60, // jours sans aucune activité avant de signaler
};

// Chaque signal porte un libellé, une tonalité et un score d'attention.
const SIGNALS = {
  empty: { code: 'empty', label: 'Projet vide', tone: 'muted', score: 40 },
  dormant: { code: 'dormant', label: 'Sans progression', tone: 'warn', score: 35 },
  overdue: { code: 'overdue', label: 'Retards accumulés', tone: 'danger', score: 25 },
  undated: { code: 'undated', label: 'Beaucoup sans échéance', tone: 'warn', score: 20 },
  stale: { code: 'stale', label: 'Aucune activité récente', tone: 'warn', score: 15 },
  congested: { code: 'congested', label: 'Projet surchargé', tone: 'warn', score: 12 },
  healthy: { code: 'healthy', label: 'Sain', tone: 'ok', score: 0 },
};

// Une proposition de nettoyage par type de verdict.
const PROPOSALS = {
  empty: {
    code: 'archive',
    title: 'Archiver ou supprimer',
    detail: 'Ce projet ne contient aucune tâche active : bon candidat à l’archivage.',
  },
  dormant: {
    code: 'review',
    title: 'Réviser ou archiver',
    detail:
      'Des tâches actives mais aucune progression : à trier, replanifier — ou archiver si le projet n’a plus de sens.',
  },
  overdue: {
    code: 'catch_up',
    title: 'Rattraper les retards',
    detail: 'Replanifie ou termine les tâches en retard en priorité avant d’ajouter du neuf.',
  },
  undated: {
    code: 'schedule',
    title: 'Donner des échéances',
    detail:
      'Trop de tâches sans échéance : leur en donner une (même lointaine) pour sortir du flou et les rendre visibles.',
  },
  stale: {
    code: 'review',
    title: 'Décider du sort du projet',
    detail: 'Plus d’activité depuis longtemps : à réactiver ou à archiver.',
  },
  congested: {
    code: 'split',
    title: 'Découper et prioriser',
    detail: 'Projet très chargé : à découper en sous-projets ou à prioriser pour le rendre digérable.',
  },
  healthy: {
    code: 'keep',
    title: 'Rien à faire',
    detail: 'Ce projet semble actif et équilibré.',
  },
};

function ratio(part, total) {
  return total > 0 ? part / total : 0;
}

function formatDays(value) {
  return value === null || value === undefined ? 'âge inconnu' : `créé il y a ${value} j`;
}

/**
 * Construit la liste des signaux d'un projet à partir de ses statistiques.
 * @param {object} project Projet normalisé (avec `is_inbox`).
 * @param {object} stats Statistiques calculées par le snapshot.
 * @param {{completedLookbackDays: number}} context
 */
function buildSignals(project, stats, context) {
  const signals = [];
  const lookback = context.completedLookbackDays;

  // Un Inbox vide est normal : on ne le signale pas comme « projet vide ».
  if (stats.empty && !project.is_inbox) {
    signals.push({ ...SIGNALS.empty, detail: 'Aucune tâche active.' });
  }

  if (stats.no_progress) {
    signals.push({
      ...SIGNALS.dormant,
      detail: `${stats.tasks} tâche(s) active(s), aucune terminée sur ${lookback} j, ${formatDays(
        stats.project_age_days
      )}.`,
    });
  }

  if (stats.overdue >= THRESHOLDS.overdueMin) {
    signals.push({
      ...SIGNALS.overdue,
      score: SIGNALS.overdue.score + Math.min(20, stats.overdue),
      detail: `${stats.overdue} tâche(s) en retard.`,
    });
  }

  const undatedRatio = ratio(stats.no_due, stats.tasks);
  if (stats.no_due >= THRESHOLDS.undatedMin && undatedRatio >= THRESHOLDS.undatedRatio) {
    signals.push({
      ...SIGNALS.undated,
      detail: `${stats.no_due} tâche(s) sur ${stats.tasks} sans échéance (${Math.round(
        undatedRatio * 100
      )} %).`,
    });
  }

  if (
    stats.days_since_activity !== null &&
    stats.days_since_activity >= THRESHOLDS.staleActivityDays &&
    stats.tasks > 0
  ) {
    signals.push({
      ...SIGNALS.stale,
      detail: `Dernière activité il y a ${stats.days_since_activity} j.`,
    });
  }

  if (stats.tasks >= THRESHOLDS.congestedMin) {
    signals.push({ ...SIGNALS.congested, detail: `${stats.tasks} tâche(s) active(s).` });
  }

  return signals;
}

/**
 * Diagnostique un projet : signaux, verdict principal et proposition.
 * @returns {{verdict: string, verdict_label: string, tone: string, score: number,
 *   signals: object[], proposal: object|null}}
 */
function diagnoseProject(project, stats, context) {
  const signals = buildSignals(project, stats, context);

  if (signals.length === 0) {
    return {
      verdict: SIGNALS.healthy.code,
      verdict_label: SIGNALS.healthy.label,
      tone: SIGNALS.healthy.tone,
      score: 0,
      signals: [],
      proposal: { ...PROPOSALS.healthy },
    };
  }

  // Verdict = signal le plus grave (score le plus haut), à score égal on garde
  // l'ordre de définition pour rester déterministe.
  const primary = signals.reduce((best, signal) =>
    signal.score > best.score ? signal : best
  );

  return {
    verdict: primary.code,
    verdict_label: primary.label,
    tone: primary.tone,
    score: Math.min(100, signals.reduce((sum, signal) => sum + signal.score, 0)),
    signals,
    proposal: { ...PROPOSALS[primary.code] },
  };
}

// Regroupe les verdicts en « buckets » d'action, utilisés par les filtres de l'UI.
const VERDICT_BUCKETS = {
  empty: 'archive',
  dormant: 'review',
  stale: 'review',
  overdue: 'catch_up',
  undated: 'schedule',
  congested: 'split',
  healthy: 'healthy',
};

const BUCKET_META = {
  archive: { key: 'archive', label: 'À archiver', tone: 'muted' },
  review: { key: 'review', label: 'À réviser', tone: 'warn' },
  catch_up: { key: 'catch_up', label: 'En retard', tone: 'danger' },
  schedule: { key: 'schedule', label: 'À dater', tone: 'warn' },
  split: { key: 'split', label: 'Surchargés', tone: 'warn' },
  healthy: { key: 'healthy', label: 'Sains', tone: 'ok' },
};

function bucketForVerdict(verdict) {
  return VERDICT_BUCKETS[verdict] || 'healthy';
}

/**
 * Agrège le diagnostic des projets actifs pour le résumé et les filtres.
 * @param {object[]} projects Projets normalisés, avec `diagnosis` et `stats`.
 */
function buildProjectDiagnosis(projects) {
  const active = projects.filter((project) => !project.is_archived && project.diagnosis);
  const counts = { all: active.length, archive: 0, review: 0, catch_up: 0, schedule: 0, split: 0, healthy: 0 };
  const byVerdict = {};

  for (const project of active) {
    const bucket = bucketForVerdict(project.diagnosis.verdict);
    counts[bucket] += 1;
    byVerdict[project.diagnosis.verdict] = (byVerdict[project.diagnosis.verdict] || 0) + 1;
  }

  const actions = Object.values(BUCKET_META)
    .filter((meta) => counts[meta.key] > 0)
    .map((meta) => ({ ...meta, count: counts[meta.key] }));

  return {
    total: counts.all,
    counts,
    by_verdict: byVerdict,
    actions,
  };
}

module.exports = {
  THRESHOLDS,
  SIGNALS,
  PROPOSALS,
  VERDICT_BUCKETS,
  BUCKET_META,
  bucketForVerdict,
  buildSignals,
  diagnoseProject,
  buildProjectDiagnosis,
};
