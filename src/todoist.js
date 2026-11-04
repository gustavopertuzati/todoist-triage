'use strict';

/**
 * Client minimal de l'API Todoist v1.
 *
 * Lecture : un full sync (projets, sections, tâches actives, labels, user)
 * + les tâches terminées récentes pour mesurer l'activité des projets.
 *
 * Toutes les erreurs sont converties en TodoistError avec un code stable,
 * afin que l'interface puisse afficher un message utile sans jamais révéler
 * le token ni les détails internes.
 */

const { config } = require('./config');

class TodoistError extends Error {
  constructor(message, { code = 'TODOIST_ERROR', status = null, retryAfter = null, detail = null } = {}) {
    super(message);
    this.name = 'TodoistError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
    this.detail = detail;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Extrait Retry-After en secondes (valeur numérique ou date HTTP). */
function parseRetryAfter(headerValue) {
  if (!headerValue) return null;
  const seconds = Number.parseInt(headerValue, 10);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(headerValue);
  if (Number.isFinite(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  return null;
}

function safeErrorMessage(body) {
  // On ne renvoie qu'un court message métier, jamais le corps complet.
  if (!body || typeof body !== 'object') return null;
  const value = body.error || body.message || body.error_tag;
  if (typeof value !== 'string') return null;
  return value.slice(0, 200);
}

async function requestJson(path, { method = 'GET', query, form, attempt = 1 } = {}) {
  if (!config.todoistToken) {
    throw new TodoistError(
      'Le token Todoist n’est pas configuré sur le serveur.',
      { code: 'CONFIG_MISSING' }
    );
  }

  const url = new URL(`${config.todoistBaseUrl}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const headers = {
    Authorization: `Bearer ${config.todoistToken}`,
    Accept: 'application/json',
  };
  let body;
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(config.todoistTimeoutMs),
    });
  } catch (error) {
    const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    if (attempt < 3) {
      await sleep(400 * attempt);
      return requestJson(path, { method, query, form, attempt: attempt + 1 });
    }
    throw new TodoistError(
      isTimeout
        ? 'Todoist met trop de temps à répondre.'
        : 'Impossible de joindre Todoist (réseau).',
      { code: 'NETWORK_ERROR' }
    );
  }

  const rawText = await response.text().catch(() => '');
  let payload = null;
  if (rawText) {
    try {
      payload = JSON.parse(rawText);
    } catch {
      payload = null;
    }
  }

  if (response.status === 429) {
    const retryAfter = parseRetryAfter(response.headers.get('retry-after')) ?? 5;
    if (attempt < 3 && retryAfter <= 10) {
      await sleep(retryAfter * 1000);
      return requestJson(path, { method, query, form, attempt: attempt + 1 });
    }
    throw new TodoistError(
      `Quota Todoist atteint. Réessaie dans ${retryAfter} seconde(s).`,
      { code: 'RATE_LIMITED', status: 429, retryAfter }
    );
  }

  if (response.status >= 500 && attempt < 3) {
    await sleep(600 * attempt);
    return requestJson(path, { method, query, form, attempt: attempt + 1 });
  }

  if (!response.ok) {
    const detail = safeErrorMessage(payload);
    if (response.status === 401) {
      throw new TodoistError(
        'Token Todoist invalide ou expiré. Vérifie TODOIST_API_TOKEN puis redéploie.',
        { code: 'TODOIST_AUTH', status: 401 }
      );
    }
    if (response.status === 403) {
      throw new TodoistError(
        'Todoist refuse cette opération (droits insuffisants).',
        { code: 'TODOIST_FORBIDDEN', status: 403, detail }
      );
    }
    if (response.status === 404) {
      throw new TodoistError('Ressource Todoist introuvable.', {
        code: 'TODOIST_NOT_FOUND',
        status: 404,
      });
    }
    if (response.status === 400) {
      throw new TodoistError(
        detail ? `Todoist a refusé la requête : ${detail}` : 'Todoist a refusé la requête.',
        { code: 'TODOIST_BAD_REQUEST', status: 400 }
      );
    }
    throw new TodoistError('Todoist a renvoyé une erreur inattendue.', {
      code: 'TODOIST_UPSTREAM',
      status: response.status,
      detail,
    });
  }

  if (!payload || typeof payload !== 'object') {
    throw new TodoistError('Réponse Todoist illisible.', { code: 'TODOIST_BAD_RESPONSE' });
  }
  return payload;
}

/**
 * Récupère en une requête toutes les données actives du compte.
 * Le full sync est officiel et limité à 100 appels / 15 min par utilisateur.
 */
async function fullSync() {
  return requestJson('/sync', {
    method: 'POST',
    form: {
      sync_token: '*',
      resource_types: JSON.stringify(['projects', 'sections', 'items', 'labels', 'user']),
    },
  });
}

/**
 * Tâches terminées dans une fenêtre (max 3 mois côté Todoist).
 * Sert uniquement d'indicateur d'activité ; un échec ne doit pas bloquer
 * l'export (l'appelant reçoit alors un avertissement).
 */
async function completedSince(sinceIso, untilIso, { maxItems = 3000 } = {}) {
  const items = [];
  let cursor = null;
  let truncated = false;

  for (let page = 0; page < 40; page += 1) {
    const payload = await requestJson('/tasks/completed/by_completion_date', {
      query: {
        since: sinceIso,
        until: untilIso,
        limit: 200,
        cursor: cursor || undefined,
      },
    });

    const results = Array.isArray(payload.items)
      ? payload.items
      : Array.isArray(payload.results)
        ? payload.results
        : [];
    items.push(...results);

    if (items.length >= maxItems) {
      truncated = Boolean(payload.next_cursor) || items.length > maxItems;
      items.length = maxItems;
      break;
    }

    cursor = payload.next_cursor || null;
    if (!cursor) break;
  }

  if (cursor) truncated = true;
  return { items, truncated };
}

module.exports = {
  TodoistError,
  fullSync,
  completedSince,
  parseRetryAfter,
};
