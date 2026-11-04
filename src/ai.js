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
 * @param {{system: string, user: string, maxTokens?: number, temperature?: number}} params
 * @returns {Promise<object|null>} objet JSON déjà parsé
 */
async function chatJson({ system, user, maxTokens = config.aiMaxTokens, temperature = 0.4 }) {
  if (!config.openrouterApiKey) {
    throw new AiError('AI_NOT_CONFIGURED', 'Aucune clé OpenRouter configurée.');
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
      body: JSON.stringify({
        model: config.aiModel,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature,
        max_tokens: maxTokens,
        // Les modèles de raisonnement brûlent tout le budget en réflexion s'il
        // n'est pas plafonné : on réserve de la place pour le JSON final.
        reasoning: { max_tokens: config.aiReasoningMaxTokens },
      }),
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

  return { data: parsed, usage: payload?.usage || null, model: payload?.model || config.aiModel };
}

module.exports = { AiError, chatJson, parseJsonLoose };
