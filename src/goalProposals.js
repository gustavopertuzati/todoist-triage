'use strict';

const { config } = require('./config');
const { chatJson, AiError } = require('./ai');

const SYSTEM_PROMPT = [
  'Tu construis des objectifs personnels réalisables et mesurables.',
  'Tu proposes des jalons concrets, ordonnés, avec des poids qui totalisent 100.',
  'Tu réponds UNIQUEMENT par un objet JSON valide, sans texte autour.',
].join(' ');

function normalizeSteps(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((step, index) => {
      const title = String(typeof step === 'string' ? step : step?.title || '').trim();
      if (!title) return null;
      return {
        id: `step-${index + 1}`,
        title: title.slice(0, 180),
      };
    })
    .filter(Boolean)
    .slice(0, 8);
}

function normalizeMilestones(parsed) {
  const raw = Array.isArray(parsed?.milestones) ? parsed.milestones : [];
  const cleaned = [];
  for (const entry of raw) {
    const title = String(entry?.title || '').trim();
    if (!title) continue;
    const weight = Math.max(1, Number(entry?.weight) || 10);
    cleaned.push({
      title: title.slice(0, 180),
      weight,
      type: 'manual',
      steps: normalizeSteps(entry?.steps),
    });
    if (cleaned.length >= 6) break;
  }
  if (cleaned.length === 0) {
    throw new AiError('BAD_GOAL', 'L’IA n’a pas proposé de jalons exploitables.');
  }

  const total = cleaned.reduce((sum, milestone) => sum + milestone.weight, 0);
  let running = 0;
  cleaned.forEach((milestone, index) => {
    if (index === cleaned.length - 1) {
      milestone.weight = Math.max(1, 100 - running);
    } else {
      milestone.weight = Math.max(1, Math.round((milestone.weight / total) * 100));
      running += milestone.weight;
    }
    milestone.id = `m-${index + 1}`;
  });

  return cleaned;
}

async function generateGoalMilestones({ title, description = '', deadline = '', sources = [] }) {
  if (!config.aiEnabled) {
    throw new AiError('AI_DISABLED', 'L’IA n’est pas configurée (OPENROUTER_API_KEY manquant).');
  }
  const cleanTitle = String(title || '').trim().slice(0, 160);
  if (!cleanTitle) throw new AiError('BAD_TITLE', 'Le titre de l’objectif est vide.');
  const sourceList = (Array.isArray(sources) ? sources : [])
    .map((source) => String(source || '').trim())
    .filter(Boolean)
    .slice(0, 8);

  const prompt = [
    `Objectif : ${cleanTitle}`,
    description ? `Intention : ${String(description).trim().slice(0, 500)}` : '',
    deadline ? `Date limite : ${deadline}` : '',
    sourceList.length ? `Sources / cours à suivre :\n${sourceList.join('\n')}` : '',
    '',
    'Propose 3 à 6 jalons mesurables et réalistes pour atteindre cet objectif.',
    'Les poids doivent totaliser 100. Ordonne-les du premier pas à la réussite finale.',
    'Si un jalon se divise en plusieurs tâches, ajoute "steps" (2 à 8 étapes) pour que chaque étape fasse avancer la progression.',
    'Chaque jalon doit être vérifiable (un résultat concret, pas une intention vague).',
    '',
    'Réponds EXACTEMENT par ce JSON :',
    '{"summary":"phrase courte",',
    ' "milestones":[{"title":"...","weight":20,"steps":["étape 1","étape 2"]}]}',
  ]
    .filter(Boolean)
    .join('\n');

  const { data, usage, model } = await chatJson({ system: SYSTEM_PROMPT, user: prompt });
  const milestones = normalizeMilestones(data);

  return {
    summary:
      typeof data?.summary === 'string' && data.summary.trim()
        ? data.summary.trim().slice(0, 300)
        : null,
    milestones,
    usage,
    model,
  };
}

module.exports = {
  SYSTEM_PROMPT,
  normalizeMilestones,
  generateGoalMilestones,
};
