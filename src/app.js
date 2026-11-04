'use strict';

/**
 * Application Express.
 *
 * Principes :
 * - aucune donnée Todoist n'est accessible sans session ;
 * - le token Todoist reste côté serveur ;
 * - les itérations 1 et 2 sont en lecture seule ; les itérations 3 et 4 n'écrivent
 *   que lorsqu'une proposition est validée individuellement par l'utilisateur.
 */

const path = require('node:path');
const express = require('express');

const { config, checkConfig } = require('./config');
const auth = require('./auth');
const { getSnapshot, clearCache } = require('./exportService');
const { TodoistError } = require('./todoist');
const { findProposal } = require('./proposals');
const { applyProposal, ProposalError } = require('./applyProposal');
const { describeDay, peekDayPlan, generateDayProposals, findAiProposal, removeAiProposal } = require('./aiProposals');
const { normalizeCheckin, QUESTIONS, DEFAULTS } = require('./checkin');
const { QUESTIONNAIRE } = require('./feedback');
const { AiError } = require('./ai');
const { isValidIsoDate } = require('./dates');
const recycleBin = require('./recycleBin');

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

const TODOIST_HINTS = {
  CONFIG_MISSING:
    'Ajoute TODOIST_API_TOKEN dans les variables d’environnement Orkestr, puis redéploie.',
  TODOIST_AUTH:
    'Vérifie TODOIST_API_TOKEN (intégrations Todoist) dans Orkestr, puis redéploie.',
  TODOIST_FORBIDDEN:
    'Le token n’a peut-être pas les droits nécessaires (data:read pour lire, data:read_write pour écrire). Vérifie-le dans Todoist.',
  RATE_LIMITED: 'Todoist limite les appels : attends un peu puis réessaie.',
  NETWORK_ERROR: 'Impossible de joindre Todoist depuis le serveur. Réessaie dans un instant.',
  TODOIST_UPSTREAM: 'Todoist a renvoyé une erreur temporaire. Réessaie dans un instant.',
  TODOIST_BAD_RESPONSE: 'La réponse de Todoist est illisible. Réessaie dans un instant.',
  TODOIST_BAD_REQUEST: 'Todoist a refusé la requête de lecture.',
  TODOIST_NOT_FOUND: 'Une ressource Todoist est introuvable (compte modifié ?).',
};

const API_STATUS = {
  CONFIG_MISSING: 503,
  TODOIST_AUTH: 502,
  TODOIST_FORBIDDEN: 502,
  TODOIST_NOT_FOUND: 502,
  TODOIST_BAD_REQUEST: 502,
  TODOIST_UPSTREAM: 502,
  TODOIST_BAD_RESPONSE: 502,
  RATE_LIMITED: 503,
  NETWORK_ERROR: 504,
};

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function securityHeaders(req, res, next) {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'none'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "img-src 'self' data:",
      "style-src 'self'",
      "script-src 'self'",
      "connect-src 'self'",
      "manifest-src 'self'",
    ].join('; ')
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

