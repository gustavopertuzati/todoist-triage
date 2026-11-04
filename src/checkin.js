'use strict';

/**
 * Check-in du jour (itération 7).
 *
 * Cinq questions rapides (énergie, forme, temps disponible, envie, humeur).
 * Les réponses réduisent la charge autorisée de la journée : si tu es malade ou
 * épuisé, la journée est allégée, et l'app peut proposer de reporter des tâches.
 *
 * Tout est déterministe et testable ici ; l'IA reçoit le résultat pour choisir
 * les tâches les plus adaptées.
 */

const QUESTIONS = [
  {
    key: 'energy',
    label: 'Énergie',
    options: [
      { value: 'exhausted', label: 'Épuisé' },
      { value: 'low', label: 'Bas' },
      { value: 'medium', label: 'Moyen' },
      { value: 'good', label: 'Bon' },
      { value: 'high', label: 'Plein d’énergie' },
    ],
  },
  {
    key: 'health',
    label: 'Forme',
    options: [
      { value: 'sick', label: 'Malade' },
      { value: 'tired', label: 'Fatigué' },
      { value: 'normal', label: 'Normal' },
      { value: 'great', label: 'En pleine forme' },
    ],
  },
  {
    key: 'time',
    label: 'Temps dispo',
    options: [
      { value: 'lt1h', label: 'Moins d’1 h' },
      { value: 'h1to2', label: '1 à 2 h' },
      { value: 'h2to4', label: '2 à 4 h' },
      { value: 'allday', label: 'Toute la journée' },
    ],
  },
  {
    key: 'want',
    label: 'Envie',
    options: [
      { value: 'short', label: 'Tâches courtes' },
      { value: 'admin', label: 'Administratif' },
      { value: 'creative', label: 'Créatif' },
      { value: 'no_mental', label: 'Rien de mental' },
      { value: 'mix', label: 'Un peu de tout' },
    ],
  },
  {
    key: 'mood',
    label: 'Humeur',
    options: [
      { value: 'overwhelmed', label: 'Débordé' },
      { value: 'neutral', label: 'Neutre' },
      { value: 'motivated', label: 'Motivé' },
      { value: 'great', label: 'Très bien' },
    ],
  },
];

const DEFAULTS = {
  energy: 'medium',
  health: 'normal',
  time: 'h2to4',
  want: 'mix',
  mood: 'neutral',
};

const ENERGY = {
  exhausted: { L: 0, M: 0, S: 3 },
  low: { L: 0, M: 1, S: 3 },
  medium: { L: 1, M: 2, S: 4 },
  good: { L: 1, M: 3, S: 5 },
  high: { L: 1, M: 3, S: 5 },
};

const HEALTH = {
  sick: { L: 0, M: 1, S: 3 },
  tired: { L: 0, M: 2, S: 4 },
  normal: { L: 1, M: 3, S: 5 },
  great: { L: 1, M: 3, S: 5 },
};

const MOOD = {
  overwhelmed: { L: 0, M: 1, S: 3 },
  neutral: { L: 1, M: 3, S: 5 },
  motivated: { L: 1, M: 3, S: 5 },
  great: { L: 1, M: 3, S: 5 },
};

const TIME_TOTAL = { lt1h: 2, h1to2: 3, h2to4: 5, allday: 99 };

function optionValues(key) {
  const question = QUESTIONS.find((q) => q.key === key);
  return question ? question.options.map((o) => o.value) : [];
}

function optionLabel(key, value) {
  const question = QUESTIONS.find((q) => q.key === key);
  const option = question ? question.options.find((o) => o.value === value) : null;
  return option ? option.label : null;
}

/** Nettoie les réponses reçues du client (valeurs inconnues → défauts). */
function normalizeCheckin(input) {
  const source = input && typeof input === 'object' ? input : {};
  const result = {};
  for (const question of QUESTIONS) {
    const value = source[question.key];
    result[question.key] = optionValues(question.key).includes(value)
      ? value
      : DEFAULTS[question.key];
  }
  return result;
}

function minPerSize(...loads) {
  return {
    L: Math.min(...loads.map((l) => l.L)),
    M: Math.min(...loads.map((l) => l.M)),
    S: Math.min(...loads.map((l) => l.S)),
  };
}

function total(load) {
  return load.L + load.M + load.S;
}

/** Réduit le total autorisé en retirant d'abord les grosses tâches. */
function capTotal(load, maxTotal) {
  const result = { ...load };
  const order = ['L', 'M', 'S'];
  while (total(result) > maxTotal) {
    const key = order.find((k) => result[k] > 0);
    if (!key) break;
    result[key] -= 1;
  }
  return result;
}

/**
 * Charge autorisée pour la journée selon les réponses.
 * @returns {{allowed: {L,M,S}, label: string, notes: string[]}}
 */
function computeAllowed(checkin, rule) {
  const answers = normalizeCheckin(checkin);
  const notes = [];

  let allowed = minPerSize(
    rule,
    ENERGY[answers.energy],
    HEALTH[answers.health],
    MOOD[answers.mood]
  );

  allowed = capTotal(allowed, TIME_TOTAL[answers.time]);

  if (answers.health === 'sick') {
    notes.push('Repos : propose uniquement des tâches légères et peu nombreuses.');
  }
  if (answers.energy === 'exhausted' || answers.mood === 'overwhelmed') {
    notes.push('Énergie très basse : garde l’essentiel, reporte le reste.');
  }
  if (answers.want === 'no_mental') {
    notes.push('Évite les tâches qui demandent de la réflexion.');
  }
  if (answers.want === 'short') {
    notes.push('Privilégie des tâches courtes.');
  }
  if (answers.time === 'lt1h') {
    notes.push('Très peu de temps : une ou deux tâches maximum.');
  }

  const full = { L: rule.L, M: rule.M, S: rule.S };
  const lighter = total(allowed) < total(full) || allowed.L < full.L;
  const label = lighter ? 'Journée allégée selon ton état' : 'Journée normale';

  return { allowed, label, notes, answers };
}

/** Résumé lisible des réponses, pour l'IA et l'interface. */
function describeCheckin(checkin) {
  const answers = normalizeCheckin(checkin);
  return QUESTIONS.map((question) => ({
    key: question.key,
    label: question.label,
    value: answers[question.key],
    option: optionLabel(question.key, answers[question.key]),
  }));
}

module.exports = {
  QUESTIONS,
  DEFAULTS,
  normalizeCheckin,
  computeAllowed,
  describeCheckin,
  optionLabel,
};
