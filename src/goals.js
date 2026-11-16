'use strict';

/**
 * Objectifs et jalons.
 *
 * Les définitions vivent dans `GOALS.json` (versionné). Les cases manuelles et
 * la validation sont stockées dans le navigateur ; les jalons automatiques
 * comptent les tâches terminées récentes de Todoist.
 */

const fs = require('node:fs');
const path = require('node:path');

function defaultFile() {
  return process.env.GOALS_FILE
    ? path.resolve(process.env.GOALS_FILE)
    : path.join(__dirname, '..', 'GOALS.json');
}

function readGoals(file = defaultFile()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const goals = Array.isArray(parsed?.goals) ? parsed.goals : [];
    return goals
      .filter((goal) => goal && typeof goal.id === 'string')
      .map((goal) => ({
        id: goal.id,
        title: String(goal.title || goal.id).slice(0, 160),
        description: String(goal.description || '').slice(0, 300) || null,
        keywords: (Array.isArray(goal.keywords) ? goal.keywords : [])
          .map((keyword) => String(keyword || '').trim().toLowerCase())
          .filter(Boolean)
          .slice(0, 12),
        confirmed: goal.confirmed === true,
        pace: sanitizePace(goal.pace),
        milestones: (Array.isArray(goal.milestones) ? goal.milestones : [])
          .filter((milestone) => milestone && typeof milestone.id === 'string')
          .map((milestone) => ({
            id: milestone.id,
            title: String(milestone.title || milestone.id).slice(0, 180),
            weight: Math.max(1, Math.min(100, Number(milestone.weight) || 10)),
            type: milestone.type === 'completed_tasks' ? 'completed_tasks' : 'manual',
            count:
              milestone.type === 'completed_tasks'
                ? Math.max(1, Math.min(500, Number(milestone.count) || 1))
                : null,
            keywords: (Array.isArray(milestone.keywords) ? milestone.keywords : [])
              .map((keyword) => String(keyword || '').trim().toLowerCase())
              .filter(Boolean)
              .slice(0, 8),
          })),
      }));
  } catch {
    return [];
  }
}

function sanitizePace(pace) {
  if (!pace || typeof pace !== 'object') return null;
  const value = Number(pace.value);
  if (!Number.isFinite(value) || value <= 0) return null;
  const base = Number(pace.base);
  return {
    value: Math.round(value * 10) / 10,
    unit: typeof pace.unit === 'string' ? pace.unit.slice(0, 24) : null,
    base: Number.isFinite(base) && base > 0 ? Math.round(base * 10) / 10 : null,
    updated_at: typeof pace.updated_at === 'string' ? pace.updated_at.slice(0, 40) : null,
    reason: typeof pace.reason === 'string' ? pace.reason.slice(0, 200) : null,
    paused_until:
      typeof pace.paused_until === 'string' ? pace.paused_until.slice(0, 10) : null,
  };
}

/**
 * Écrit le rythme adapté dans GOALS.json (fichier local, pas Todoist).
 * Les autres champs et l'ordre des objectifs sont conservés.
 *
 * @param {{id:string, pace:object}[]} updates
 * @returns {string[]} identifiants réellement modifiés
 */
function writeGoalPaces(updates, file = defaultFile()) {
  if (!Array.isArray(updates) || updates.length === 0) return [];
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed.goals)) return [];
  const wanted = new Map();
  for (const update of updates) {
    const pace = sanitizePace(update?.pace);
    if (update?.id && pace) wanted.set(String(update.id), pace);
  }
  if (wanted.size === 0) return [];

  const changed = [];
  for (const goal of parsed.goals) {
    if (!goal || typeof goal.id !== 'string') continue;
    const pace = wanted.get(goal.id);
    if (!pace) continue;
    goal.pace = pace;
    changed.push(goal.id);
  }
  if (changed.length === 0) return [];

  parsed.updated_at = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return changed;
}

function countCompleted(snapshot, keywords, excludeIds = new Set()) {
  const recent = snapshot?.completed?.recent;
  if (!Array.isArray(recent) || keywords.length === 0) return 0;
  const projectNames = new Map(
    (snapshot.projects || []).map((project) => [String(project.id), String(project.name || '')])
  );
  let count = 0;
  for (const item of recent) {
    if (item.id && excludeIds.has(String(item.id))) continue;
    const haystack = `${item.title || ''} ${
      projectNames.get(String(item.project_id || '')) || ''
    }`.toLowerCase();
    if (keywords.some((keyword) => haystack.includes(keyword))) count += 1;
  }
  return count;
}

/** Ajoute les compteurs automatiques aux définitions d'objectifs. */
function evaluateGoals(snapshot, goals = readGoals(), excludeIds = new Set()) {
  return goals.map((goal) => {
    const completed = countCompleted(snapshot, goal.keywords, excludeIds);
    return {
      ...goal,
      completed_count: completed,
      milestones: goal.milestones.map((milestone) => {
        const milestoneKeywords = Array.isArray(milestone.keywords) && milestone.keywords.length > 0
          ? milestone.keywords
          : goal.keywords;
        const milestoneCompleted =
          milestone.type === 'completed_tasks'
            ? countCompleted(snapshot, milestoneKeywords, excludeIds)
            : null;
        return {
          ...milestone,
          completed_count: milestoneCompleted,
          auto_done:
            milestone.type === 'completed_tasks' &&
            milestoneCompleted >= milestone.count,
        };
      }),
    };
  });
}

module.exports = {
  defaultFile,
  readGoals,
  sanitizePace,
  writeGoalPaces,
  countCompleted,
  evaluateGoals,
};
