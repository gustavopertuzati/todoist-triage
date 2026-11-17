'use strict';

/**
 * Client minimal OpenRouter (itération 4).
 *
 * On demande au modèle un objet JSON strict. Aucune donnée sensible n'est
 * envoyée : uniquement des titres de tâches, leurs métadonnées et la date du
 * jour — jamais le token Todoist ni le mot de passe.
 */

const { config } = require('./config');

class AiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AiError';
    this.code = code;
  }
}

/** Parse un JSON même s'il est entouré de texte ou de balises de code. */
function parseJsonLoose(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenceMatch ? fenceMatch[1].trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    // Dernier recours : premier objet {...} ou tableau [...] trouvé.
    const start = candidate.search(/[[{]/);
    if (start === -1) return null;
    const slice = candidate.slice(start);
    const lastObj = slice.lastIndexOf('}');
    const lastArr = slice.lastIndexOf(']');
    const end = Math.max(lastObj, lastArr);
    if (end === -1) return null;
    try {
      return JSON.parse(slice.slice(0, end + 1));
    } catch {
      return null;
    }
  }
}

/**
 * Appel générique à OpenRouter, avec messages déjà construits.
 * @returns {Promise<{data: object, usage: object|null, model: string}>}
 */
async function requestChatJson({
  model,
  messages,
  maxTokens = config.aiMaxTokens,
  temperature = 0.4,
  reasoning = true,
}) {
  if (!config.openrouterApiKey) {
    throw new AiError('AI_NOT_CONFIGURED', 'Aucune clé OpenRouter configurée.');
  }

  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (reasoning) {
    // Les modèles de raisonnement brûlent tout le budget en réflexion s'il
    // n'est pas plafonné : on réserve de la place pour le JSON final.
    body.reasoning = { max_tokens: config.aiReasoningMaxTokens };
  }

  let response;
  try {
    response = await fetch(`${config.openrouterBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openrouterApiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://todoist-triage.orkestr.run',
        'X-Title': 'Triage pour Todoist',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.aiTimeoutMs),
    });
  } catch (error) {
    const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw new AiError(
      isTimeout ? 'AI_TIMEOUT' : 'AI_NETWORK',
      isTimeout ? 'L’IA met trop de temps à répondre.' : 'Impossible de joindre l’IA.'
    );
  }

  const raw = await response.text().catch(() => '');
  let payload = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const detail = payload?.error?.message || payload?.error || raw.slice(0, 200);
    throw new AiError('AI_UPSTREAM', `L’IA a renvoyé une erreur (${response.status}). ${detail || ''}`.trim());
  }

  const content = payload?.choices?.[0]?.message?.content;
  const parsed = parseJsonLoose(content);
  if (!parsed || typeof parsed !== 'object') {
    throw new AiError('AI_BAD_RESPONSE', 'Réponse de l’IA illisible.');
  }

  return { data: parsed, usage: payload?.usage || null, model: payload?.model || model };
}

/**
 * @param {{system: string, user: string, maxTokens?: number, temperature?: number}} params
 * @returns {Promise<object|null>} objet JSON déjà parsé
 */
async function chatJson({ system, user, maxTokens = config.aiMaxTokens, temperature = 0.4 }) {
  return requestChatJson({
    model: config.aiModel,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    maxTokens,
    temperature,
    reasoning: true,
  });
}

/**
 * Lit une ou plusieurs images (data URLs) et renvoie un JSON strict.
 * Utilisé uniquement pour les captures iTheorie.
 */
async function chatJsonVision({
  system,
  user,
  images = [],
  maxTokens = 4000,
  temperature = 0,
}) {
  if (!Array.isArray(images) || images.length === 0) {
    throw new AiError('AI_NO_IMAGE', 'Aucune capture à analyser.');
  }
  return requestChatJson({
    model: config.aiVisionModel,
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: [
          { type: 'text', text: user },
          ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
        ],
      },
    ],
    maxTokens,
    temperature,
    // Gemini Flash n'a pas besoin d'un gros budget de raisonnement pour lire
    // des chiffres ; on garde la réponse rapide et bornée.
    reasoning: false,
  });
}

module.exports = { AiError, chatJson, chatJsonVision, parseJsonLoose };