function originIsSame(req) {
  const host = (req.get('host') || '').toLowerCase();
  for (const header of ['origin', 'referer']) {
    const raw = req.get(header);
    if (!raw) continue;
    try {
      const parsed = new URL(raw);
      if (parsed.host.toLowerCase() !== host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function requireSameOrigin(req, res, next) {
  if (!originIsSame(req)) {
    return res.status(403).json({
      error: { code: 'BAD_ORIGIN', message: 'Origine de la requête refusée.' },
    });
  }
  next();
}

function requireAppHeader(req, res, next) {
  if (req.get('x-app-request') !== '1') {
    return res.status(403).json({
      error: { code: 'MISSING_HEADER', message: 'Requête non reconnue.' },
    });
  }
  next();
}

function requireApiAuth(req, res, next) {
  if (auth.isAuthenticated(req)) return next();
  return res.status(401).json({
    error: { code: 'SESSION_REQUIRED', message: 'Session expirée. Reconnecte-toi.' },
  });
}

function requirePageAuth(req, res, next) {
  if (auth.isAuthenticated(req)) return next();
  return res.redirect(302, '/login');
}

function formatFilenameTimestamp(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}-${parts.hour}${parts.minute}`;
}

function createApp() {
  const configProblems = checkConfig();
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  const attempts = new Map(); // ip -> { count, resetAt }

  function pruneAttempts(now) {
    if (attempts.size < 500) return;
    for (const [key, entry] of attempts.entries()) {
      if (entry.resetAt <= now) attempts.delete(key);
    }
  }

  function loginRetryAfter(ip) {
    const now = Date.now();
    pruneAttempts(now);
    const entry = attempts.get(ip);
    if (!entry || entry.resetAt <= now) return 0;
    return entry.count >= LOGIN_MAX_ATTEMPTS
      ? Math.ceil((entry.resetAt - now) / 1000)
      : 0;
  }

  function recordLoginFailure(ip) {
    const now = Date.now();
    const entry = attempts.get(ip);
    if (!entry || entry.resetAt <= now) {
      attempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
      return;
    }
    entry.count += 1;
  }

  app.use(securityHeaders);
  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      console.log(
        `${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode} ${durationMs.toFixed(0)}ms`
      );
    });
    next();
  });
  app.use(express.json({ limit: '16kb' }));

  const publicDir = path.join(__dirname, '..', 'public');
  const viewsDir = path.join(__dirname, '..', 'views');

  app.use(
    express.static(publicDir, {
      index: false,
      dotfiles: 'deny',
      etag: true,
      maxAge: 0,
      setHeaders(res) {
        res.setHeader('Cache-Control', 'no-cache');
      },
    })
  );

  app.get('/healthz', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, app: 'todoist-triage', version: config.appVersion });
  });

  app.get('/login', (req, res) => {
    if (auth.isAuthenticated(req)) return res.redirect(302, '/');
    res.setHeader('Cache-Control', 'no-store');
    return res.sendFile(path.join(viewsDir, 'login.html'));
  });

  app.get('/', requirePageAuth, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(viewsDir, 'index.html'));
  });

  app.get('/index.html', (req, res) => res.redirect(302, '/'));

  app.get('/api/session', (req, res) => {
    const missing = [];
    if (!config.todoistToken) missing.push('TODOIST_API_TOKEN');
    if (!config.appPassword) missing.push('APP_PASSWORD');
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      authenticated: auth.isAuthenticated(req),
      config_ok: missing.length === 0,
      missing_env: missing,
      app_version: config.appVersion,
      timezone: config.timezone,
      ai_enabled: config.aiEnabled,
      ai_model: config.aiModel,
      checkin: { questions: QUESTIONS, defaults: DEFAULTS },
      ignore_feedback: QUESTIONNAIRE,
    });
  });

  app.post(
    '/api/login',
    requireSameOrigin,
    requireAppHeader,
    (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const ip = req.ip || 'unknown';
      const retryAfter = loginRetryAfter(ip);
      if (retryAfter > 0) {
        res.setHeader('Retry-After', String(retryAfter));
        return res.status(429).json({
          error: {
            code: 'LOGIN_RATE_LIMITED',
            message: `Trop de tentatives. Réessaie dans ${Math.ceil(retryAfter / 60)} minute(s).`,
            retry_after: retryAfter,
          },
        });
      }
      if (!auth.isPasswordConfigured()) {
        return res.status(503).json({
          error: {
            code: 'CONFIG_MISSING',
            message: 'APP_PASSWORD n’est pas configuré sur le serveur.',
            hint: 'Ajoute APP_PASSWORD dans les variables d’environnement Orkestr, puis redéploie.',
          },
        });
      }
      if (!auth.verifyPassword(req.body?.password)) {
        recordLoginFailure(ip);
        return res.status(401).json({
          error: { code: 'BAD_PASSWORD', message: 'Mot de passe incorrect.' },
        });
      }
      attempts.delete(ip);
      if (!auth.setSessionCookie(req, res)) {
        return res.status(503).json({
          error: {
            code: 'CONFIG_MISSING',
            message: 'Impossible de créer la session (configuration incomplète).',
          },
        });
      }
      return res.json({ ok: true });
    }
  );

  app.post('/api/logout', requireApiAuth, requireSameOrigin, requireAppHeader, (req, res) => {
    auth.clearSessionCookie(req, res);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true });
  });

  app.get(
    '/api/overview',
    requireApiAuth,
    asyncHandler(async (req, res) => {
      const force = req.query.refresh === '1';
      const { snapshot, cache } = await getSnapshot({ force });

      res.setHeader('Cache-Control', 'no-store');
      res.json({
        ...snapshot,
        trash: recycleBin.list(),
        ai: {
          enabled: config.aiEnabled,
          model: config.aiModel,
          horizon_days: config.capacityHorizonDays,
        },
        meta: { ...snapshot.meta, cache },
      });
    })
  );

  /** Restaure une tâche supprimée (corbeille). */
  app.post(
    '/api/trash/:id/restore',
    requireApiAuth,
    requireSameOrigin,
    requireAppHeader,
    asyncHandler(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const id = String(req.params.id || '');
      const restored = await recycleBin.restore(id);
      if (!restored) {
        return res.status(404).json({
          error: { code: 'TRASH_NOT_FOUND', message: 'Cette tâche n’est plus dans la corbeille.' },
        });
      }
      clearCache();
      return res.json({ ok: true, ...restored });
    })
  );

  /**
   * Planifie une journée précise : renvoie ce qui est déjà prévu, la place
   * restante (règle 1-3-5) et les propositions de l'IA pour ce jour.
   * Aucune écriture Todoist ici.
   */
  app.post(
    '/api/day/plan',
    requireApiAuth,
    requireSameOrigin,
    requireAppHeader,
    asyncHandler(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');

      const date = typeof req.body?.date === 'string' ? req.body.date.trim() : '';
      const force = req.body?.force === true;
      const checkin = normalizeCheckin(req.body?.checkin);
      const feedback = Array.isArray(req.body?.feedback) ? req.body.feedback : null;
      // L'analyse IA ne part QUE si `analyze` est explicitement demandé
      // (bouton « Analyser »). Sinon, on se contente de renvoyer l'état du jour
      // et, s'ils existent déjà, les propositions mises en cache.
      const analyze = req.body?.analyze === true;

      // Une analyse explicite relit Todoist en direct : on ne veut pas d'un
      // instantané vieux de 60 s (tâches déplacées, sous-tâches ajoutées…).
      const { snapshot } = await getSnapshot({ force: analyze });
      const days = (snapshot.capacity && snapshot.capacity.days) || [];
      if (!isValidIsoDate(date) || !days.some((day) => day.date === date)) {
        return res.status(400).json({
          error: {
            code: 'BAD_DATE',
            message: 'Date hors du plan. Choisis un jour affiché dans la bande de charge.',
          },
        });
      }

      const day = describeDay(snapshot, date, checkin);
      const base = {
        ok: true,
        date,
        weekday: day.weekday,
        rule: day.rule,
        load: day.load,
        allowed: day.allowed,
        can_add: day.canAdd,
        to_remove: day.toRemove,
        capacity_label: day.label,
        capacity_notes: day.notes,
        total: day.total,
        planned: day.planned,
        checkin,
      };

      if (!config.aiEnabled) {
        return res.json({ ...base, ai: false, proposals: [], splits: [], renames: [], strategy: null, cached: false });
      }

      // Lecture seule : pas de nouvel appel au modèle.
      if (!analyze) {
        const cached = peekDayPlan(snapshot, date, checkin, feedback);
        if (cached) {
          return res.json({
            ...base,
            ai: true,
            analyzed: true,
            proposals: cached.items,
            splits: cached.splits || [],
            renames: cached.renames || [],
            strategy: cached.strategy || null,
            cached: true,
            usage: null,
          });
        }
        // Rien en cache : on ne montre que l'état du jour, sans générer.
        return res.json({ ...base, ai: true, analyzed: false, proposals: [], splits: [], renames: [], strategy: null, cached: false });
      }

      const plan = await generateDayProposals(snapshot, date, { force, checkin, feedback });

      return res.json({
        ...base,
        ai: true,
        analyzed: true,
        proposals: plan.items,
        splits: plan.splits || [],
        renames: plan.renames || [],
        strategy: plan.summary || null,
        cached: Boolean(plan.cached),
        usage: plan.usage || null,
      });
    })
  );

  app.get(
    '/api/export',
    requireApiAuth,
    asyncHandler(async (req, res) => {
      const { snapshot } = await getSnapshot({ force: true });
      const stamp = formatFilenameTimestamp(new Date(snapshot.meta.generated_at), config.timezone);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="todoist-export-${stamp}.json"`);
      res.setHeader('Cache-Control', 'no-store');
      res.send(JSON.stringify(snapshot, null, 2));
    })
  );

  /**
   * Applique une proposition validée individuellement.
   * Rien ne part vers Todoist sans passer par cette route, et la proposition est
   * recalculée sur un instantané frais pour éviter d'appliquer une action périmée.
   */
  app.post(
    '/api/proposals/:id/apply',
    requireApiAuth,
    requireSameOrigin,
    requireAppHeader,
    asyncHandler(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');

      if (!config.writesEnabled) {
        return res.status(403).json({
          error: {
            code: 'WRITES_DISABLED',
            message: 'Les écritures Todoist sont désactivées sur ce serveur.',
            hint: 'Définis WRITES_ENABLED=true puis redéploie.',
          },
        });
      }

      const id = String(req.params.id || '');
      const overrides = {
        due_date: typeof req.body?.due_date === 'string' ? req.body.due_date : null,
      };

      // On résout la proposition sans forcer une resynchronisation : cela
      // n'invalide pas les autres propositions du lot en cours. Les propositions
      // IA restent résolvables même si les données ont changé entre-temps.
      const { snapshot } = await getSnapshot({ force: false });
      const proposal = findProposal(snapshot, id) || findAiProposal(id);
      if (!proposal) {
        return res.status(409).json({
          error: {
            code: 'PROPOSAL_STALE',
            message: 'Cette proposition n’est plus d’actualité. Recharge la page.',
          },
        });
      }

      let result;
      try {
        result = await applyProposal({ proposal, overrides });
      } catch (error) {
        // Cible supprimée/terminée entre-temps : message clair plutôt qu'une 502.
        if (error instanceof TodoistError && error.code === 'TODOIST_NOT_FOUND') {
          removeAiProposal(id);
          return res.status(409).json({
            error: {
              code: 'PROPOSAL_STALE',
              message: 'La tâche ou le projet visé n’existe plus. Recharge la page.',
            },
          });
        }
        throw error;
      }

      // La donnée a changé : on vide le cache de lecture et on retire seulement
      // la proposition appliquée, sans toucher au reste du lot.
      clearCache();
      removeAiProposal(id);

      return res.json({
        ok: true,
        proposal_id: id,
        type: proposal.type,
        verified: result.verified,
        message: result.message,
        effects: result.effects,
      });
    })
  );

  app.use('/api', (req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route inconnue.' } });
  });

  app.use((req, res) => {
    res.status(404).send('Page introuvable. <a href="/">Retour</a>');
  });

  // Gestionnaire d'erreurs centralisé : messages utiles, pas de fuite technique.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);

    if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
      return res.status(400).json({
        error: { code: 'BAD_JSON', message: 'Corps de requête JSON invalide.' },
      });
    }

    if (err instanceof ProposalError) {
      return res.status(400).json({
        error: { code: err.code, message: err.message },
      });
    }

    if (err instanceof AiError) {
      const status = err.code === 'AI_TIMEOUT' ? 504 : err.code === 'AI_DISABLED' ? 403 : 502;
      console.error(`[ia] ${err.code}`);
      return res.status(status).json({
        error: {
          code: err.code,
          message: err.message,
          hint:
            err.code === 'AI_UPSTREAM' || err.code === 'AI_NETWORK'
              ? 'Réessaie dans un instant ; l’IA a peut-être un souci passager.'
              : null,
        },
      });
    }

    if (err instanceof TodoistError) {
      const status = API_STATUS[err.code] || 502;
      const payload = {
        error: {
          code: err.code,
          message: err.message,
          hint: TODOIST_HINTS[err.code] || null,
        },
      };
      if (err.retryAfter) {
        payload.error.retry_after = err.retryAfter;
        res.setHeader('Retry-After', String(err.retryAfter));
      }
      console.error(`[todoist] ${err.code}${err.status ? ` (${err.status})` : ''}`);
      return res.status(status).json(payload);
    }

    console.error('[erreur]', err?.name || 'Error', err?.message || 'inconnue');
    if (!config.isProduction && err?.stack) console.error(err.stack);
    return res.status(500).json({
      error: {
        code: 'INTERNAL',
        message: 'Erreur interne du serveur. Réessaie ; si cela persiste, consulte les logs.',
      },
    });
  });

  // Exposé pour les tests / le démarrage.
  app.locals.configProblems = configProblems;
  return app;
}

module.exports = { createApp };
