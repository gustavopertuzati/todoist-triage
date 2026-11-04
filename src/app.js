'use strict';

/**
 * Application Express.
 *
 * Principes :
 * - aucune donnée Todoist n'est accessible sans session ;
 * - le token Todoist reste côté serveur ;
 * - les itérations 1 et 2 sont strictement en lecture seule (aucun appel d'écriture).
 */

const path = require('node:path');
const express = require('express');

const { config, checkConfig } = require('./config');
const auth = require('./auth');
const { getSnapshot } = require('./exportService');
const { TodoistError } = require('./todoist');

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

const TODOIST_HINTS = {
  CONFIG_MISSING:
    'Ajoute TODOIST_API_TOKEN dans les variables d’environnement Orkestr, puis redéploie.',
  TODOIST_AUTH:
    'Vérifie TODOIST_API_TOKEN (intégrations Todoist) dans Orkestr, puis redéploie.',
  TODOIST_FORBIDDEN:
    'Le token n’a peut-être pas les droits nécessaires (data:read). Vérifie-le dans Todoist.',
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
        meta: { ...snapshot.meta, cache },
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
