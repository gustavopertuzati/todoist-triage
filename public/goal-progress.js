'use strict';

/**
 * Calcul de progression des objectifs.
 *
 * - Un jalon `completed_tasks` donne une fraction proportionnelle
 *   (4 tâches sur 10 = 40 % du poids du jalon).
 * - Un jalon manuel avec `steps` donne le poids divisé par le nombre d'étapes
 *   (20 % en 4 étapes = 5 % par étape).
 * - Un jalon manuel simple donne tout son poids quand il est coché.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.GoalProgress = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function stepsOf(milestone) {
    return Array.isArray(milestone?.steps) ? milestone.steps : [];
  }

  function stepDone(entry, milestone, step) {
    return Boolean(entry?.steps?.[milestone.id]?.[step.id]);
  }

  function milestoneFraction(milestone, entry) {
    if (milestone?.type === 'completed_tasks') {
      const target = Math.max(1, Number(milestone.count) || 1);
      const done = Math.max(
        0,
        Math.min(target, Number(milestone.completed_count) || 0)
      );
      return done / target;
    }
    const steps = stepsOf(milestone);
    if (steps.length > 0) {
      const done = steps.filter((step) => stepDone(entry, milestone, step)).length;
      return done / steps.length;
    }
    return entry?.done?.[milestone.id] ? 1 : 0;
  }

  function milestoneDone(milestone, entry) {
    return milestoneFraction(milestone, entry) >= 1;
  }

  function goalProgress(goal, entry, ritualBonus = 0) {
    if (!(goal?.confirmed || entry?.confirmed)) return 0;
    const milestones = Array.isArray(goal?.milestones) ? goal.milestones : [];
    const total = milestones.reduce(
      (sum, milestone) => sum + (Number(milestone.weight) || 0),
      0
    );
    if (total <= 0) return 0;
    const done = milestones.reduce(
      (sum, milestone) =>
        sum + (Number(milestone.weight) || 0) * milestoneFraction(milestone, entry),
      0
    );
    const base = (done / total) * 100;
    const allDone = milestones.every((milestone) => milestoneFraction(milestone, entry) >= 1);
    if (allDone) return 100;
    // Les micro-rituels ajoutent une petite progression visible sans jamais
    // faire croire qu'un objectif est terminé avant ses vrais jalons.
    const bonus = Math.max(0, Math.min(20, Number(ritualBonus) || 0));
    return Math.round(Math.min(99.9, base + bonus) * 10) / 10;
  }

  function nextMilestone(goal, entry) {
    const milestones = Array.isArray(goal?.milestones) ? goal.milestones : [];
    return milestones.find((milestone) => !milestoneDone(milestone, entry)) || null;
  }

  return {
    stepsOf,
    stepDone,
    milestoneFraction,
    milestoneDone,
    goalProgress,
    nextMilestone,
  };
});
