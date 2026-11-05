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
const { getSnapshot, getDeepSnapshot, clearCache } = require('./exportService');
const { TodoistError, createTask, getTask } = require('./todoist');
const { findProposal } = require('./proposals');
const { applyProposal, ProposalError } = require('./applyProposal');
const {
  describeDay,
  peekDayPlan,
  generateDayProposals,
  findAiProposal,
  removeAiProposal,
  rememberItems,
} = require('./aiProposals');
const { generatePreparation, generateDecomposition } = require('./prepare');
const { generateSubtaskOrder } = require('./subtaskOrder');
const { generateDayOrder } = require('./dayOrder');
const { generateTaskSuggestions } = require('./taskSuggestions');
const { replaceReminders } = require('./reminders');
const { appendLifeProgress } = require('./lifeContext');
const {
  renumberNumberedChildren,
  nextNumberedTitle,
  hasOrderPrefix,
} = require('./renumber');
const assistantNotes = require('./assistantNotes');
const { normalizeCheckin, QUESTIONS, DEFAULTS } = require('./checkin');
const { QUESTIONNAIRES, KINDS } = require('./feedback');
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
      ignore_feedback: { kinds: KINDS, questionnaires: QUESTIONNAIRES },
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

  /**
   * Nettoyage approfondi : relit Todoist et élargit progressivement la
   * recherche (fantômes plus récents, sous-tâches, doublons entre projets).
   * Aucune écriture : on renvoie un nouvel ensemble de propositions.
   */
  app.post(
    '/api/cleanup/scan',
    requireApiAuth,
    requireSameOrigin,
    requireAppHeader,
    asyncHandler(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const depth = Math.max(1, Math.min(4, Number.parseInt(req.body?.depth, 10) || 1));
      const snapshot = await getDeepSnapshot({ depth });

      // Les propositions approfondies ne figurent pas dans l'instantané normal :
      // on les mémorise pour que leur validation reste résolvable.
      rememberItems(snapshot.proposals || []);

      return res.json({
        ok: true,
        depth,
        scan: snapshot.meta.scan || null,
        proposals: snapshot.proposals,
        summary: snapshot.summary.proposals,
        project_diagnosis: snapshot.summary.project_diagnosis,
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

  /**
   * Réorganise la journée : ordre de priorité + ordre d'exécution proposé.
   * Lecture seule, aucun ordre n'est écrit dans Todoist.
   */
  app.post(
    '/api/day/order',
    requireApiAuth,
    requireSameOrigin,
    requireAppHeader,
    asyncHandler(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');

      const date = typeof req.body?.date === 'string' ? req.body.date.trim() : '';
      if (!isValidIsoDate(date)) {
        return res.status(400).json({
          error: { code: 'BAD_DATE', message: 'Date invalide.' },
        });
      }

      const force = req.body?.force === true;
      const schedule = {
        phoneStart: req.body?.phoneStart,
        otherStart: req.body?.otherStart,
        end: req.body?.end,
        breakMinutes: req.body?.breakMinutes,
        lunchStart: req.body?.lunchStart,
        lunchEnd: req.body?.lunchEnd,
      };
      const { snapshot } = await getSnapshot({ force: false });
      const result = await generateDayOrder(snapshot, date, { force, schedule });

      return res.json({
        ok: true,
        date,
        schedule: result.schedule,
        tasks: result.tasks,
        priority: result.priority,
        execution: result.execution,
        variants: result.variants || [],
        strategy: result.summary || null,
        cached: Boolean(result.cached),
        usage: result.usage || null,
      });
    })
  );

  /**
   * Active / met à jour les rappels Todoist natifs d'une planification.
   * `known` = rappels créés précédemment par l'app (mapping côté navigateur).
   */
  app.post(
    '/api/day/reminders',
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
          },
        });
      }

      const date = typeof req.body?.date === 'string' ? req.body.date.trim() : '';
      if (!isValidIsoDate(date)) {
        return res.status(400).json({
          error: { code: 'BAD_DATE', message: 'Date invalide.' },
        });
      }

      const clear = req.body?.clear === true;
      const { snapshot } = await getSnapshot({ force: false });
      let variant = null;
      let items = [];

      if (!clear && Array.isArray(req.body?.items)) {
        // Plan personnalisé (ordre déplacé à la main) : on utilise les créneaux
        // exacts envoyés par le client, sans relancer l'IA.
        const custom = req.body.items
          .filter(
            (item) =>
              item &&
              item.taskId &&
              item.date === date &&
              /^\d{2}:\d{2}$/.test(String(item.time || ''))
          )
          .slice(0, 60)
          .map((item) => ({
            taskId: String(item.taskId),
            date,
            time: String(item.time),
          }));
        if (custom.length === 0) {
          return res.status(400).json({
            error: { code: 'NO_ITEMS', message: 'Aucun créneau à rappeler.' },
          });
        }
        items = custom;
      } else {
        const schedule = {
          phoneStart: req.body?.phoneStart,
          otherStart: req.body?.otherStart,
          end: req.body?.end,
          breakMinutes: req.body?.breakMinutes,
          lunchStart: req.body?.lunchStart,
          lunchEnd: req.body?.lunchEnd,
        };
        const order = await generateDayOrder(snapshot, date, { force: false, schedule });
        const variants = order.variants || [];
        variant =
          variants.find((item) => item.key === req.body?.variant) || variants[0] || null;
        if (!variant) {
          return res.status(400).json({
            error: { code: 'NO_PLAN', message: 'Aucune planification disponible ce jour-là.' },
          });
        }
        items = clear
          ? []
          : (variant.items || []).map((item) => ({
              taskId: item.id,
              date,
              time: item.start,
            }));
      }

      const known = Array.isArray(req.body?.known)
        ? req.body.known
            .filter((entry) => entry && entry.reminderId)
            .slice(0, 100)
            .map((entry) => ({
              taskId: entry.taskId ? String(entry.taskId) : null,
              reminderId: String(entry.reminderId),
            }))
        : [];

      const result = await replaceReminders({
        items,
        known,
        timezone: snapshot.meta.timezone,
      });

      return res.json({
        ok: true,
        date,
        variant: variant ? variant.key : String(req.body?.variant || 'custom'),
        schedule: variant || null,
        created: result.created,
        reused: result.reused,
        deleted: result.deleted,
        mapping: result.mapping,
        errors: result.errors,
      });
    })
  );

  /**
   * Suggère de NOUVELLES tâches à créer pour une journée, à partir des projets,
   * échéances, check-in et place restante. Aucune écriture avant validation.
   */
  app.post(
    '/api/day/suggest',
    requireApiAuth,
    requireSameOrigin,
    requireAppHeader,
    asyncHandler(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');

      if (!config.aiEnabled) {
        return res.status(403).json({
          error: { code: 'AI_DISABLED', message: 'L’IA n’est pas configurée sur ce serveur.' },
        });
      }

      const date = typeof req.body?.date === 'string' ? req.body.date.trim() : '';
      if (!isValidIsoDate(date)) {
        return res.status(400).json({
          error: { code: 'BAD_DATE', message: 'Date invalide.' },
        });
      }

      const checkin = normalizeCheckin(req.body?.checkin);
      const force = req.body?.force === true;
      const exclude = Array.isArray(req.body?.exclude)
        ? req.body.exclude.map((title) => String(title)).slice(0, 80)
        : [];
      const { snapshot } = await getSnapshot({ force: false });
      const result = await generateTaskSuggestions(snapshot, date, {
        checkin,
        force,
        exclude,
      });

      return res.json({
        ok: true,
        date,
        proposals: result.items,
        strategy: result.summary || null,
        cached: Boolean(result.cached),
        usage: result.usage || null,
      });
    })
  );

  /** Prépare une tâche : l'IA propose des sous-tâches de préparation datées. */
  app.post(
    '/api/prepare',
    requireApiAuth,
    requireSameOrigin,
    requireAppHeader,
    asyncHandler(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');

      if (!config.aiEnabled) {
        return res.status(403).json({
          error: { code: 'AI_DISABLED', message: 'L’IA n’est pas configurée sur ce serveur.' },
        });
      }

      const taskId = String(req.body?.taskId || '');
      const force = req.body?.force === true;
      if (!taskId) {
        return res.status(400).json({ error: { code: 'BAD_TASK', message: 'Tâche manquante.' } });
      }

      const { snapshot } = await getSnapshot({ force: false });
      const result = await generatePreparation(snapshot, taskId, { force });

      return res.json({
        ok: true,
        task_id: taskId,
        proposals: result.items,
        strategy: result.summary || null,
        cached: Boolean(result.cached),
        usage: result.usage || null,
      });
    })
  );

  /**
   * Ajoute manuellement une sous-tâche depuis l'explorateur.
   * Écriture Todoist explicite (jamais automatique), relue ensuite.
   */
  app.post(
    '/api/tasks/:id/subtasks',
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

      const taskId = String(req.params.id || '');
      const content = String(req.body?.content || '').trim().slice(0, 200);
      if (!content) {
        return res.status(400).json({
          error: { code: 'SUBTASK_EMPTY', message: 'Écris le titre de la sous-tâche.' },
        });
      }

      const dueDate =
        typeof req.body?.due_date === 'string' && isValidIsoDate(req.body.due_date.trim())
          ? req.body.due_date.trim()
          : null;

      // Relecture fraîche : la tâche parente vient peut-être d'être créée.
      const { snapshot } = await getSnapshot({ force: true });
      const parent = snapshot.tasks.find(
        (item) => item.id === taskId && !item.project_archived
      );
      if (!parent) {
        return res.status(404).json({
          error: { code: 'TASK_NOT_FOUND', message: 'Tâche parente introuvable.' },
        });
      }

      // Si le parent a déjà des sous-tâches numérotées (préparation/découpe),
      // la nouvelle reçoit le numéro suivant, puis tout est renuméroté.
      const siblings = snapshot.tasks.filter(
        (item) => item.parent_id === parent.id && !item.project_archived
      );
      const shouldNumber =
        req.body?.numbered === true || siblings.some((item) => hasOrderPrefix(item.display_title || item.content));
      const finalContent = shouldNumber ? nextNumberedTitle(siblings, content) : content;

      const payload = { content: finalContent, parent_id: parent.id };
      if (parent.project_id) payload.project_id = parent.project_id;
      if (parent.section_id) payload.section_id = parent.section_id;
      if (dueDate) payload.due_date = dueDate;

      const created = await createTask(payload);

      // Relecture : la sous-tâche doit exister avec le bon contenu.
      let verified = false;
      try {
        const fresh = await getTask(created?.id);
        verified = Boolean(fresh?.id) && String(fresh.content || '') === finalContent;
      } catch {
        verified = Boolean(created?.id);
      }

      // Recale les numéros (le nouveau est en fin de liste Todoist).
      if (shouldNumber) {
        try {
          const { snapshot: after } = await getSnapshot({ force: true });
          await renumberNumberedChildren(after, parent.id);
        } catch (error) {
          console.error('[renumber] après ajout :', error?.code || error?.message);
        }
      }

      clearCache();
      return res.status(201).json({
        ok: true,
        task_id: created?.id || null,
        parent_id: parent.id,
        content: finalContent,
        verified,
        numbered: shouldNumber,
      });
    })
  );

  /**
   * Renumérote les sous-tâches numérotées d'un parent (après une suppression
   * faite dans Todoist ou pour recaler un ordre). Écriture explicite.
   */
  app.post(
    '/api/tasks/:id/renumber',
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
          },
        });
      }

      const parentId = String(req.params.id || '');
      const { snapshot } = await getSnapshot({ force: true });
      const parent = snapshot.tasks.find(
        (item) => item.id === parentId && !item.project_archived
      );
      if (!parent) {
        return res.status(404).json({
          error: { code: 'TASK_NOT_FOUND', message: 'Tâche parente introuvable.' },
        });
      }

      const result = await renumberNumberedChildren(snapshot, parentId);
      clearCache();
      return res.json({
        ok: true,
        parent_id: parentId,
        updated: result.updated,
        numbered: result.numbered,
      });
    })
  );

  /**
   * Découpe une tâche feuille en sous-tâches proposées par l'IA.
   * Aucune écriture ici : la proposition passe par la validation habituelle.
   */
  app.post(
    '/api/tasks/:id/decompose',
    requireApiAuth,
    requireSameOrigin,
    requireAppHeader,
    asyncHandler(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');

      if (!config.aiEnabled) {
        return res.status(403).json({
          error: { code: 'AI_DISABLED', message: 'L’IA n’est pas configurée sur ce serveur.' },
        });
      }

      const taskId = String(req.params.id || '');
      const force = req.body?.force === true;
      const { snapshot } = await getSnapshot({ force: false });
      const result = await generateDecomposition(snapshot, taskId, { force });

      return res.json({
        ok: true,
        task_id: taskId,
        proposals: result.items,
        strategy: result.summary || null,
        cached: Boolean(result.cached),
        usage: result.usage || null,
      });
    })
  );

  /**
   * Ordonne logiquement les sous-tâches (tous les niveaux) d'une tâche.
   * Lecture seule : l'ordre est affiché avec des numéros, rien n'est écrit.
   */
  app.post(
    '/api/tasks/:id/order',
    requireApiAuth,
    requireSameOrigin,
    requireAppHeader,
    asyncHandler(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');

      if (!config.aiEnabled) {
        return res.status(403).json({
          error: { code: 'AI_DISABLED', message: 'L’IA n’est pas configurée sur ce serveur.' },
        });
      }

      const taskId = String(req.params.id || '');
      const force = req.body?.force === true;
      const { snapshot } = await getSnapshot({ force: false });
      const result = await generateSubtaskOrder(snapshot, taskId, { force });

      return res.json({
        ok: true,
        task_id: taskId,
        orders: result.orders || {},
        changed: result.changed || 0,
        strategy: result.summary || null,
        cached: Boolean(result.cached),
        usage: result.usage || null,
      });
    })
  );

  /**
   * Carnet « Notes & idées » (assistant en bas à droite).
   * Persisté dans data/assistant-notes.json : l'agent OpenCode peut le relire
   * à la prochaine demande pour appliquer toute la liste.
   */
  app.get('/api/notes', requireApiAuth, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      notes: assistantNotes.store.list(),
      stats: assistantNotes.store.stats(),
      kinds: assistantNotes.KINDS,
      kind_labels: assistantNotes.KIND_LABELS,
    });
  });

  app.post(
    '/api/notes',
    requireApiAuth,
    requireSameOrigin,
    requireAppHeader,
    (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        const note = assistantNotes.store.add({
          text: req.body?.text,
          kind: req.body?.kind,
          page: req.body?.page,
          context: req.body?.context,
        });
        return res.status(201).json({ ok: true, note, stats: assistantNotes.store.stats() });
      } catch (error) {
        if (error.code === 'NOTE_EMPTY') {
          return res.status(400).json({
            error: { code: 'NOTE_EMPTY', message: 'Écris d’abord ta note.' },
          });
        }
        throw error;
      }
    }
  );

  app.patch(
    '/api/notes/:id',
    requireApiAuth,
    requireSameOrigin,
    requireAppHeader,
    (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const note = assistantNotes.store.update(req.params.id, {
        done: req.body?.done,
        text: req.body?.text,
        kind: req.body?.kind,
      });
      if (!note) {
        return res.status(404).json({
          error: { code: 'NOTE_NOT_FOUND', message: 'Cette note n’existe plus.' },
        });
      }
      return res.json({ ok: true, note, stats: assistantNotes.store.stats() });
    }
  );

  app.delete(
    '/api/notes/:id',
    requireApiAuth,
    requireSameOrigin,
    requireAppHeader,
    (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const removed = assistantNotes.store.remove(req.params.id);
      if (!removed) {
        return res.status(404).json({
          error: { code: 'NOTE_NOT_FOUND', message: 'Cette note n’existe plus.' },
        });
      }
      return res.json({ ok: true, stats: assistantNotes.store.stats() });
    }
  );

  app.post(
    '/api/notes/clear-done',
    requireApiAuth,
    requireSameOrigin,
    requireAppHeader,
    (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const removed = assistantNotes.store.clearDone();
      return res.json({ ok: true, removed, stats: assistantNotes.store.stats() });
    }
  );

  app.get('/api/notes/export', requireApiAuth, (req, res) => {
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="notes-opencode.md"');
    res.setHeader('Cache-Control', 'no-store');
    res.send(assistantNotes.store.toMarkdown());
  });

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
        subtasks: Array.isArray(req.body?.subtasks)
          ? req.body.subtasks.map((item) => String(item))
          : null,
        preparations: Array.isArray(req.body?.preparations)
          ? req.body.preparations
          : null,
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

      // Une sous-tâche supprimée laisse un trou dans la numérotation : on
      // recale les numéros des frères et sœurs restants.
      const deletedParentId = proposal.action?.restore?.parent_id || null;
      if (proposal.type === 'delete_task' && deletedParentId) {
        try {
          const { snapshot: after } = await getSnapshot({ force: true });
          await renumberNumberedChildren(after, deletedParentId);
        } catch (error) {
          console.error('[renumber] après suppression :', error?.code || error?.message);
        }
      }

      // Une nouvelle tâche issue d'une suggestion est aussi une progression :
      // on l'ajoute au journal de LIFE_CONTEXT.md pour la réutiliser plus tard.
      let progressSaved = false;
      if (proposal.type === 'create_task' && result.effects?.created) {
        const progress = appendLifeProgress({
          title: proposal.action?.content,
          projectName:
            proposal.action?.life_area ||
            proposal.target?.project_name ||
            proposal.target?.name,
          dueDate: result.effects?.due_date || proposal.action?.due_date,
          taskId: result.effects.created,
        });
        progressSaved = progress.saved;
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
        progress_saved: progressSaved,
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
      const status =
        err.code === 'AI_TIMEOUT'
          ? 504
          : err.code === 'AI_DISABLED'
            ? 403
            : err.code === 'TASK_NOT_FOUND'
              ? 404
              : 502;
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
