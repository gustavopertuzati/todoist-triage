'use strict';

/**
 * Micro-rituels cumulatifs (itération 49).
 *
 * Trois rituels « anti-surcharge » sont proposés en haut de la page Objectifs.
 * Chaque objectif peut aussi avoir UN petit rituel de 2 à 5 min, répétable
 * plusieurs fois par jour. Les compteurs sont stockés par date :
 *
 *   { "reading": { "2026-11-16": 2, "2026-11-17": 1 } }
 *
 * L'ancien format (tableau de dates, une fois par jour) reste lu et migré.
 * Chaque passage apporte une petite fraction de progression à l'objectif lié.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Rituals = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const BONUS_PER_COMPLETION = 0.5;
  const MAX_BONUS = 10;

  const UNIVERSAL = [
    {
      id: 'duolingo',
      title: 'Duolingo',
      detail: '1 leçon — 2 min',
      minutes: 2,
      goalId: null,
    },
    {
      id: 'reading',
      title: 'Lire 2 pages',
      detail: '3 min',
      minutes: 3,
      goalId: 'reading',
    },
    {
      id: 'sport',
      title: 'Bouger 5 min',
      detail: '5 min à la maison',
      minutes: 5,
      goalId: 'sport',
    },
  ];

  // Un seul petit rituel par objectif (hors lecture/sport, déjà en haut).
  // Chaque entrée doit rester faisable en 2 à 5 minutes et répétable.
  const GOAL_RITUALS = [
    {
      id: 'opencode-action',
      goalId: 'opencode',
      title: 'Tester une action',
      detail: '2 min · une commande réversible, puis annuler',
      minutes: 2,
    },
    {
      id: 'jobops-cv',
      goalId: 'jobops',
      title: 'Ajouter une preuve au CV',
      detail: '3 min · une ligne ou un lien',
      minutes: 3,
    },
    {
      id: 'n8n-note',
      goalId: 'n8n',
      title: 'Noter une étape de workflow',
      detail: '3 min · déclencheur ou nœud',
      minutes: 3,
    },
    {
      id: 'aws-notion',
      goalId: 'aws',
      title: 'Réviser une notion AWS',
      detail: '2 min · une carte ou un service',
      minutes: 2,
    },
    {
      id: 'calories-repas',
      goalId: 'calories',
      title: 'Noter un repas',
      detail: '2 min · dans Lose It',
      minutes: 2,
    },
    {
      id: 'itheorie-question',
      goalId: 'itheorie',
      title: 'Une question de théorie',
      detail: '2 min · iTheorie',
      minutes: 2,
    },
    {
      id: 'plants-check',
      goalId: 'plants',
      title: 'Vérifier une plante',
      detail: '2 min · eau ou feuille morte',
      minutes: 2,
    },
    {
      id: 'puzzle-pieces',
      goalId: 'puzzle',
      title: 'Placer 3 pièces',
      detail: '5 min · avec Marco si possible',
      minutes: 5,
    },
    {
      id: 'public-geste',
      goalId: 'public',
      title: 'Un geste de préparation',
      detail: '3 min · tenue ou soin',
      minutes: 3,
    },
  ];

  const ALL = [...UNIVERSAL, ...GOAL_RITUALS];

  function isIsoDate(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  }

  /** Normalise l'ancien tableau de dates et le nouvel objet date → compteur. */
  function normalizeCounts(raw) {
    const counts = {};
    if (Array.isArray(raw)) {
      for (const date of raw) {
        if (!isIsoDate(date)) continue;
        counts[date] = (counts[date] || 0) + 1;
      }
      return counts;
    }
    if (!raw || typeof raw !== 'object') return counts;
    for (const [date, value] of Object.entries(raw)) {
      if (!isIsoDate(date)) continue;
      const count = Math.max(0, Math.floor(Number(value) || 0));
      if (count > 0) counts[date] = count;
    }
    return counts;
  }

  function countToday(raw, today) {
    if (!isIsoDate(today)) return 0;
    return normalizeCounts(raw)[today] || 0;
  }

  function total(raw) {
    return Object.values(normalizeCounts(raw)).reduce((sum, value) => sum + value, 0);
  }

  function addDaysIso(iso, days) {
    if (!isIsoDate(iso)) return null;
    const [year, month, day] = iso.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }

  /** Jours consécutifs avec au moins un passage. */
  function streak(raw, today) {
    const counts = normalizeCounts(raw);
    let cursor = isIsoDate(today) ? today : null;
    if (!cursor) return 0;
    if (!counts[cursor]) cursor = addDaysIso(cursor, -1);
    let days = 0;
    while (cursor && counts[cursor] > 0 && days < 3650) {
      days += 1;
      cursor = addDaysIso(cursor, -1);
    }
    return days;
  }

  function addOne(raw, today) {
    const counts = normalizeCounts(raw);
    if (!isIsoDate(today)) return counts;
    counts[today] = (counts[today] || 0) + 1;
    return counts;
  }

  function removeOne(raw, today) {
    const counts = normalizeCounts(raw);
    if (!isIsoDate(today) || !counts[today]) return counts;
    counts[today] -= 1;
    if (counts[today] <= 0) delete counts[today];
    return counts;
  }

  function definitionsForGoal(goalId) {
    if (!goalId) return [];
    return ALL.filter((ritual) => ritual.goalId === goalId);
  }

  /** Rituel affiché dans la carte d'un objectif (un seul, hors lecture/sport). */
  function goalCardRitual(goalId) {
    return GOAL_RITUALS.find((ritual) => ritual.goalId === goalId) || null;
  }

  /** Petite fraction de progression apportée par tous les rituels d'un objectif. */
  function bonusForGoal(goalId, ritualsState) {
    const state = ritualsState && typeof ritualsState === 'object' ? ritualsState : {};
    const count = definitionsForGoal(goalId).reduce(
      (sum, ritual) => sum + total(state[ritual.id]),
      0
    );
    return Math.min(MAX_BONUS, Math.round(count * BONUS_PER_COMPLETION * 10) / 10);
  }

  return {
    BONUS_PER_COMPLETION,
    MAX_BONUS,
    UNIVERSAL,
    GOAL_RITUALS,
    ALL,
    normalizeCounts,
    countToday,
    total,
    streak,
    addOne,
    removeOne,
    definitionsForGoal,
    goalCardRitual,
    bonusForGoal,
  };
});
