'use strict';

/*
 * Interface des itérations 1 à 3.
 *
 * Règles :
 * - tous les contenus Todoist sont insérés avec textContent (jamais innerHTML) ;
 * - aucune écriture Todoist n'est possible depuis cette page ;
 * - l'export est un fichier JSON téléchargé, pas un stockage serveur.
 */

(() => {
  const state = {
    data: null,
    query: '',
    loading: false,
    toastTimer: null,
    diagnosisFilter: 'all',
    applied: new Map(),
    ignored: new Set(),
    selectedDate: null,
    dayPlan: null,
    dayLoading: false,
    dayError: null,
    checkinQuestions: [],
    checkinDefaults: {},
    checkins: {},
    ignoreFeedback: null,
    feedback: {},
    assistant: { notes: [], stats: { pending: 0, total: 0 }, open: false, loading: false },
    prepare: {
      open: false,
      loading: false,
      taskId: null,
      title: '',
      proposals: [],
      strategy: null,
      error: null,
    },
    cleanup: { depth: 0, scan: null, loading: false },
    dayOrder: {
      date: null,
      loading: false,
      error: null,
      data: null,
      mode: 'execution',
      variant: 'equilibre',
    },
    reminderPlans: {},
    remindersBusy: false,
    taskDetail: {
      open: false,
      taskId: null,
      loading: false,
      error: null,
      strategy: null,
      proposals: [],
      orders: {},
      orderSummary: null,
      orderLoading: false,
      orderError: null,
    },
  };

  const els = {
    loading: document.getElementById('loading'),
    content: document.getElementById('content'),
    errorPanel: document.getElementById('error-panel'),
    errorTitle: document.getElementById('error-title'),
    errorMessage: document.getElementById('error-message'),
    errorHint: document.getElementById('error-hint'),
    retryBtn: document.getElementById('retry-btn'),
    refreshBtn: document.getElementById('refresh-btn'),
    exportBtn: document.getElementById('export-btn'),
    logoutBtn: document.getElementById('logout-btn'),
    todayLabel: document.getElementById('today-label'),
    syncedAt: document.getElementById('synced-at'),
    warningsPanel: document.getElementById('warnings-panel'),
    warningsList: document.getElementById('warnings-list'),
    widgetTitle: document.getElementById('widget-title'),
    kpis: document.getElementById('kpis'),
    widgetSummary: document.getElementById('widget-summary'),
    widgetLists: document.getElementById('widget-lists'),
    dayOrderBtn: document.getElementById('day-order-btn'),
    dayOrder: document.getElementById('day-order'),
    proposalsCount: document.getElementById('proposals-count'),
    capacity: document.getElementById('capacity'),
    dayPlan: document.getElementById('day-plan'),
    weekRecap: document.getElementById('week-recap'),
    proposalsNote: document.getElementById('proposals-note'),
    cleanupScanBtn: document.getElementById('cleanup-scan-btn'),
    cleanupScanInfo: document.getElementById('cleanup-scan-info'),
    proposalsList: document.getElementById('proposals-list'),
    trash: document.getElementById('trash'),
    insights: document.getElementById('insights'),
    diagnosisSummary: document.getElementById('diagnosis-summary'),
    diagnosisFilters: document.getElementById('diagnosis-filters'),
    projectDiagnosis: document.getElementById('project-diagnosis'),
    search: document.getElementById('search'),
    searchCount: document.getElementById('search-count'),
    projects: document.getElementById('projects'),
    archivedNote: document.getElementById('archived-note'),
    footerTz: document.getElementById('footer-tz'),
    footerVersion: document.getElementById('footer-version'),
    toast: document.getElementById('toast'),
    // Assistant « Notes & idées ».
    assistantFab: document.getElementById('assistant-fab'),
    assistantBadge: document.getElementById('assistant-badge'),
    assistantPanel: document.getElementById('assistant-panel'),
    assistantClose: document.getElementById('assistant-close'),
    assistantSub: document.getElementById('assistant-sub'),
    assistantForm: document.getElementById('assistant-form'),
    assistantKind: document.getElementById('assistant-kind'),
    assistantText: document.getElementById('assistant-text'),
    assistantCopy: document.getElementById('assistant-copy'),
    assistantClearDone: document.getElementById('assistant-clear-done'),
    assistantList: document.getElementById('assistant-list'),
    // Préparation d'une tâche.
    prepare: document.getElementById('prepare'),
    prepareSub: document.getElementById('prepare-sub'),
    prepareBody: document.getElementById('prepare-body'),
    // Détail d'une tâche et sous-tâches.
    taskDetail: document.getElementById('task-detail'),
    taskDetailTitle: document.getElementById('task-detail-title'),
    taskDetailSub: document.getElementById('task-detail-sub'),
    taskDetailBody: document.getElementById('task-detail-body'),
  };

  const TODOIST_COLORS = new Set([
    'berry_red', 'red', 'orange', 'yellow', 'olive_green', 'lime_green', 'green',
    'mint_green', 'teal', 'sky_blue', 'light_blue', 'blue', 'grape', 'violet',
    'lavender', 'magenta', 'salmon', 'charcoal', 'grey', 'taupe',
  ]);

  // Miroir côté navigateur du regroupement des verdicts (voir src/diagnosis.js).
  const VERDICT_BUCKETS = {
    empty: 'archive',
    dormant: 'review',
    stale: 'review',
    overdue: 'catch_up',
    undated: 'schedule',
    congested: 'split',
    healthy: 'healthy',
  };

  const DIAGNOSIS_FILTERS = [
    { key: 'all', label: 'Tous' },
    { key: 'archive', label: 'À archiver' },
    { key: 'review', label: 'À réviser' },
    { key: 'catch_up', label: 'En retard' },
    { key: 'schedule', label: 'À dater' },
    { key: 'split', label: 'Surchargés' },
    { key: 'healthy', label: 'Sains' },
  ];

  function bucketForVerdict(verdict) {
    return VERDICT_BUCKETS[verdict] || 'healthy';
  }

  const PROPOSAL_TYPE_META = {
    reschedule_overdue: 'Reporter',
    archive_project: 'Archiver',
    split_task: 'Scinder',
    set_due_date: 'Dater',
    prepare_task: 'Préparer',
  };

  function cleanupKindLabel(kind) {
    return (
      { ghost: 'Fantôme', duplicate: 'Doublon', orphan: 'Orpheline' }[kind] || 'À supprimer'
    );
  }
  const IGNORED_KEY = 'todoist-triage:ignored-proposals';
  const REMINDERS_KEY = 'todoist-triage:reminders';

  function loadReminderPlans() {
    try {
      const parsed = JSON.parse(localStorage.getItem(REMINDERS_KEY) || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function saveReminderPlans() {
    try {
      localStorage.setItem(REMINDERS_KEY, JSON.stringify(state.reminderPlans));
    } catch {
      /* stockage indisponible */
    }
  }

  function loadIgnoredProposals() {
    try {
      return new Set(JSON.parse(localStorage.getItem(IGNORED_KEY) || '[]'));
    } catch {
      return new Set();
    }
  }

  function saveIgnoredProposals() {
    try {
      localStorage.setItem(IGNORED_KEY, JSON.stringify([...state.ignored]));
    } catch {
      /* stockage indisponible : on continue sans persister */
    }
  }

  const CHECKIN_KEY = 'todoist-triage:checkins';

  function loadCheckins() {
    try {
      const parsed = JSON.parse(localStorage.getItem(CHECKIN_KEY) || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  const FEEDBACK_KEY = 'todoist-triage:feedback';
  const WINDOW_DAYS = { tomorrow: 1, this_week: 4, next_week: 10, weekend: 5 };

  function loadFeedback() {
    try {
      const parsed = JSON.parse(localStorage.getItem(FEEDBACK_KEY) || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function saveFeedback() {
    try {
      localStorage.setItem(FEEDBACK_KEY, JSON.stringify(state.feedback));
    } catch {
      /* stockage indisponible */
    }
  }

  function feedbackList() {
    return Object.entries(state.feedback).map(([taskId, entry]) => ({ taskId, ...entry }));
  }

  function recordFeedback(taskId, entry) {
    state.feedback[taskId] = { ...entry, at: new Date().toISOString() };
    saveFeedback();
  }

  /** La réponse donnée bloque-t-elle cette proposition pour la date visée ? */
  function feedbackBlocks(proposal, forDate) {
    const id = proposal?.target?.id;
    const entry = state.feedback[id];
    if (!entry) return false;

    const isDefer = proposal.type === 'set_due_date' && proposal.move === true;
    const isSplit = proposal.type === 'split_task';
    const isRename = proposal.type === 'rename_task';
    const isCleanup = proposal.type === 'delete_task' || proposal.type === 'archive_project';

    // « Jamais » généraux, toutes propositions confondues.
    if (entry.kind === 'place' && (entry.reason === 'never' || entry.window === 'never')) return true;
    if (entry.kind === 'split' && entry.alt === 'delete') return true;
    if (entry.kind === 'rename' && entry.reason === 'useless') return true;

    if (isCleanup) return entry.kind === 'cleanup';
    if (isSplit) {
      return entry.kind === 'split' && ['already_split', 'single', 'too_many'].includes(entry.reason);
    }
    if (isRename) return entry.kind === 'rename';
    if (isDefer) {
      // « Je la garde aujourd'hui » → plus aucun report proposé pour cette tâche.
      return entry.kind === 'defer' && entry.reason !== 'can_wait';
    }

    // Ajouts : report éventuel (« pas avant telle date »).
    const days = WINDOW_DAYS[entry.window];
    if (typeof days === 'number') {
      const today = state.data?.meta?.today;
      if (today && (forDate || today) < addDaysIso(today, days)) return true;
    }
    if (entry.scope === 'always' && ['done', 'not_priority'].includes(entry.reason)) return true;
    return false;
  }

  /** Type de questionnaire adapté à la proposition. */
  function kindForProposal(proposal) {
    if (!proposal) return 'place';
    if (proposal.type === 'delete_task' || proposal.type === 'archive_project') return 'cleanup';
    if (proposal.type === 'split_task') return 'split';
    if (proposal.type === 'rename_task') return 'rename';
    if (proposal.type === 'set_due_date' && proposal.move) return 'defer';
    return 'place';
  }

  function saveCheckins() {
    try {
      localStorage.setItem(CHECKIN_KEY, JSON.stringify(state.checkins));
    } catch {
      /* stockage indisponible */
    }
  }

  function getCheckin(date) {
    const stored = state.checkins[date];
    if (stored && typeof stored === 'object') return stored;
    return { ...state.checkinDefaults };
  }

  function setCheckin(date, answers) {
    state.checkins[date] = answers;
    saveCheckins();
  }

  const shortDate = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });
  const shortDateYear = new Intl.DateTimeFormat('fr-FR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  const longDate = new Intl.DateTimeFormat('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  // ---------------------------------------------------------------------------
  // Petites aides DOM
  // ---------------------------------------------------------------------------

  function appendChildren(element, children) {
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      if (child instanceof Node) element.append(child);
      else element.append(document.createTextNode(String(child)));
    }
  }

  function h(tag, attrs = {}, ...children) {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') element.className = value;
      else if (key === 'text') element.textContent = value;
      else if (key === 'dataset') {
        for (const [dataKey, dataValue] of Object.entries(value)) {
          if (dataValue !== null && dataValue !== undefined) element.dataset[dataKey] = dataValue;
        }
      } else if (key.startsWith('on') && typeof value === 'function') {
        element.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (value === true) {
        element.setAttribute(key, '');
      } else {
        element.setAttribute(key, String(value));
      }
    }
    appendChildren(element, children);
    return element;
  }

  function clear(element) {
    element.replaceChildren();
  }

  function colorClass(color) {
    return TODOIST_COLORS.has(color) ? `color-${color}` : 'color-grey';
  }

  // ---------------------------------------------------------------------------
  // Dates
  // ---------------------------------------------------------------------------

  function isoToLocalDate(iso) {
    return new Date(`${iso}T12:00:00`);
  }

  function addDaysIso(iso, days) {
    const date = new Date(`${iso}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }

  function formatDate(iso) {
    if (!iso) return '';
    const today = state.data?.meta?.today;
    if (today && iso === today) return "aujourd'hui";
    if (today && iso === addDaysIso(today, 1)) return 'demain';
    if (today && iso === addDaysIso(today, -1)) return 'hier';
    const date = isoToLocalDate(iso);
    if (Number.isNaN(date.getTime())) return iso;
    const sameYear = today ? iso.slice(0, 4) === today.slice(0, 4) : true;
    return sameYear ? shortDate.format(date) : shortDateYear.format(date);
  }

  function formatTodayLabel(iso) {
    const date = isoToLocalDate(iso);
    if (Number.isNaN(date.getTime())) return '';
    const label = longDate.format(date);
    return label.charAt(0).toUpperCase() + label.slice(1);
  }

  function formatTime(isoString, timeZone) {
    if (!isoString) return '';
    try {
      return new Intl.DateTimeFormat('fr-FR', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(isoString));
    } catch {
      return '';
    }
  }

  // ---------------------------------------------------------------------------
  // Réseau
  // ---------------------------------------------------------------------------

  async function apiJson(url, options = {}) {
    let response;
    try {
      response = await fetch(url, {
        ...options,
        headers: { Accept: 'application/json', ...(options.headers || {}) },
      });
    } catch {
      const error = new Error('Connexion au serveur impossible.');
      error.code = 'NETWORK_ERROR';
      throw error;
    }

    if (response.status === 401) {
      window.location.replace('/login');
      const error = new Error('Session expirée.');
      error.code = 'SESSION_REQUIRED';
      throw error;
    }

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(payload?.error?.message || `Erreur ${response.status}.`);
      error.code = payload?.error?.code || 'HTTP_ERROR';
      error.hint = payload?.error?.hint || null;
      error.retryAfter = payload?.error?.retry_after || null;
      throw error;
    }
    return payload;
  }

  // ---------------------------------------------------------------------------
  // Chargement et états
  // ---------------------------------------------------------------------------

  function setLoading(loading) {
    state.loading = loading;
    els.refreshBtn.disabled = loading;
    els.refreshBtn.classList.toggle('is-spinning', loading);
  }

  function showError(error) {
    els.loading.hidden = true;
    els.content.hidden = true;
    els.errorPanel.hidden = false;

    const titles = {
      CONFIG_MISSING: 'Configuration serveur incomplète',
      TODOIST_AUTH: 'Token Todoist refusé',
      TODOIST_FORBIDDEN: 'Accès Todoist refusé',
      RATE_LIMITED: 'Quota Todoist atteint',
      NETWORK_ERROR: 'Réseau indisponible',
      TODOIST_UPSTREAM: 'Todoist est indisponible',
      TODOIST_BAD_RESPONSE: 'Réponse Todoist illisible',
    };
    els.errorTitle.textContent = titles[error.code] || 'Impossible de lire Todoist';
    els.errorMessage.textContent = error.message || 'Erreur inconnue.';
    if (error.hint) {
      els.errorHint.textContent = error.hint;
      els.errorHint.hidden = false;
    } else {
      els.errorHint.hidden = true;
    }
  }

  async function load({ force = false, silent = false } = {}) {
    if (state.loading) return;
    setLoading(true);
    if (!silent) {
      els.errorPanel.hidden = true;
      els.content.hidden = true;
      els.loading.hidden = false;
    }

    try {
      const data = await apiJson(`/api/overview${force ? '?refresh=1' : ''}`);
      state.data = data;
      // Un rafraîchissement complet repart de l'analyse normale.
      if (force) state.cleanup = { depth: 0, scan: null, loading: false };
      render();
      ensureDefaultDay();
      refreshActiveReminders(data.meta.today);
      els.loading.hidden = true;
      els.content.hidden = false;
      if (force && !silent) toast('Données rafraîchies depuis Todoist.', 'ok');
    } catch (error) {
      if (error.code === 'SESSION_REQUIRED') return;
      if (silent) toast(error.message || 'Rechargement impossible.', 'error');
      else showError(error);
    } finally {
      setLoading(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Rendu principal
  // ---------------------------------------------------------------------------

  function render() {
    const { meta, summary, warnings } = state.data;
    document.title = `Triage · ${formatDate(meta.today)}`;
    els.todayLabel.textContent = formatTodayLabel(meta.today);
    els.syncedAt.textContent = buildSyncLabel(meta);
    els.footerTz.textContent = meta.timezone;
    els.footerVersion.textContent = meta.app_version || '';
    renderWarnings(warnings);
    renderKpis(summary);
    renderWidget();
    renderPlanner();
    renderWeekRecap();
    renderProposals();
    renderTrash();
    renderInsights();
    renderDiagnosis();
    renderProjects();
  }

  function buildSyncLabel(meta) {
    const time = formatTime(meta.generated_at, meta.timezone);
    const cached = meta.cache?.hit
      ? ` · cache de ${meta.cache.age_seconds}s`
      : '';
    return `Synchronisé à ${time}${cached} · ${meta.timezone}`;
  }

  function renderWarnings(warnings) {
    clear(els.warningsList);
    const unique = [...new Set((warnings || []).filter(Boolean))];
    if (unique.length === 0) {
      els.warningsPanel.hidden = true;
      return;
    }
    for (const warning of unique) els.warningsList.append(h('li', {}, warning));
    els.warningsPanel.hidden = false;
  }

  function renderKpis(summary) {
    clear(els.kpis);
    const cards = [
      {
        label: 'Projets actifs',
        value: summary.projects_total,
        sub: `${summary.sections_total} section(s)`,
      },
      {
        label: 'Tâches actives',
        value: summary.tasks_total,
        sub: `${summary.subtasks_total} sous-tâche(s)`,
      },
      {
        label: 'En retard',
        value: summary.overdue_total,
        sub: 'échéance Todoist dépassée',
        tone: summary.overdue_total > 0 ? 'danger' : null,
      },
      {
        label: "Aujourd'hui",
        value: summary.due_today_total,
        sub:
          summary.title_dates_today > 0
            ? `+ ${summary.title_dates_today} à appliquer depuis le titre`
            : 'échéance du jour',
        tone: summary.due_today_total > 0 ? 'today' : null,
      },
      {
        label: 'Sans échéance',
        value: summary.no_due_total,
        sub: `${summary.title_dates_total} date(s) dans le titre`,
      },
      {
        label: 'Sans activité',
        value: summary.projects_empty + summary.projects_no_progress,
        sub: `${summary.projects_empty} vide(s) · ${summary.projects_no_progress} sans progression`,
      },
    ];

    for (const card of cards) {
      els.kpis.append(
        h(
          'article',
          { class: `kpi${card.tone ? ` kpi-${card.tone}` : ''}` },
          h('span', { class: 'kpi-label' }, card.label),
          h('strong', { class: 'kpi-value' }, card.value),
          h('span', { class: 'kpi-sub' }, card.sub)
        )
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Widget Aujourd'hui
  // ---------------------------------------------------------------------------

  function activeTasks() {
    return state.data.tasks.filter((task) => !task.project_archived);
  }

  function tasksDueOn(date) {
    return activeTasks()
      // Le widget montre les tâches principales ET les préparations du jour
      // (pour pouvoir les voir, les découper ou les préparer à leur tour).
      .filter(
        (task) =>
          task.due_date === date && (!task.parent_id || isPreparationTask(task))
      )
      .sort(
        (a, b) =>
          (b.priority || 0) - (a.priority || 0) ||
          a.display_title.localeCompare(b.display_title, 'fr-FR')
      );
  }

  function renderWidget() {
    const tasks = activeTasks();
    const today = state.data.meta.today;
    const focusDate = state.selectedDate || today;
    const isToday = focusDate === today;
    const dayTasks = tasksDueOn(focusDate);
    const overdue = isToday
      ? tasks
          .filter(
            (task) =>
              task.is_overdue &&
              task.due_date !== focusDate &&
              (!task.parent_id || isPreparationTask(task))
          )
          .sort((a, b) => (b.days_overdue || 0) - (a.days_overdue || 0))
      : [];
    const titleOnly = tasks
      .filter((task) => task.date_convention.valid && !task.due_date)
      .sort((a, b) => (a.title_due_date || '').localeCompare(b.title_due_date || '') ||
        a.display_title.localeCompare(b.display_title));
    const conflicts = tasks.filter((task) => task.conflict);

    if (els.widgetTitle) {
      els.widgetTitle.textContent = isToday
        ? 'Le widget « Aujourd’hui »'
        : `Le widget du ${formatTodayLabel(focusDate)}`;
    }

    clear(els.widgetSummary);
    clear(els.widgetLists);

    const stats = [
      {
        tone: dayTasks.length > 0 ? 'ok' : 'muted',
        value: dayTasks.length,
        label: isToday
          ? 'tâche(s) prévue(s) aujourd’hui'
          : `tâche(s) prévue(s) le ${formatDate(focusDate)}`,
      },
      {
        tone: titleOnly.length > 0 ? 'warn' : 'muted',
        value: titleOnly.length,
        label: 'date(s) lue(s) dans le titre, pas encore appliquée(s)',
      },
      {
        tone: conflicts.length > 0 ? 'danger' : 'muted',
        value: conflicts.length,
        label: 'conflit(s) entre titre et échéance',
      },
    ];
    for (const stat of stats) {
      els.widgetSummary.append(
        h(
          'div',
          { class: `widget-stat tone-${stat.tone}` },
          h('strong', {}, stat.value),
          h('span', {}, stat.label)
        )
      );
    }

    // Le clic sur un jour met à jour cette liste : ce sont les tâches du jour
    // sélectionné, pas seulement celles d'aujourd'hui.
    els.widgetLists.append(
      buildListBlock(
        isToday ? 'Visibles aujourd’hui' : `Tâches du ${formatDate(focusDate)}`,
        `${dayTasks.length} tâche(s)`,
        dayTasks.length > 0
          ? dayTasks.slice(0, 12).map((task) => taskLine(task, null, { tools: true }))
          : [
              h(
                'p',
                { class: 'empty-line' },
                isToday
                  ? 'Aucune tâche avec une échéance aujourd’hui.'
                  : 'Aucune tâche prévue ce jour-là.'
              ),
            ],
        'ok'
      )
    );

    if (overdue.length > 0) {
      els.widgetLists.append(
        buildListBlock(
          'En retard (à replacer)',
          `${overdue.length} tâche(s)`,
          overdue.slice(0, 8).map((task) =>
            taskLine(task, `${task.days_overdue || 0} j de retard`, { tools: true })
          ),
          'danger'
        )
      );
    }

    if (titleOnly.length > 0) {
      els.widgetLists.append(
        buildListBlock(
          'Dans le titre, pas encore dans le widget',
          `${titleOnly.length} tâche(s)`,
          titleOnly.slice(0, 8).map((task) =>
            taskLine(task, `${formatDate(task.title_due_date)} · à appliquer`)
          ),
          'warn',
          'Elles n’apparaîtront dans « Aujourd’hui » qu’une fois la date appliquée, dans une itération ultérieure.'
        )
      );
    }

    if (conflicts.length > 0) {
      els.widgetLists.append(
        buildListBlock(
          'Conflits à arbitrer',
          `${conflicts.length} tâche(s)`,
          conflicts.slice(0, 8).map((task) =>
            taskLine(
              task,
              `titre : ${formatDate(task.title_due_date)} / échéance : ${formatDate(task.due_date)}`
            )
          ),
          'danger'
        )
      );
    }

    renderDayOrder();
  }

  function currentFocusDate() {
    return state.selectedDate || state.data?.meta?.today || null;
  }

  async function loadDayOrder() {
    const date = currentFocusDate();
    if (!date || state.dayOrder.loading) return;
    const alreadyLoaded = state.dayOrder.data?.date === date;
    state.dayOrder = {
      date,
      loading: true,
      error: null,
      data: null,
      mode: state.dayOrder.mode || 'execution',
    };
    renderDayOrder();

    try {
      const result = await apiJson('/api/day/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-App-Request': '1' },
        body: JSON.stringify({ date, force: alreadyLoaded }),
      });
      state.dayOrder.data = result;
      state.dayOrder.loading = false;
      state.dayOrder.mode = 'execution';
      renderDayOrder();
      toast('Ordre de la journée prêt.', 'ok');
      if (els.dayOrder && typeof els.dayOrder.scrollIntoView === 'function') {
        els.dayOrder.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    } catch (error) {
      if (error.code === 'SESSION_REQUIRED') return;
      state.dayOrder.loading = false;
      state.dayOrder.error = error.message || 'Impossible d’ordonner la journée.';
      renderDayOrder();
    }
  }

  async function applyReminders({ date, variant, clear = false, silent = false }) {
    if (state.remindersBusy) return;
    state.remindersBusy = true;
    const plan = state.reminderPlans[date];
    const known = plan && Array.isArray(plan.mapping) ? plan.mapping : [];

    try {
      const result = await apiJson('/api/day/reminders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-App-Request': '1' },
        body: JSON.stringify({ date, variant, known, clear }),
      });

      if (clear) {
        delete state.reminderPlans[date];
      } else {
        state.reminderPlans[date] = {
          variant: result.variant || variant,
          mapping: Array.isArray(result.mapping) ? result.mapping : [],
          updatedAt: new Date().toISOString(),
        };
      }
      saveReminderPlans();
      renderDayOrder();

      if (!silent) {
        if (result.errors && result.errors.length > 0) {
          toast(
            `Rappels partiellement créés (${result.errors.length} erreur(s)).`,
            'error'
          );
        } else if (clear) {
          toast('Rappels Todoist désactivés pour cette journée.', 'ok');
        } else {
          toast(
            `Rappels actifs : ${result.created || 0} créé(s), ${result.reused || 0} déjà en place.`,
            'ok'
          );
        }
      }
    } catch (error) {
      if (error.code === 'SESSION_REQUIRED') return;
      if (!silent) toast(error.message || 'Impossible de créer les rappels.', 'error');
    } finally {
      state.remindersBusy = false;
    }
  }

  async function refreshActiveReminders(date) {
    const plan = state.reminderPlans[date];
    if (!plan) return;
    await applyReminders({ date, variant: plan.variant, silent: true });
  }

  /** Prévisualisation locale immédiate pendant que l'IA calcule. */
  function localDayOrderTasks(date) {
    const today = state.data?.meta?.today;
    const list = activeTasks().filter(
      (task) =>
        (!task.parent_id || isPreparationTask(task)) &&
        (task.due_date === date ||
          (date === today && task.is_overdue && task.due_date !== date))
    );
    return list
      .sort(
        (a, b) =>
          (b.priority || 1) - (a.priority || 1) ||
          Number(b.is_overdue) - Number(a.is_overdue) ||
          (a.display_title || '').localeCompare(b.display_title || '', 'fr-FR')
      )
      .slice(0, 12)
      .map((task) => {
        const parent = task.parent_id
          ? (state.data?.tasks || []).find((item) => item.id === task.parent_id)
          : null;
        return {
          id: task.id,
          title: task.display_title || task.content,
          priority_label: task.priority_label,
          size: null,
          overdue: Boolean(task.is_overdue),
          is_prep: isPreparationTask(task),
          parent_title: parent ? cleanTaskTitle(parent) : null,
        };
      });
  }

  function dayOrderRow(task, index, why, slot = null) {
    const sizeLabel = { L: 'Gros', M: 'Moyen', S: 'Petit' };
    return h(
      'div',
      { class: 'day-order-item' },
      h('span', { class: 'day-order-rank' }, `${index + 1}.`),
      h('span', { class: 'pill prio-pill' }, task.priority_label),
      h(
        'div',
        { class: 'day-order-body' },
        h(
          'div',
          { class: 'day-order-title-line' },
          slot
            ? h(
                'span',
                { class: 'day-order-time' },
                `${slot.start}–${slot.end}`
              )
            : null,
          h('span', { class: 'day-order-title' }, task.title),
          task.size
            ? h('span', { class: `pill size-${task.size}` }, sizeLabel[task.size] || task.size)
            : null,
          slot ? h('span', { class: 'day-order-minutes' }, `${slot.minutes} min`) : null,
          slot?.overflow
            ? h('span', { class: 'pill pill-danger' }, 'Après 17h')
            : null,
          task.overdue ? h('span', { class: 'pill pill-danger' }, 'En retard') : null,
          task.is_prep
            ? h(
                'span',
                { class: 'pill pill-soft' },
                `🧩${task.parent_title ? ` de « ${task.parent_title} »` : ''}`
              )
            : null
        ),
        why ? h('span', { class: 'day-order-why' }, why) : null
      )
    );
  }

  function renderDayOrder() {
    if (!els.dayOrder) return;
    const focus = currentFocusDate();
    const data = state.dayOrder.data;
    const sameDay = data && data.date === focus;

    els.dayOrderBtn.disabled = Boolean(state.dayOrder.loading);
    els.dayOrderBtn.textContent = state.dayOrder.loading
      ? '🔀 Analyse de l’ordre…'
      : sameDay
        ? '↻ Recalculer l’ordre'
        : '🔀 Réorganiser la journée';

    if (state.dayOrder.error) {
      els.dayOrder.hidden = false;
      clear(els.dayOrder);
      els.dayOrder.append(
        h('p', { class: 'day-status is-error' }, state.dayOrder.error)
      );
      return;
    }

    if (state.dayOrder.loading) {
      // Affichage immédiat d'un ordre de priorité local, puis l'IA affine
      // l'ordre d'exécution. Le bouton ne donne jamais l'impression de bloquer.
      els.dayOrder.hidden = false;
      clear(els.dayOrder);
      els.dayOrder.append(
        h(
          'div',
          { class: 'day-order-head' },
          h('h3', {}, 'Ordre de priorité (provisoire)')
        ),
        h(
          'p',
          { class: 'day-status' },
          '🧠 Ordre de priorité affiché — je calcule l’ordre d’exécution…'
        )
      );
      const preview = localDayOrderTasks(focus);
      if (preview.length === 0) {
        els.dayOrder.append(h('p', { class: 'empty-line' }, 'Aucune tâche ce jour-là.'));
        return;
      }
      const list = h('div', { class: 'day-order-list' });
      for (const [index, task] of preview.entries()) {
        list.append(dayOrderRow(task, index, null));
      }
      els.dayOrder.append(list);
      return;
    }

    if (!sameDay) {
      els.dayOrder.hidden = true;
      clear(els.dayOrder);
      return;
    }

    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const variants = Array.isArray(data.variants) ? data.variants : [];
    const variant =
      variants.find((item) => item.key === state.dayOrder.variant) ||
      variants[0] ||
      null;
    if (variant) state.dayOrder.variant = variant.key;

    const whyById = new Map(
      (data.execution || []).map((entry) => [
        typeof entry === 'string' ? entry : entry.id,
        typeof entry === 'string' ? null : entry.why,
      ])
    );
    const ordered = variant
      ? [...variant.items]
          .sort((a, b) => a.start.localeCompare(b.start))
          .map((slot) => ({
            id: slot.id,
            why: whyById.get(slot.id) || null,
            slot,
          }))
      : (data.execution || []).map((entry) => ({
          id: typeof entry === 'string' ? entry : entry.id,
          why: typeof entry === 'string' ? null : entry.why,
          slot: null,
        }));

    els.dayOrder.hidden = false;
    clear(els.dayOrder);
    els.dayOrder.append(
      h(
        'div',
        { class: 'day-order-head' },
        h(
          'h3',
          {},
          focus === state.data?.meta?.today
            ? 'Ordre du jour'
            : `Ordre du ${formatDate(focus)}`
        )
      )
    );

    if (variants.length > 0) {
      els.dayOrder.append(
        h(
          'div',
          { class: 'day-order-variants' },
          h('span', { class: 'fine-print' }, 'Planification :'),
          h(
            'div',
            { class: 'chips' },
            variants.map((item) =>
              h(
                'button',
                {
                  type: 'button',
                  class: `chip${variant && item.key === variant.key ? ' is-active' : ''}`,
                  onclick: () => {
                    state.dayOrder.variant = item.key;
                    renderDayOrder();
                  },
                },
                item.label
              )
            )
          )
        )
      );
    }

    if (data.strategy) {
      els.dayOrder.append(h('p', { class: 'day-strategy' }, `🧠 ${data.strategy}`));
    }

    if (ordered.length === 0) {
      els.dayOrder.append(h('p', { class: 'empty-line' }, 'Aucune tâche à ordonner ce jour-là.'));
      return;
    }

    const list = h('div', { class: 'day-order-list' });
    for (const [index, entry] of ordered.entries()) {
      const task = byId.get(entry.id);
      if (!task) continue;
      list.append(dayOrderRow(task, index, entry.why, entry.slot));
    }
    els.dayOrder.append(list);

    if (variant) {
      const plan = state.reminderPlans[focus];
      const active = Boolean(plan && plan.variant === variant.key);
      const actions = h('div', { class: 'day-order-actions' });
      const remindBtn = h(
        'button',
        { type: 'button', class: 'btn btn-primary btn-small' },
        active ? '✅ Mettre à jour les rappels' : '🔔 Activer les rappels'
      );
      remindBtn.addEventListener('click', () =>
        applyReminders({ date: focus, variant: variant.key })
      );
      actions.append(remindBtn);

      if (plan) {
        const offBtn = h(
          'button',
          { type: 'button', class: 'btn btn-ghost btn-small' },
          'Désactiver'
        );
        offBtn.addEventListener('click', () =>
          applyReminders({ date: focus, variant: variant.key, clear: true })
        );
        actions.append(offBtn);
      }
      els.dayOrder.append(actions);

      if (plan) {
        els.dayOrder.append(
          h(
            'p',
            { class: 'fine-print' },
            `Rappels Todoist actifs sur cette journée (${plan.mapping.length}).`
          )
        );
      }
      if (variant.overflow_minutes > 0) {
        els.dayOrder.append(
          h(
            'p',
            { class: 'day-status is-warn' },
            `Dépassement de ${variant.overflow_minutes} min après 17h : envisage de reporter une tâche.`
          )
        );
      }
    }
  }

  function buildListBlock(title, count, items, tone = 'muted', note = null) {
    return h(
      'div',
      { class: `list-block tone-${tone}` },
      h(
        'div',
        { class: 'list-head' },
        h('h3', {}, title),
        h('span', { class: 'pill' }, count)
      ),
      h('ul', { class: 'plain-list' }, items),
      note ? h('p', { class: 'fine-print' }, note) : null
    );
  }

  function taskLine(task, meta = null, options = {}) {
    const body = h(
      'span',
      { class: 'plain-item-body' },
      h('span', { class: 'plain-item-title' }, task.display_title || task.content),
      meta
        ? h('span', { class: 'plain-item-meta' }, meta)
        : task.due_date
          ? h(
              'span',
              { class: `plain-item-meta${task.is_overdue ? ' is-danger' : ''}` },
              task.is_overdue
                ? `${task.days_overdue} j de retard`
                : task.is_due_today
                  ? "aujourd'hui"
                  : formatDate(task.due_date)
            )
          : null
    );

    if (isPreparationTask(task)) {
      const parent = (state.data?.tasks || []).find((item) => item.id === task.parent_id);
      body.append(
        h(
          'span',
          { class: 'plain-item-meta prep-meta' },
          `🧩 Préparation${parent ? ` de « ${cleanTaskTitle(parent)} »` : ''}`
        )
      );
    }

    // Même actions que dans l'explorateur, directement depuis le widget du jour.
    if (options.tools) {
      const tools = h('div', { class: 'task-tools widget-task-tools' });
      const detailBtn = h(
        'button',
        { type: 'button', class: 'btn btn-ghost btn-small' },
        task.subtask_count ? `🗂 Voir (${task.subtask_count})` : '🗂 Voir la tâche'
      );
      detailBtn.addEventListener('click', () => openTaskDetail(task));
      tools.append(detailBtn);

      if (state.data?.ai?.enabled && !task.subtask_count && task.type !== 'note') {
        const prepareBtn = h(
          'button',
          { type: 'button', class: 'btn btn-ghost btn-small' },
          '✨ Préparer'
        );
        prepareBtn.addEventListener('click', () => openPrepare(task));
        tools.append(prepareBtn);
      }
      body.append(tools);

      if (task.subtask_count) {
        body.append(
          h('span', { class: 'plain-item-meta' }, `${task.subtask_count} sous-tâche(s)`)
        );
      }
    }

    return h(
      'li',
      { class: 'plain-item' },
      h('span', { class: `prio prio-${task.priority}` }, task.priority_label),
      body,
      todoistLink(task.id, 'Ouvrir dans Todoist')
    );
  }

  function todoistLink(taskId, label) {
    return h(
      'a',
      {
        class: 'task-open',
        href: `https://app.todoist.com/app/task/${encodeURIComponent(taskId)}`,
        target: '_blank',
        rel: 'noopener noreferrer',
        'aria-label': label,
        title: label,
      },
      '↗'
    );
  }

  // ---------------------------------------------------------------------------
  // Planification par jour (itération 6)
  // ---------------------------------------------------------------------------

  function proposalTargetLabel(target) {
    if (!target) return '';
    const prefix = target.project_name && target.project_name !== target.name ? `${target.project_name} · ` : '';
    return `${prefix}${target.name}`;
  }

  const weekdayShort = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric' });

  function formatDayChip(iso, today) {
    if (iso === today) return 'auj.';
    if (iso === addDaysIso(today, 1)) return 'dem.';
    return weekdayShort.format(isoToLocalDate(iso));
  }

  function renderPlanner() {
    renderCapacity();
    renderDayPlan();
  }

  function renderCapacity() {
    const capacity = state.data.capacity;
    clear(els.capacity);
    const days = capacity && Array.isArray(capacity.days) ? capacity.days : [];
    if (days.length === 0) {
      els.capacity.hidden = true;
      return;
    }

    els.capacity.hidden = false;
    els.capacity.append(
      h('span', { class: 'capacity-title' }, 'Charge par jour — clique un jour (1 gros · 3 moyens · 5 petits)')
    );

    const today = state.data.meta.today;
    const strip = h('div', { class: 'capacity-strip' });

    for (const day of days) {
      const parts = [];
      if (day.load.L) parts.push(`${day.load.L} gros`);
      if (day.load.M) parts.push(`${day.load.M} moy`);
      if (day.load.S) parts.push(`${day.load.S} pti`);

      strip.append(
        h(
          'button',
          {
            type: 'button',
            class: `capacity-day${day.full ? ' is-full' : day.total === 0 ? ' is-empty' : ''}${
              state.selectedDate === day.date ? ' is-selected' : ''
            }`,
            'aria-pressed': String(state.selectedDate === day.date),
            onclick: () => selectDay(day.date),
          },
          h('span', { class: 'capacity-date' }, formatDayChip(day.date, today)),
          h('span', { class: 'capacity-load' }, parts.length ? parts.join(' · ') : 'libre'),
          h('span', { class: 'capacity-remaining' }, `reste ${day.remaining.L}G ${day.remaining.M}M ${day.remaining.S}P`)
        )
      );
    }

    els.capacity.append(strip);
  }

  function ensureDefaultDay() {
    if (state.selectedDate) return;
    const today = state.data?.meta?.today;
    const days = state.data?.capacity?.days || [];
    if (today && days.some((day) => day.date === today)) selectDay(today);
  }

  async function selectDay(date, { analyze = false, force = false } = {}) {
    state.selectedDate = date;
    state.dayLoading = true;
    state.dayError = null;
    if (state.dayOrder.data?.date !== date) {
      state.dayOrder.data = null;
      state.dayOrder.error = null;
    }
    renderWidget();
    renderPlanner();
    await loadDay(date, { analyze, force });
    if (date !== state.data?.meta?.today && state.reminderPlans[date]) {
      refreshActiveReminders(date);
    }
  }

  async function loadDay(date, { analyze = false, force = false } = {}) {
    try {
      // `analyze:true` (bouton « Analyser ») déclenche l'appel IA.
      // Sans lui, le serveur ne renvoie que l'état du jour + éventuel cache.
      const plan = await apiJson('/api/day/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-App-Request': '1' },
        body: JSON.stringify({ date, force, analyze, checkin: getCheckin(date), feedback: feedbackList() }),
      });
      state.dayPlan = plan;
      state.dayLoading = false;
      state.dayError = null;
    } catch (error) {
      if (error.code === 'SESSION_REQUIRED') return;
      state.dayLoading = false;
      state.dayError = error.message || 'Impossible de charger cette journée.';
    }
    renderDayPlan();
  }

  function adjustCapacity(date, size, delta) {
    const capacity = state.data.capacity;
    if (!capacity || !capacity.rule) return;
    const day = (capacity.days || []).find((d) => d.date === date);
    if (!day) return;
    day.load[size] = Math.max(0, day.load[size] + delta);
    day.remaining[size] = Math.max(0, capacity.rule[size] - day.load[size]);
    day.total = day.load.L + day.load.M + day.load.S;
    day.full = ['L', 'M', 'S'].every((key) => day.remaining[key] === 0);
  }

  function renderDayPlan() {
    clear(els.dayPlan);

    if (!state.selectedDate) {
      els.dayPlan.append(
        h('p', { class: 'empty-line' }, 'Choisis un jour dans la bande de charge ci-dessus.')
      );
      return;
    }

    const plan = state.dayPlan;
    const date = state.selectedDate;

    els.dayPlan.append(
      h(
        'div',
        { class: 'day-head' },
        h('span', { class: 'day-title' }, formatTodayLabel(date)),
        plan ? h('span', { class: 'day-sub' }, dayCapacityText(plan.load)) : null
      )
    );

    const checkinForm = renderCheckinForm(date);
    if (checkinForm) els.dayPlan.append(checkinForm);

    if (state.dayLoading) {
      els.dayPlan.append(
        h('p', { class: 'day-status' }, '🧠 L’IA analyse cette journée et cherche les meilleures tâches…')
      );
      return;
    }

    if (state.dayError) {
      els.dayPlan.append(h('p', { class: 'day-status is-error' }, state.dayError));
      els.dayPlan.append(
        h(
          'button',
          { type: 'button', class: 'btn btn-secondary', onclick: () => selectDay(date, { force: true }) },
          'Réessayer'
        )
      );
      return;
    }

    if (!plan) return;

    const isAnalyzed = plan.analyzed === true && !state.dayLoading;

    // Bouton « Analyser » : seule action qui déclenche l'IA pour cette journée.
    if (plan.ai !== false && isAnalyzed === false) {
      els.dayPlan.append(
        h(
          'div',
          { class: 'day-analyze' },
          h(
            'button',
            { type: 'button', id: 'analyze-btn', class: 'btn btn-primary', onclick: () => selectDay(date, { analyze: true, force: true }) },
            '🧠 Analyser avec l’IA'
          ),
          h('p', { class: 'fine-print' }, 'L’IA proposera les tâches les plus adaptées à cette journée, en tenant compte de ton check-in.')
        )
      );
    }

    els.dayPlan.append(
      h(
        'div',
        { class: 'day-capacity' },
        h('span', {}, plan.ai === false ? 'Capacité :' : 'Objectif selon ton état :'),
        h('span', { class: 'pill size-L' }, `${(plan.allowed || plan.remaining).L} gros`),
        h('span', { class: 'pill size-M' }, `${(plan.allowed || plan.remaining).M} moyens`),
        h('span', { class: 'pill size-S' }, `${(plan.allowed || plan.remaining).S} petits`)
      )
    );

    if (Array.isArray(plan.capacity_notes) && plan.capacity_notes.length > 0) {
      const notes = h('ul', { class: 'day-notes' });
      for (const note of plan.capacity_notes) notes.append(h('li', {}, note));
      els.dayPlan.append(notes);
    }

    const toRemove = plan.to_remove
      ? plan.to_remove.L + plan.to_remove.M + plan.to_remove.S
      : 0;
    if (toRemove > 0) {
      els.dayPlan.append(
        h(
          'p',
          { class: 'day-status is-warn' },
          `Cette journée dépasse ta charge autorisée : reporte environ ${toRemove} tâche(s).`
        )
      );
    }

    if (Array.isArray(plan.planned) && plan.planned.length > 0) {
      const list = h('ul', { class: 'plain-list' });
      for (const task of plan.planned) {
        list.append(
          h(
            'li',
            { class: 'plain-item' },
            h('span', { class: `pill size-${task.size}` }, task.size_label),
            h(
              'span',
              { class: 'plain-item-body' },
              h('span', { class: 'plain-item-title' }, task.title),
              task.subtasks
                ? h('span', { class: 'plain-item-meta' }, `${task.subtasks} sous-tâche(s)`)
                : null
            )
          )
        );
      }
      els.dayPlan.append(
        h(
          'details',
          { class: 'day-planned' },
          h('summary', {}, `Déjà prévu ce jour : ${plan.planned.length} tâche(s)`),
          list
        )
      );
    }

    if (plan.strategy) {
      els.dayPlan.append(h('p', { class: 'day-strategy' }, `🧠 ${plan.strategy}`));
    }

    const proposals = (plan.proposals || []).filter(
      (p) =>
        !state.ignored.has(p.id) &&
        !state.applied.has(p.id) &&
        !feedbackBlocks(p, date)
    );
    const splits = (plan.splits || []).filter(
      (p) =>
        !state.ignored.has(p.id) &&
        !state.applied.has(p.id) &&
        !feedbackBlocks(p, date)
    );
    const renames = (plan.renames || []).filter(
      (p) =>
        !state.ignored.has(p.id) &&
        !state.applied.has(p.id) &&
        !feedbackBlocks(p, date)
    );

    if (proposals.length === 0 && splits.length === 0 && renames.length === 0) {
      if (isAnalyzed === false) {
        // Rien d'analysé : le bloc supérieur affiche déjà le bouton « Analyser ».
        els.dayPlan.append(
          h('p', { class: 'empty-line' }, 'Planifie ce jour pour voir les tâches proposées.')
        );
      } else {
        els.dayPlan.append(
          h(
            'p',
            { class: 'empty-line' },
            plan.ai === false
              ? 'L’IA n’est pas activée : impossible de proposer des tâches.'
              : 'Rien à proposer pour cette journée (place pleine ou aucune tâche adaptée).'
          )
        );
      }
    } else {
      const list = h('div', { class: 'proposals' });
      for (const proposal of proposals) list.append(proposalCard(proposal));
      for (const proposal of renames) list.append(proposalCard(proposal));
      for (const proposal of splits) list.append(proposalCard(proposal));
      els.dayPlan.append(list);
    }

    const reviews = h('div', { class: 'day-actions' });
    if (isAnalyzed) {
      const pending = pendingDayItems();
      if (pending.length > 1) {
        reviews.append(
          h(
            'button',
            { type: 'button', id: 'validate-all-btn', class: 'btn btn-primary', onclick: validateAllDay },
            `Tout valider (${pending.length})`
          )
        );
      }
      reviews.append(
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-ghost btn-small',
            onclick: () => selectDay(date, { analyze: true, force: true }),
          },
          'Nouvelles propositions'
        )
      );
    }
    els.dayPlan.append(reviews);
  }

  function dayCapacityText(load) {
    const parts = [];
    if (load.L) parts.push(`${load.L} gros`);
    if (load.M) parts.push(`${load.M} moy`);
    if (load.S) parts.push(`${load.S} pti`);
    return `Déjà posé : ${parts.length ? parts.join(' · ') : 'rien'}`;
  }

  function renderWeekRecap() {
    const capacity = state.data.capacity;
    const today = state.data.meta.today;
    const days = Array.isArray(capacity?.days) ? capacity.days : [];
    clear(els.weekRecap);
    if (days.length === 0) {
      els.weekRecap.hidden = true;
      return;
    }

    // Jours restants de la semaine courante : du jour au dimanche (ou +6 jours).
    const startIndex = days.findIndex((d) => d.date === today);
    if (startIndex === -1) {
      els.weekRecap.hidden = true;
      return;
    }
    const week = days.slice(startIndex, startIndex + 7);

    const totalPlanned = week.reduce((sum, d) => sum + d.total, 0);
    const freeDays = week.filter((d) => d.total === 0).length;
    const fullDays = week.filter((d) => d.full).length;
    const biggest = week.reduce((a, b) => (b.total > a.total ? b : a), week[0]);

    els.weekRecap.hidden = false;
    els.weekRecap.append(
      h('h3', { class: 'week-title' }, 'Récap de la semaine')
    );

    const lines = [
      h(
        'p',
        { class: 'week-line' },
        `${week.length} journée(s) · ${totalPlanned} tâche(s) planifiée(s) · ${freeDays} jour(s) libre(s) · ${fullDays} jour(s) complet(s).`
      ),
    ];
    if (biggest.total > 0) {
      lines.push(
        h('p', { class: 'week-line' }, `Le jour le plus chargé : ${formatDate(biggest.date)} (${biggest.total} tâche(s)).`)
      );
    }
    if (biggest.total > 0 && biggest.full) {
      lines.push(
        h('p', { class: 'week-note' }, 'La semaine est dense : pense au check-in ou au report des journées pleines.')
      );
    }
    for (const line of lines) els.weekRecap.append(line);
  }

  function renderCheckinForm(date) {
    if (!Array.isArray(state.checkinQuestions) || state.checkinQuestions.length === 0) return null;
    const answers = getCheckin(date);
    const details = h('details', { class: 'checkin' });
    details.open = Boolean(state.checkins[date]);
    details.append(
      h(
        'summary',
        {},
        state.checkins[date]
          ? 'Ton check-in du jour (adapter la journée)'
          : 'Comment te sens-tu ? (adapter la journée)'
      )
    );

    const form = h('div', { class: 'checkin-form' });
    const controls = {};

    for (const question of state.checkinQuestions) {
      if (question.multiple) {
        const raw = answers[question.key] ?? state.checkinDefaults[question.key];
        const current = Array.isArray(raw) ? raw : raw ? [raw] : [];
        const group = h('div', { class: 'checkin-choices' });
        const boxes = [];
        for (const option of question.options) {
          const input = h('input', {
            type: 'checkbox',
            value: option.value,
            checked: current.includes(option.value),
          });
          boxes.push(input);
          group.append(
            h('label', { class: 'checkin-choice' }, input, h('span', {}, option.label))
          );
        }
        controls[question.key] = () => {
          let values = boxes.filter((box) => box.checked).map((box) => box.value);
          if (values.includes('any')) values = ['any'];
          return values.length ? values : ['any'];
        };
        form.append(
          h(
            'div',
            { class: 'checkin-row checkin-row-multi' },
            h(
              'span',
              {},
              question.label,
              question.hint ? h('small', { class: 'checkin-hint' }, question.hint) : null
            ),
            group
          )
        );
        continue;
      }

      const select = h('select', { class: 'checkin-select', 'aria-label': question.label });
      for (const option of question.options) {
        select.append(h('option', { value: option.value }, option.label));
      }
      select.value = answers[question.key] || (state.checkinDefaults[question.key] ?? '');
      controls[question.key] = () => select.value;
      form.append(h('label', { class: 'checkin-row' }, h('span', {}, question.label), select));
    }

    form.append(
      h(
        'button',
        { type: 'button', class: 'btn btn-primary btn-small' },
        'Adapter ma journée'
      )
    );
    form.querySelector('button').addEventListener('click', () => {
      const next = {};
      for (const question of state.checkinQuestions) {
        next[question.key] = controls[question.key]();
      }
      setCheckin(date, next);
      selectDay(date, { analyze: true, force: true });
    });

    details.append(form);

    const filters = Array.isArray(state.data?.filters) ? state.data.filters : [];
    if (filters.length > 0) {
      details.append(
        h(
          'details',
          { class: 'checkin-filters' },
          h('summary', {}, `Filtres Todoist détectés (${filters.length})`),
          h(
            'ul',
            { class: 'checkin-filter-list' },
            filters.map((filter) =>
              h(
                'li',
                {},
                h('strong', {}, filter.name),
                filter.query ? h('span', {}, ` · ${filter.query}`) : null
              )
            )
          )
        )
      );
    }
    return details;
  }

  function proposalCard(proposal) {
    const isDelete = proposal.type === 'delete_task';
    const typeLabel = proposal.type_label || (isDelete ? 'Abandonner' : PROPOSAL_TYPE_META[proposal.type] || proposal.type);
    const card = h('article', { class: `proposal tone-${proposal.tone}` });

    card.append(
      h(
        'div',
        { class: 'proposal-head' },
        h('span', { class: `proposal-type tone-${proposal.tone}` }, typeLabel),
        proposal.cleanup_kind ? h('span', { class: 'pill pill-delete' }, cleanupKindLabel(proposal.cleanup_kind)) : null,
        proposal.source === 'ai' ? h('span', { class: 'pill pill-ai' }, 'IA') : null,
        proposal.size_label ? h('span', { class: `pill size-${proposal.size}` }, proposal.size_label) : null,
        h(
          'div',
          { class: 'proposal-title-wrap' },
          h('span', { class: 'proposal-title' }, proposal.title),
          h('span', { class: 'proposal-target' }, proposalTargetLabel(proposal.target)),
          proposal.ai_group ? h('span', { class: 'proposal-group' }, `Thème : ${proposal.ai_group}`) : null
        )
      ),
      h('p', { class: 'proposal-rationale' }, proposal.rationale),
      h('p', { class: 'proposal-preview' }, proposal.preview)
    );

    let splitChoices = [];
    if (Array.isArray(proposal.subtasks) && proposal.subtasks.length > 0) {
      const selectable = proposal.type === 'split_task';
      const list = h('ul', {
        class: `proposal-subtasks${selectable ? ' is-selectable' : ''}`,
      });
      for (const [index, subtask] of proposal.subtasks.entries()) {
        if (selectable) {
          const input = h('input', {
            type: 'checkbox',
            checked: true,
            'aria-label': `Créer « ${subtask} »`,
          });
          splitChoices.push({ input, index });
          list.append(
            h(
              'li',
              {},
              h(
                'label',
                { class: 'proposal-subtask-choice' },
                input,
                h('span', {}, subtask)
              )
            )
          );
        } else {
          list.append(h('li', {}, subtask));
        }
      }
      card.append(list);
      if (selectable) {
        card.append(
          h(
            'p',
            { class: 'fine-print' },
            'Décoche ce que tu ne veux pas créer ; le reste sera ajouté en sous-tâches.'
          )
        );
      }
    }

    // Préparation : chaque préparation est datée et sélectionnable (déjà faite,
    // inutile…). Les dates se recalent sur les éléments conservés.
    let prepChoices = [];
    if (proposal.format === 'prepare' && Array.isArray(proposal.prep_items)) {
      const list = h('ul', { class: 'proposal-prep is-selectable' });
      for (const item of proposal.prep_items) {
        const input = h('input', {
          type: 'checkbox',
          checked: true,
          'aria-label': `Créer « ${item.title} »`,
        });
        const dateEl = h(
          'span',
          { class: 'proposal-prep-date' },
          item.date ? formatDate(item.date) : ''
        );
        const row = h(
          'label',
          { class: 'proposal-prep-choice' },
          input,
          dateEl,
          h('span', { class: 'proposal-prep-title' }, item.title),
          item.reason ? h('span', { class: 'proposal-prep-reason' }, item.reason) : null
        );
        prepChoices.push({ input, item, dateEl, row, effectiveDate: item.date });
        list.append(h('li', {}, row));
      }
      card.append(list);
      card.append(
        h(
          'p',
          { class: 'fine-print' },
          'Décoche ce que tu as déjà fait ou ce dont tu n’as pas besoin : les dates des préparations gardées se recalent.'
        )
      );

      const previewEl = card.querySelector('.proposal-preview');
      const reflow = () => {
        const active = prepChoices.filter((choice) => choice.input.checked);
        const dates = [
          ...new Set(prepChoices.map((choice) => choice.item.date).filter(Boolean)),
        ].sort();
        active.forEach((choice, index) => {
          const date = dates[index] || dates[dates.length - 1] || choice.item.date || null;
          choice.effectiveDate = date;
          choice.dateEl.textContent = date ? formatDate(date) : '';
        });
        for (const choice of prepChoices) {
          choice.row.classList.toggle('is-done', !choice.input.checked);
        }
        if (previewEl) {
          previewEl.textContent = active.length
            ? `${active.length} préparation(s) : ${active
                .map((choice) => `${choice.item.title} (${choice.effectiveDate || 'sans date'})`)
                .slice(0, 3)
                .join(' · ')}${active.length > 3 ? '…' : ''}`
            : 'Aucune préparation sélectionnée.';
        }
      };
      for (const choice of prepChoices) {
        choice.input.addEventListener('change', reflow);
      }
    }

    let dateInput = null;
    if (Array.isArray(proposal.editable) && proposal.editable.includes('due_date')) {
      dateInput = h('input', {
        type: 'date',
        class: 'proposal-date',
        value: proposal.action.due_date || '',
        'aria-label': 'Date d’échéance à appliquer',
      });
      card.append(
        h('label', { class: 'proposal-date-row' }, h('span', {}, 'Échéance'), dateInput)
      );
    }

    const isPrepare = proposal.type === 'prepare_task';
    const validateBtn = h(
      'button',
      { class: 'btn btn-primary', type: 'button' },
      isDelete ? 'Supprimer' : proposal.action_label || (isPrepare ? 'Créer la préparation' : 'Valider')
    );
    const ignoreBtn = h('button', { class: 'btn btn-ghost', type: 'button' }, 'Ignorer');

    validateBtn.addEventListener('click', () => {
      const selected = splitChoices
        .filter((choice) => choice.input.checked)
        .map((choice) => proposal.subtasks[choice.index]);
      if (proposal.type === 'split_task' && selected.length === 0) {
        toast('Sélectionne au moins une sous-tâche.', 'error');
        return;
      }

      const selectedPrep = prepChoices
        .filter((choice) => choice.input.checked)
        .map((choice) => ({
          title: choice.item.title,
          date: choice.effectiveDate,
          reason: choice.item.reason,
        }));
      if (proposal.type === 'prepare_task' && selectedPrep.length === 0) {
        toast('Sélectionne au moins une préparation.', 'error');
        return;
      }

      validateProposal(
        proposal,
        dateInput,
        validateBtn,
        ignoreBtn,
        proposal.type === 'split_task' ? selected : undefined,
        proposal.type === 'prepare_task' ? selectedPrep : undefined
      );
    });
    ignoreBtn.addEventListener('click', () => openIgnorePanel(card, proposal));

    const actions = h(
      'div',
      { class: 'proposal-actions' },
      validateBtn,
      isPrepare ? null : ignoreBtn
    );
    card.append(actions);
    return card;
  }

  /** Retire une carte localement, sans recharger la page. */
  function removeProposalLocally(proposal) {
    if (state.dayPlan) {
      state.dayPlan.proposals = (state.dayPlan.proposals || []).filter((p) => p.id !== proposal.id);
      state.dayPlan.splits = (state.dayPlan.splits || []).filter((p) => p.id !== proposal.id);
      state.dayPlan.renames = (state.dayPlan.renames || []).filter((p) => p.id !== proposal.id);
    }
    state.data.proposals = (state.data.proposals || []).filter((p) => p.id !== proposal.id);
    renderPlanner();
    renderProposals();
  }

  function feedbackSelect(options, ariaLabel) {
    const select = h('select', { class: 'ignore-select', 'aria-label': ariaLabel });
    for (const option of options) select.append(h('option', { value: option.value }, option.label));
    return select;
  }

  /**
   * Petit questionnaire quand on ignore une proposition : il apprend à l'IA
   * (pourquoi, quand revoir, taille réelle) et évite de la reproposer.
   */
  function openIgnorePanel(card, proposal) {
    const store = state.ignoreFeedback || {};
    const questionnaires = store.questionnaires || {};
    const kind = kindForProposal(proposal);
    const questionnaire = questionnaires[kind] || questionnaires.place || null;
    const taskId = proposal.target.id;
    const title = proposal.target.name;
    const date = state.selectedDate || state.data.meta.today;
    const container = card.querySelector('.proposal-actions');
    if (!container) return;
    clear(container);

    const record = (entry, message) => {
      recordFeedback(taskId, { title, kind, ...entry });
      toast(message || 'Merci, l’IA en tiendra compte.', 'ok');
      removeProposalLocally(proposal);
      // « Je la garde aujourd'hui » → on relance une analyse pour proposer
      // des manières d'adapter plutôt qu'un report.
      if (kind === 'defer' && entry.reason && entry.reason !== 'can_wait') {
        toast('Compris : je cherche comment l’adapter pour aujourd’hui…', 'ok');
        selectDay(date, { analyze: true, force: true });
      }
    };

    // Raccourcis propres au type de proposition.
    const quick = (questionnaire && questionnaire.quick) || [];
    const quickRow = h('div', { class: 'ignore-quick' });
    for (const item of quick) {
      const button = h('button', { type: 'button', class: 'btn btn-ghost btn-small' }, item.label);
      button.addEventListener('click', () => record({ ...item.entry }));
      quickRow.append(button);
    }

    const more = h('button', { type: 'button', class: 'btn btn-secondary btn-small' }, 'Autre raison…');
    quickRow.append(more);
    container.append(quickRow);

    more.addEventListener('click', () => {
      clear(container);
      const questions = (questionnaire && questionnaire.questions) || [];
      const selects = {};
      const rows = [];

      for (const question of questions) {
        const select = feedbackSelect(question.options, question.label);
        selects[question.key] = select;
        const row = h('label', { class: 'ignore-row' }, h('span', {}, question.label), select);
        row.dataset.key = question.key;
        rows.push(row);
      }

      const syncVisibility = () => {
        for (const question of questions) {
          const row = rows.find((r) => r.dataset.key === question.key);
          if (!row) continue;
          if (!question.showIf) {
            row.hidden = false;
            continue;
          }
          const controller = selects[question.showIf.key];
          row.hidden = !(controller && (question.showIf.in || []).includes(controller.value));
        }
      };
      for (const question of questions) {
        if (question.showIf && selects[question.showIf.key]) {
          selects[question.showIf.key].addEventListener('change', syncVisibility);
        }
      }
      syncVisibility();

      const save = h('button', { type: 'button', class: 'btn btn-primary btn-small' }, 'Enregistrer');
      const cancel = h('button', { type: 'button', class: 'btn btn-ghost btn-small' }, 'Annuler');
      save.addEventListener('click', () => {
        const entry = {};
        for (const question of questions) {
          const row = rows.find((r) => r.dataset.key === question.key);
          if (row && row.hidden) continue;
          entry[question.key] = selects[question.key].value;
        }
        record(entry);
      });
      cancel.addEventListener('click', () => {
        renderPlanner();
        renderProposals();
      });

      container.append(h('div', { class: 'ignore-form' }, ...rows), h('div', { class: 'ignore-form-actions' }, save, cancel));
    });
  }

  /** Applique une proposition (réutilisé par la carte et « Tout valider »). */
  async function sendApply(proposal, dueDateValue, subtasks, preparations) {
    const body = {};
    if (dueDateValue) body.due_date = dueDateValue;
    if (Array.isArray(subtasks)) body.subtasks = subtasks;
    if (Array.isArray(preparations)) body.preparations = preparations;
    return apiJson(`/api/proposals/${encodeURIComponent(proposal.id)}/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-App-Request': '1' },
      body: JSON.stringify(body),
    });
  }

  /** Consomme le retour d'une application (maj locale, capacité, render). */
  function consumeApplied(proposal, result) {
    state.applied.set(proposal.id, result);
    if (state.dayPlan) {
      state.dayPlan.proposals = (state.dayPlan.proposals || []).filter((p) => p.id !== proposal.id);
      state.dayPlan.splits = (state.dayPlan.splits || []).filter((p) => p.id !== proposal.id);
    }
    state.data.proposals = (state.data.proposals || []).filter((p) => p.id !== proposal.id);

    const appliedDate = result.effects?.due_date || proposal.action?.due_date;
    if (proposal.type === 'set_due_date' && proposal.size && appliedDate) {
      adjustCapacity(appliedDate, proposal.size, +1);
      if (state.dayPlan && state.dayPlan.date === appliedDate) {
        const size = proposal.size;
        if (state.dayPlan.load && typeof state.dayPlan.load[size] === 'number') {
          state.dayPlan.load[size] += 1;
        }
        if (state.dayPlan.remaining && typeof state.dayPlan.remaining[size] === 'number') {
          state.dayPlan.remaining[size] = Math.max(0, state.dayPlan.remaining[size] - 1);
        }
        if (state.dayPlan.can_add && typeof state.dayPlan.can_add[size] === 'number') {
          state.dayPlan.can_add[size] = Math.max(0, state.dayPlan.can_add[size] - 1);
        }
        if (typeof state.dayPlan.total === 'number') state.dayPlan.total += 1;
      }
    }
  }

  function pendingDayItems() {
    const plan = state.dayPlan;
    const items = [...(plan?.proposals || []), ...(plan?.renames || []), ...(plan?.splits || [])];
    const date = plan?.date;
    return items.filter(
      (p) =>
        !state.ignored.has(p.id) &&
        !state.applied.has(p.id) &&
        !feedbackBlocks(p, date)
    );
  }

  async function validateAllDay() {
    const items = pendingDayItems();
    if (items.length === 0) return;
    const btn = document.getElementById('validate-all-btn');
    if (btn) btn.disabled = true;

    let done = 0;
    for (const proposal of items) {
      try {
        const result = await sendApply(proposal, proposal.action?.due_date);
        consumeApplied(proposal, result);
        done += 1;
      } catch (error) {
        if (error.code === 'SESSION_REQUIRED') return;
        if (error.code === 'PROPOSAL_STALE') {
          toast('Une proposition a expiré — je recharge la journée.', 'ok');
          await selectDay(state.selectedDate || state.data.meta.today, { force: true });
          return;
        }
        toast(error.message || 'Application impossible.', 'error');
        break;
      }
    }
    if (done > 0) toast(`${done} proposition(s) appliquée(s).`, 'ok');
    renderPlanner();
    renderProposals();
    if (btn) btn.disabled = false;
  }

  async function validateProposal(
    proposal,
    dateInput,
    validateBtn,
    ignoreBtn,
    subtasks,
    preparations
  ) {
    validateBtn.disabled = true;
    ignoreBtn.disabled = true;
    const original = validateBtn.textContent;
    validateBtn.textContent = 'Application…';

    try {
      const result = await sendApply(
        proposal,
        dateInput ? dateInput.value : undefined,
        subtasks,
        preparations
      );
      consumeApplied(proposal, result);
      toast(result.message || 'Proposition appliquée.', result.verified === false ? 'error' : 'ok');

      // La préparation crée des sous-tâches : on referme et on relit Todoist.
      if (proposal.type === 'prepare_task') {
        closePrepare();
        await load({ force: true, silent: true });
        return;
      }

      // Découpage depuis le détail d'une tâche : on relit et on rafraîchit.
      if (state.taskDetail.open && proposal.type === 'split_task') {
        await load({ force: true, silent: true });
        state.taskDetail.proposals = [];
        state.taskDetail.strategy = null;
        renderTaskDetail();
        return;
      }

      renderPlanner();
      renderProposals();
    } catch (error) {
      if (error.code === 'SESSION_REQUIRED') return;
      if (error.code === 'PROPOSAL_STALE') {
        toast('Cette proposition a expiré — je recharge la journée.', 'ok');
        await selectDay(state.selectedDate || state.data.meta.today, { force: true });
        return;
      }
      validateBtn.disabled = false;
      ignoreBtn.disabled = false;
      validateBtn.textContent = original;
      toast(error.message || 'Application impossible.', 'error');
    }
  }

  // ---------------------------------------------------------------------------
  // Autres propositions (archivage, scission, retards)
  // ---------------------------------------------------------------------------

  function renderCleanupTools() {
    const depth = state.cleanup.depth || 0;
    els.cleanupScanBtn.disabled = Boolean(state.cleanup.loading);
    els.cleanupScanBtn.textContent = state.cleanup.loading
      ? '🔎 Analyse approfondie…'
      : depth === 0
        ? '🔎 Lancer un nettoyage approfondi'
        : `🔎 Approfondir encore (niveau ${Math.min(4, depth + 1)})`;

    const scan = state.cleanup.scan;
    if (!scan) {
      els.cleanupScanInfo.hidden = true;
      return;
    }
    const extras = [];
    if (scan.include_subtasks) extras.push('sous-tâches incluses');
    if (scan.cross_project_duplicates) extras.push('doublons entre projets');
    els.cleanupScanInfo.hidden = false;
    els.cleanupScanInfo.textContent =
      `Niveau ${scan.depth} · fantômes ≥ ${scan.ghost_days} j · ${scan.scanned_tasks} tâche(s) inspectée(s)` +
      (extras.length ? ` · ${extras.join(' · ')}` : '');
  }

  /** Relance un nettoyage en élargissant progressivement la recherche. */
  async function scanCleanup() {
    if (state.cleanup.loading) return;
    const depth = Math.min(4, (state.cleanup.depth || 0) + 1);
    state.cleanup.loading = true;
    renderCleanupTools();

    try {
      const result = await apiJson('/api/cleanup/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-App-Request': '1' },
        body: JSON.stringify({ depth }),
      });
      state.cleanup.depth = result.depth;
      state.cleanup.scan = result.scan;
      state.data.proposals = Array.isArray(result.proposals) ? result.proposals : [];
      if (state.data.summary) {
        state.data.summary.proposals = result.summary || state.data.summary.proposals;
        if (result.project_diagnosis) {
          state.data.summary.project_diagnosis = result.project_diagnosis;
        }
      }
      renderProposals();
      const total = state.data.proposals.length;
      toast(
        `Nettoyage niveau ${result.depth} : ${total} proposition(s), analyse élargie.`,
        'ok'
      );
    } catch (error) {
      if (error.code === 'SESSION_REQUIRED') return;
      toast(error.message || 'Analyse approfondie impossible.', 'error');
    } finally {
      state.cleanup.loading = false;
      renderCleanupTools();
    }
  }

  function renderProposals() {
    renderCleanupTools();
    const all = Array.isArray(state.data.proposals) ? state.data.proposals : [];
    const summary = state.data.summary.proposals || { total: all.length, truncated: {} };
    const today = state.data.meta.today;
    const visible = all.filter(
      (proposal) =>
        !state.ignored.has(proposal.id) &&
        !state.applied.has(proposal.id) &&
        !feedbackBlocks(proposal, today)
    );

    els.proposalsCount.textContent = String(visible.length);
    clear(els.proposalsList);

    const truncatedTotal = Number(summary.truncated?.total || 0);
    if (truncatedTotal > 0) {
      els.proposalsNote.textContent = `${truncatedTotal} proposition(s) supplémentaire(s) masquée(s) par le plafond d’affichage.`;
      els.proposalsNote.hidden = false;
    } else {
      els.proposalsNote.hidden = true;
    }

    if (visible.length === 0) {
      els.proposalsList.append(
        h(
          'p',
          { class: 'empty-line' },
          'Rien à signaler ici : pas de projet à archiver, pas de doublon, pas de tâche abandonnée, aucun retard.'
        )
      );
      return;
    }

    for (const proposal of visible) els.proposalsList.append(proposalCard(proposal));
  }

  function renderTrash() {
    const trash = Array.isArray(state.data.trash) ? state.data.trash : [];
    clear(els.trash);
    if (trash.length === 0) {
      els.trash.hidden = true;
      return;
    }
    els.trash.hidden = false;
    els.trash.append(
      h(
        'details',
        { class: 'trash-list' },
        h('summary', {}, `Corbeille (${trash.length}) — tâches supprimées, récupérables`),
        h(
          'div',
          { class: 'trash-items' },
          trash.map((entry) =>
            h(
              'div',
              { class: 'trash-item' },
              h(
                'span',
                { class: 'trash-title' },
                entry.title,
                entry.project_name ? h('small', {}, ` · ${entry.project_name}`) : null
              ),
              h(
                'button',
                { type: 'button', class: 'btn btn-ghost btn-small', onclick: () => restoreTask(entry.id) },
                'Annuler (restaurer)'
              )
            )
          )
        )
      )
    );
  }

  async function restoreTask(trashId) {
    try {
      const result = await apiJson(`/api/trash/${encodeURIComponent(trashId)}/restore`, {
        method: 'POST',
        headers: { 'X-App-Request': '1' },
      });
      toast(result.title ? `« ${result.title} » restaurée.` : 'Tâche restaurée.', 'ok');
      await load({ silent: true });
    } catch (error) {
      if (error.code === 'SESSION_REQUIRED') return;
      toast(error.message || 'Restauration impossible.', 'error');
    }
  }

  // ---------------------------------------------------------------------------
  // Insights
  // ---------------------------------------------------------------------------

  function renderInsights() {
    const { projects, summary, meta } = state.data;
    clear(els.insights);
    const activeProjects = projects.filter((project) => !project.is_archived);
    const overdue = activeTasks()
      .filter((task) => task.is_overdue)
      .sort((a, b) => (b.days_overdue || 0) - (a.days_overdue || 0));
    const emptyProjects = activeProjects.filter((project) => project.stats.empty);
    const noProgress = activeProjects
      .filter((project) => project.stats.no_progress)
      .sort((a, b) => b.stats.tasks - a.stats.tasks);

    let blocks = 0;

    if (overdue.length > 0) {
      blocks += 1;
      els.insights.append(
        buildListBlock(
          'En retard',
          `${overdue.length} tâche(s)`,
          overdue.slice(0, 8).map((task) => taskLine(task)),
          'danger',
          overdue.length > 8 ? `Et ${overdue.length - 8} autre(s), visibles dans les projets.` : null
        )
      );
    }

    if (emptyProjects.length > 0) {
      blocks += 1;
      els.insights.append(
        buildListBlock(
          'Projets vides',
          `${emptyProjects.length} projet(s)`,
          emptyProjects.slice(0, 10).map((project) => projectLine(project, 'aucune tâche active')),
          'muted',
          emptyProjects.length > 10 ? `Et ${emptyProjects.length - 10} autre(s).` : null
        )
      );
    }

    if (noProgress.length > 0) {
      blocks += 1;
      els.insights.append(
        buildListBlock(
          'Projets sans progression',
          `${noProgress.length} projet(s)`,
          noProgress.slice(0, 10).map((project) =>
            projectLine(
              project,
              `${project.stats.tasks} tâche(s) · 0 terminée sur ${meta.completed_lookback_days} j`
            )
          ),
          'warn',
          noProgress.length > 10 ? `Et ${noProgress.length - 10} autre(s).` : null
        )
      );
    }

    if (summary.old_undated_total > 0) {
      blocks += 1;
      els.insights.append(
        h(
          'div',
          { class: 'insight-note' },
          h('strong', {}, `${summary.old_undated_total} tâche(s) ancienne(s) sans échéance`),
          h(
            'span',
            {},
            `Créées depuis plus de ${meta.old_task_days || 180} jours et sans date : de bonnes candidates pour une prochaine itération de tri.`
          )
        )
      );
    }

    if (blocks === 0) {
      els.insights.append(
        h(
          'p',
          { class: 'empty-line' },
          'Rien de particulier à signaler. Ton Todoist est peut-être simplement bien rangé.'
        )
      );
    }
  }

  function projectOpenLink(project) {
    return h(
      'a',
      {
        class: 'task-open',
        href: `https://app.todoist.com/app/project/${encodeURIComponent(project.id)}`,
        target: '_blank',
        rel: 'noopener noreferrer',
        'aria-label': `Ouvrir ${project.name} dans Todoist`,
        title: 'Ouvrir dans Todoist',
      },
      '↗'
    );
  }

  function projectLine(project, meta) {
    return h(
      'li',
      { class: 'plain-item' },
      h('span', { class: `project-dot ${colorClass(project.color)}`, 'aria-hidden': 'true' }),
      h(
        'span',
        { class: 'plain-item-body' },
        h('span', { class: 'plain-item-title' }, project.name),
        h('span', { class: 'plain-item-meta' }, meta)
      ),
      projectOpenLink(project)
    );
  }

  // ---------------------------------------------------------------------------
  // Diagnostic des projets (itération 2)
  // ---------------------------------------------------------------------------

  function renderDiagnosis() {
    const { projects, summary } = state.data;
    const plan = summary.project_diagnosis;

    clear(els.diagnosisSummary);
    clear(els.diagnosisFilters);
    clear(els.projectDiagnosis);

    if (!plan || plan.total === 0) {
      els.projectDiagnosis.append(
        h('p', { class: 'empty-line' }, 'Aucun projet actif à analyser.')
      );
      return;
    }

    // Bandeau : combien de projets par nettoyage proposé.
    for (const action of plan.actions) {
      els.diagnosisSummary.append(
        h(
          'div',
          { class: `diag-action tone-${action.tone}` },
          h('strong', {}, action.count),
          h('span', {}, action.label)
        )
      );
    }

    // Filtres (on masque ceux qui ne concernent aucun projet).
    const filters = DIAGNOSIS_FILTERS.filter(
      (filter) => filter.key === 'all' || (plan.counts[filter.key] || 0) > 0
    );
    for (const filter of filters) {
      const active = state.diagnosisFilter === filter.key;
      els.diagnosisFilters.append(
        h(
          'button',
          {
            type: 'button',
            class: `chip${active ? ' is-active' : ''}`,
            'aria-pressed': String(active),
            onclick: () => {
              state.diagnosisFilter = filter.key;
              renderDiagnosis();
            },
          },
          h('span', {}, filter.label),
          h(
            'span',
            { class: 'chip-count' },
            filter.key === 'all' ? plan.counts.all : plan.counts[filter.key]
          )
        )
      );
    }

    // Liste triée : le plus préoccupant d'abord.
    const visible = projects
      .filter((project) => !project.is_archived && project.diagnosis)
      .filter(
        (project) =>
          state.diagnosisFilter === 'all' ||
          bucketForVerdict(project.diagnosis.verdict) === state.diagnosisFilter
      )
      .sort(
        (a, b) =>
          b.diagnosis.score - a.diagnosis.score ||
          b.stats.tasks - a.stats.tasks ||
          a.name.localeCompare(b.name, 'fr-FR')
      );

    if (visible.length === 0) {
      els.projectDiagnosis.append(
        h('p', { class: 'empty-line' }, 'Aucun projet dans ce filtre.')
      );
      return;
    }

    for (const project of visible) els.projectDiagnosis.append(diagnosisCard(project));
  }

  function diagnosisMeta(stats) {
    const parts = [
      `${stats.tasks} tâche(s)`,
      `${stats.overdue} en retard`,
      `${stats.no_due} sans échéance`,
    ];
    if (stats.completed_lookback > 0) {
      parts.push(`${stats.completed_lookback} terminée(s) / 90 j`);
    }
    return parts.join(' · ');
  }

  function diagnosisCard(project) {
    const diagnosis = project.diagnosis;
    const card = h('article', { class: `diag-card tone-${diagnosis.tone}` });

    card.append(
      h(
        'div',
        { class: 'diag-head' },
        h('span', { class: `project-dot ${colorClass(project.color)}`, 'aria-hidden': 'true' }),
        h(
          'div',
          { class: 'diag-title-wrap' },
          h(
            'div',
            { class: 'diag-title-line' },
            h('span', { class: 'diag-name' }, project.name),
            project.is_inbox ? h('span', { class: 'pill pill-soft' }, 'Inbox') : null,
            h('span', { class: `pill verdict-${diagnosis.tone}` }, diagnosis.verdict_label)
          ),
          h('span', { class: 'diag-meta' }, diagnosisMeta(project.stats))
        ),
        projectOpenLink(project)
      )
    );

    if (diagnosis.signals.length > 0) {
      const list = h('ul', { class: 'diag-signals' });
      for (const signal of diagnosis.signals) {
        list.append(
          h(
            'li',
            { class: `diag-signal tone-${signal.tone}` },
            h('span', { class: 'diag-signal-label' }, signal.label),
            h('span', { class: 'diag-signal-detail' }, signal.detail)
          )
        );
      }
      card.append(list);
    }

    if (diagnosis.proposal) {
      card.append(
        h(
          'div',
          { class: `diag-proposal tone-${diagnosis.tone}` },
          h('strong', {}, diagnosis.proposal.title),
          h('span', {}, diagnosis.proposal.detail)
        )
      );
    }

    return card;
  }

  // ---------------------------------------------------------------------------
  // Exploration des projets
  // ---------------------------------------------------------------------------

  function taskMatches(task, query) {
    if (!query) return true;
    const haystack = [
      task.display_title,
      task.content,
      task.description,
      task.priority_label,
      ...(task.labels || []),
      task.due_string || '',
    ]
      .join(' ')
      .toLocaleLowerCase('fr-FR');
    return haystack.includes(query);
  }

  function buildVisibleTaskIds(projectTasks, query) {
    if (!query) return null;
    const byId = new Map(projectTasks.map((task) => [task.id, task]));
    const children = new Map();
    for (const task of projectTasks) {
      if (!task.parent_id || !byId.has(task.parent_id)) continue;
      if (!children.has(task.parent_id)) children.set(task.parent_id, []);
      children.get(task.parent_id).push(task);
    }
    const matched = new Set(
      projectTasks.filter((task) => taskMatches(task, query)).map((task) => task.id)
    );
    const visible = new Set();

    function addWithAncestors(task) {
      let current = task;
      const guard = new Set();
      while (current && !guard.has(current.id)) {
        guard.add(current.id);
        visible.add(current.id);
        current = current.parent_id ? byId.get(current.parent_id) : null;
      }
    }

    function addDescendants(task) {
      const stack = [...(children.get(task.id) || [])];
      const guard = new Set();
      while (stack.length) {
        const current = stack.pop();
        if (guard.has(current.id)) continue;
        guard.add(current.id);
        visible.add(current.id);
        stack.push(...(children.get(current.id) || []));
      }
    }

    for (const id of matched) {
      const task = byId.get(id);
      addWithAncestors(task);
      addDescendants(task);
    }
    return visible;
  }

  function sortTasks(tasks) {
    return tasks.sort((a, b) => {
      const aKey = a.order_key || '';
      const bKey = b.order_key || '';
      if (aKey && bKey && aKey !== bKey) return aKey.localeCompare(bKey);
      const aOrder = Number(a.child_order ?? 0);
      const bOrder = Number(b.child_order ?? 0);
      return aOrder - bOrder || a.display_title.localeCompare(b.display_title, 'fr-FR');
    });
  }

  function renderProjects() {
    const { projects, sections, meta } = state.data;
    const query = state.query.trim().toLocaleLowerCase('fr-FR');
    const activeProjects = projects.filter((project) => !project.is_archived);
    clear(els.projects);

    let visibleCount = 0;
    let visibleProjects = 0;

    for (const project of activeProjects) {
      const projectTasks = state.data.tasks.filter((task) => task.project_id === project.id);
      const projectMatches =
        !query ||
        project.name.toLocaleLowerCase('fr-FR').includes(query) ||
        (project.description || '').toLocaleLowerCase('fr-FR').includes(query);
      const visibleIds = projectMatches
        ? null
        : buildVisibleTaskIds(projectTasks, query);
      const hasVisibleTasks = projectMatches || (visibleIds && visibleIds.size > 0);
      if (!hasVisibleTasks) continue;

      visibleProjects += 1;
      visibleCount += projectMatches
        ? projectTasks.length
        : projectTasks.filter((task) => visibleIds.has(task.id)).length;

      const details = h('details', { class: 'project', open: query ? true : null });
      const summary = h(
        'summary',
        { class: 'project-summary' },
        h('span', { class: `project-dot ${colorClass(project.color)}`, 'aria-hidden': 'true' }),
        h(
          'span',
          { class: 'project-title-wrap' },
          h(
            'span',
            { class: 'project-title-line' },
            h('span', { class: 'project-name' }, project.name),
            project.is_inbox ? h('span', { class: 'pill pill-soft' }, 'Inbox') : null,
            project.stats.overdue > 0
              ? h('span', { class: 'pill pill-danger' }, `${project.stats.overdue} en retard`)
              : null,
            project.stats.no_progress
              ? h('span', { class: 'pill pill-warn' }, 'sans progression')
              : null
          ),
          h(
            'span',
            { class: 'project-meta' },
            `${project.stats.tasks} tâche(s)` +
              (project.stats.sections > 0 ? ` · ${project.stats.sections} section(s)` : '') +
              ` · ${project.stats.completed_lookback} terminée(s) sur ${meta.completed_lookback_days} j`
          )
        ),
        h('span', { class: 'chevron', 'aria-hidden': 'true' }, '⌄')
      );

      const body = h('div', { class: 'project-body' });
      details.append(summary, body);

      let bodyRendered = false;
      const ensureBody = () => {
        if (bodyRendered) return;
        bodyRendered = true;
        renderProjectBody(body, project, sections, projectTasks, visibleIds, query);
      };
      details.addEventListener('toggle', () => {
        if (details.open) ensureBody();
      });
      if (query) ensureBody();

      els.projects.append(details);
    }

    if (visibleProjects === 0) {
      els.projects.append(
        h(
          'p',
          { class: 'empty-line' },
          query ? 'Aucun projet ou tâche ne correspond à cette recherche.' : 'Aucun projet actif.'
        )
      );
    }

    els.searchCount.textContent = query
      ? `${visibleCount} tâche(s) dans ${visibleProjects} projet(s)`
      : '';

    const archived = state.data.summary.projects_archived;
    if (archived > 0) {
      els.archivedNote.textContent = `${archived} projet(s) archivé(s) inclus dans l’export JSON, masqué(s) ici.`;
      els.archivedNote.hidden = false;
    } else {
      els.archivedNote.hidden = true;
    }
  }

  function renderProjectBody(body, project, allSections, projectTasks, visibleIds, query) {
    // Statistiques détaillées du projet.
    body.append(
      h(
        'div',
        { class: 'project-stats' },
        statLine('Sans échéance', project.stats.no_due),
        statLine('Dates dans le titre', project.stats.title_dates),
        statLine('Conflits', project.stats.conflicts),
        project.stats.last_completed_at
          ? h(
              'span',
              { class: 'stat-line' },
              h('span', {}, 'Dernière tâche terminée'),
              h('strong', {}, formatDateOnly(project.stats.last_completed_at))
            )
          : null
      )
    );

    const byId = new Map(projectTasks.map((task) => [task.id, task]));
    const children = new Map();
    const roots = [];
    for (const task of projectTasks) {
      if (task.parent_id && byId.has(task.parent_id)) {
        if (!children.has(task.parent_id)) children.set(task.parent_id, []);
        children.get(task.parent_id).push(task);
      } else {
        roots.push(task);
      }
    }
    for (const list of children.values()) sortTasks(list);
    sortTasks(roots);

    const isVisible = (task) => !visibleIds || visibleIds.has(task.id);
    const visibleRoots = roots.filter(isVisible);

    if (visibleRoots.length === 0) {
      body.append(
        h(
          'p',
          { class: 'empty-line' },
          projectTasks.length === 0
            ? 'Aucune tâche active.'
            : 'Aucune tâche ne correspond à cette recherche.'
        )
      );
      return;
    }

    const projectSections = allSections
      .filter((section) => section.project_id === project.id && !section.is_archived)
      .sort(
        (a, b) =>
          Number(a.section_order ?? 0) - Number(b.section_order ?? 0) ||
          (a.order_key || '').localeCompare(b.order_key || '') ||
          a.name.localeCompare(b.name)
      );
    const sectionIds = new Set(projectSections.map((section) => section.id));
    const groups = new Map();
    groups.set(null, []);
    for (const section of projectSections) groups.set(section.id, []);
    for (const task of visibleRoots) {
      const key = task.section_id && sectionIds.has(task.section_id) ? task.section_id : null;
      groups.get(key).push(task);
    }

    const renderTask = (task, depth, index = 0) => {
      const listItem = h('li', { class: 'task' });
      const row = h('div', { class: `task-row${depth > 0 ? ' is-subtask' : ''}` });

      row.append(h('span', { class: `prio prio-${task.priority}` }, task.priority_label));

      const content = h('div', { class: 'task-content' });
      content.append(
        h(
          'div',
          { class: 'task-head' },
          depth > 0 ? h('span', { class: 'task-order' }, `${index + 1}.`) : null,
          h(
            'span',
            { class: 'task-title' },
            depth > 0 ? cleanTaskTitle(task) : task.display_title || task.content
          )
        )
      );

      const badges = h('div', { class: 'badges' });
      if (task.is_overdue) {
        badges.append(
          h(
            'span',
            { class: 'badge badge-danger' },
            task.days_overdue ? `En retard · ${task.days_overdue} j` : 'En retard'
          )
        );
      } else if (task.is_due_today) {
        badges.append(h('span', { class: 'badge badge-today' }, "Aujourd'hui"));
      } else if (task.due_date) {
        badges.append(h('span', { class: 'badge badge-due' }, `Échéance ${formatDate(task.due_date)}`));
      }

      if (task.due_is_recurring) badges.append(h('span', { class: 'badge' }, '↻ récurrente'));
      if (task.deadline_date) {
        badges.append(h('span', { class: 'badge' }, `Deadline ${formatDate(task.deadline_date)}`));
      }

      if (task.date_convention.valid && !task.due_date) {
        badges.append(
          h(
            'span',
            { class: 'badge badge-title' },
            `Titre → ${formatDate(task.title_due_date)} · à appliquer`
          )
        );
      }
      if (task.conflict) {
        badges.append(
          h(
            'span',
            { class: 'badge badge-warn' },
            `Conflit : titre ${formatDate(task.title_due_date)} / échéance ${formatDate(task.due_date)}`
          )
        );
      }
      if (task.date_convention.detected && !task.date_convention.valid) {
        badges.append(
          h(
            'span',
            { class: 'badge badge-warn' },
            `Date illisible${task.date_convention.reason ? ` · ${task.date_convention.reason}` : ''}`
          )
        );
      }
      for (const label of task.labels) {
        badges.append(h('span', { class: 'badge badge-label' }, `#${label}`));
      }
      if (task.is_old && !task.due_date) {
        badges.append(h('span', { class: 'badge' }, `Ancienne · ${task.age_days} j`));
      }
      if (isPreparationTask(task)) {
        badges.append(h('span', { class: 'badge badge-prep' }, '🧩 Préparation'));
      }
      if (badges.childElementCount > 0) content.append(badges);

      // Détail : voir les sous-tâches à tous les niveaux, en ajouter, découper.
      const tools = h('div', { class: 'task-tools' });
      const detailBtn = h(
        'button',
        { type: 'button', class: 'btn btn-ghost btn-small' },
        task.subtask_count ? `🗂 Voir (${task.subtask_count})` : '🗂 Voir la tâche'
      );
      detailBtn.addEventListener('click', () => openTaskDetail(task));
      tools.append(detailBtn);

      // Préparation : uniquement pour une tâche sans sous-tâches (l'IA propose
      // alors des petites étapes datées, avant ou le jour même).
      if (state.data?.ai?.enabled && !task.subtask_count && task.type !== 'note') {
        const prepareBtn = h(
          'button',
          { type: 'button', class: 'btn btn-ghost btn-small task-prepare' },
          '✨ Préparer'
        );
        prepareBtn.addEventListener('click', () => openPrepare(task));
        tools.append(prepareBtn);
      }
      content.append(tools);

      if (task.description) {
        content.append(
          h(
            'details',
            { class: 'task-note' },
            h('summary', {}, 'Note'),
            h('p', {}, task.description)
          )
        );
      }

      row.append(content, todoistLink(task.id, 'Ouvrir la tâche dans Todoist'));
      listItem.append(row);

      const childTasks = (children.get(task.id) || []).filter(isVisible);
      if (childTasks.length > 0 && depth < 12) {
        const childList = h('ul', { class: 'task-children' });
        for (const [childIndex, child] of childTasks.entries()) {
          childList.append(renderTask(child, depth + 1, childIndex));
        }
        listItem.append(childList);
      }
      return listItem;
    };

    const hasNamedSections = projectSections.length > 0;
    const sectionGroups = [
      { id: null, name: 'Sans section', tasks: groups.get(null) || [] },
      ...projectSections.map((section) => ({
        id: section.id,
        name: section.name,
        tasks: groups.get(section.id) || [],
      })),
    ].filter((group) => group.tasks.length > 0);

    for (const group of sectionGroups) {
      const section = h('section', { class: 'task-section' });
      if (hasNamedSections) {
        section.append(h('h3', { class: 'section-title' }, group.name));
      }
      const list = h('ul', { class: 'task-tree' });
      for (const task of group.tasks) list.append(renderTask(task, 0));
      section.append(list);
      body.append(section);
    }
  }

  function statLine(label, value) {
    return h(
      'span',
      { class: 'stat-line' },
      h('span', {}, label),
      h('strong', {}, value)
    );
  }

  function formatDateOnly(value) {
    const iso = String(value).slice(0, 10);
    return formatDate(iso);
  }

  // ---------------------------------------------------------------------------
  // Préparation d'une tâche (itération 12)
  // ---------------------------------------------------------------------------

  function closePrepare() {
    state.prepare.open = false;
    els.prepare.hidden = true;
  }

  function renderPrepare() {
    clear(els.prepareBody);
    els.prepareSub.textContent = state.prepare.title || '';

    if (state.prepare.loading) {
      els.prepareBody.append(
        h('p', { class: 'day-status' }, '🧠 L’IA cherche des tâches de préparation…')
      );
      return;
    }

    if (state.prepare.error) {
      els.prepareBody.append(h('p', { class: 'day-status is-error' }, state.prepare.error));
      return;
    }

    if (state.prepare.strategy) {
      els.prepareBody.append(h('p', { class: 'day-strategy' }, `🧠 ${state.prepare.strategy}`));
    }

    if (state.prepare.proposals.length === 0) {
      els.prepareBody.append(
        h(
          'p',
          { class: 'empty-line' },
          'Rien à préparer : cette tâche peut se faire telle quelle (ou elle a déjà des sous-tâches).'
        )
      );
      return;
    }

    const list = h('div', { class: 'proposals' });
    for (const proposal of state.prepare.proposals) list.append(proposalCard(proposal));
    els.prepareBody.append(list);
  }

  async function openPrepare(task) {
    state.prepare = {
      open: true,
      loading: true,
      taskId: task.id,
      title: task.display_title || task.content,
      proposals: [],
      strategy: null,
      error: null,
    };
    els.prepare.hidden = false;
    renderPrepare();

    try {
      const result = await apiJson('/api/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-App-Request': '1' },
        body: JSON.stringify({ taskId: task.id }),
      });
      state.prepare.loading = false;
      state.prepare.proposals = Array.isArray(result.proposals) ? result.proposals : [];
      state.prepare.strategy = result.strategy || null;
      renderPrepare();
    } catch (error) {
      if (error.code === 'SESSION_REQUIRED') return;
      state.prepare.loading = false;
      state.prepare.error = error.message || 'Impossible de préparer cette tâche.';
      renderPrepare();
    }
  }

  // ---------------------------------------------------------------------------
  // Détail d'une tâche : sous-tâches, ajout manuel, découpage assisté
  // ---------------------------------------------------------------------------

  function findTaskById(id) {
    return (state.data?.tasks || []).find((task) => task.id === id) || null;
  }

  const PREPARATION_MARKER = 'Préparation créée par Triage';

  /** Une préparation créée par l'app (sous-tâche marquée dans sa note). */
  function isPreparationTask(task) {
    if (!task?.parent_id) return false;
    if (String(task.description || '').includes(PREPARATION_MARKER)) return true;
    // Anciennes préparations (avant le marqueur) : sous-tâche numérotée ET datée.
    // Une découpe classique n'a pas de date ; c'est ce qui les distingue.
    return Boolean(
      task.due_date && /^\s*\d+[.)]\s+/.test(String(task.display_title || task.content || ''))
    );
  }

  /** Titre sans le préfixe « 2. » : les numéros affichés sont dynamiques. */
  function cleanTaskTitle(task) {
    return String(task?.display_title || task?.content || '').replace(/^\s*\d+[.)]\s+/, '');
  }

  function hasNumberedTitle(task) {
    return /^\s*\d+[.)]\s+/.test(String(task?.display_title || task?.content || ''));
  }

  function childTasksOf(id) {
    return (state.data?.tasks || []).filter((task) => task.parent_id === id);
  }

  /** Enfants triés : ordre logique de l'IA s'il existe, sinon ordre Todoist. */
  function orderedChildrenOf(id) {
    const children = sortTasks([...childTasksOf(id)]);
    const order = state.taskDetail.orders ? state.taskDetail.orders[id] : null;
    if (!Array.isArray(order) || order.length === 0) return children;

    const byId = new Map(children.map((child) => [child.id, child]));
    const ordered = [];
    for (const childId of order) {
      const child = byId.get(childId);
      if (!child) continue;
      ordered.push(child);
      byId.delete(childId);
    }
    for (const child of children) if (byId.has(child.id)) ordered.push(child);
    return ordered;
  }

  function closeTaskDetail() {
    state.taskDetail.open = false;
    els.taskDetail.hidden = true;
  }

  function openTaskDetail(task) {
    state.taskDetail = {
      open: true,
      taskId: task.id,
      loading: false,
      error: null,
      strategy: null,
      proposals: [],
      orders: {},
      orderSummary: null,
      orderLoading: false,
      orderError: null,
    };
    els.taskDetail.hidden = false;
    renderTaskDetail();
    // L'ordre logique est calculé automatiquement dès qu'il y a plusieurs
    // sous-tâches. L'affichage actuel reste visible pendant l'analyse.
    if (childTasksOf(task.id).length > 1) loadSubtaskOrder(task);
  }

  function renderTaskNode(task, depth, index) {
    const node = h('li', { class: 'task-detail-node' });
    const head = h('div', { class: 'task-detail-node-head' });
    head.append(h('span', { class: 'task-detail-order' }, `${index + 1}.`));
    const link = h(
      'button',
      { type: 'button', class: 'task-detail-link' },
      cleanTaskTitle(task)
    );
    link.addEventListener('click', () => openTaskDetail(task));
    head.append(link);

    if (task.due_date) {
      head.append(h('span', { class: 'badge badge-due' }, formatDate(task.due_date)));
    }
    if (task.subtask_count) {
      head.append(h('span', { class: 'pill pill-soft' }, `${task.subtask_count} sous-tâche(s)`));
    }
    node.append(head);

    if (depth < 12) {
      const children = orderedChildrenOf(task.id);
      if (children.length > 0) {
        const list = h('ul', { class: 'task-detail-children' });
        for (const [childIndex, child] of children.entries()) {
          list.append(renderTaskNode(child, depth + 1, childIndex));
        }
        node.append(list);
      }
    }
    return node;
  }

  async function renumberSubtasks(task) {
    try {
      const result = await apiJson(`/api/tasks/${encodeURIComponent(task.id)}/renumber`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-App-Request': '1' },
        body: JSON.stringify({}),
      });
      toast(
        result.updated > 0
          ? `${result.updated} numéro(s) recollé(s).`
          : 'Les numéros sont déjà à jour.',
        'ok'
      );
      await load({ force: true, silent: true });
      renderTaskDetail();
    } catch (error) {
      if (error.code === 'SESSION_REQUIRED') return;
      toast(error.message || 'Impossible de renuméroter.', 'error');
    }
  }

  async function loadSubtaskOrder(task, { force = false } = {}) {
    if (state.taskDetail.taskId !== task.id) return;
    state.taskDetail.orderLoading = true;
    state.taskDetail.orderError = null;
    renderTaskDetail();

    try {
      const result = await apiJson(`/api/tasks/${encodeURIComponent(task.id)}/order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-App-Request': '1' },
        body: JSON.stringify({ force }),
      });
      if (state.taskDetail.taskId !== task.id) return;
      state.taskDetail.orders = result.orders || {};
      state.taskDetail.orderSummary = result.strategy || null;
    } catch (error) {
      if (error.code === 'SESSION_REQUIRED') return;
      if (state.taskDetail.taskId !== task.id) return;
      state.taskDetail.orderError = error.message || 'Impossible d’ordonner les sous-tâches.';
    } finally {
      if (state.taskDetail.taskId === task.id) {
        state.taskDetail.orderLoading = false;
        renderTaskDetail();
      }
    }
  }

  function renderTaskDetail() {
    const task = findTaskById(state.taskDetail.taskId);
    clear(els.taskDetailBody);
    if (!task) {
      els.taskDetailTitle.textContent = 'Tâche introuvable';
      els.taskDetailSub.textContent = '';
      els.taskDetailBody.append(
        h('p', { class: 'empty-line' }, 'Cette tâche a peut-être été déplacée. Recharge la page.')
      );
      return;
    }

    els.taskDetailTitle.textContent = cleanTaskTitle(task);
    els.taskDetailSub.textContent = [task.project_name, task.due_date ? `échéance ${formatDate(task.due_date)}` : null]
      .filter(Boolean)
      .join(' · ');

    if (task.description) {
      els.taskDetailBody.append(h('p', { class: 'task-detail-note' }, task.description));
    }

    const children = orderedChildrenOf(task.id);
    const reorderBtn =
      children.length > 1
        ? h(
            'button',
            { type: 'button', class: 'btn btn-ghost btn-small' },
            state.taskDetail.orderLoading ? '🧠 Analyse…' : '🧠 Réordonner'
          )
        : null;
    if (reorderBtn) {
      reorderBtn.disabled = state.taskDetail.orderLoading;
      reorderBtn.addEventListener('click', () => loadSubtaskOrder(task, { force: true }));
    }

    const renumberBtn = children.some(hasNumberedTitle)
      ? h(
          'button',
          { type: 'button', class: 'btn btn-ghost btn-small' },
          '🔄 Renuméroter'
        )
      : null;
    if (renumberBtn) {
      renumberBtn.addEventListener('click', () => renumberSubtasks(task));
    }

    els.taskDetailBody.append(
      h(
        'div',
        { class: 'task-detail-heading-row' },
        h('h3', { class: 'task-detail-heading' }, `Sous-tâches (${children.length})`),
        h('div', { class: 'task-detail-heading-actions' }, renumberBtn, reorderBtn)
      )
    );

    if (state.taskDetail.orderLoading) {
      els.taskDetailBody.append(
        h('p', { class: 'day-status' }, '🧠 Analyse de l’ordre logique de toutes les sous-tâches…')
      );
    } else if (state.taskDetail.orderError) {
      els.taskDetailBody.append(
        h('p', { class: 'day-status is-error' }, state.taskDetail.orderError)
      );
    } else if (state.taskDetail.orderSummary) {
      els.taskDetailBody.append(
        h('p', { class: 'day-strategy' }, `🧠 ${state.taskDetail.orderSummary}`)
      );
    }

    if (children.length > 0) {
      const tree = h('ul', { class: 'task-detail-tree' });
      for (const [index, child] of children.entries()) {
        tree.append(renderTaskNode(child, 1, index));
      }
      els.taskDetailBody.append(tree);
      els.taskDetailBody.append(
        h(
          'p',
          { class: 'fine-print' },
          'Les numéros indiquent l’ordre d’exécution. Clique une sous-tâche pour ouvrir son propre niveau.'
        )
      );
    } else {
      els.taskDetailBody.append(
        h('p', { class: 'empty-line' }, 'Aucune sous-tâche : c’est le dernier niveau.')
      );
      if (state.data?.ai?.enabled) {
        const decomposeBtn = h(
          'button',
          { type: 'button', class: 'btn btn-secondary' },
          state.taskDetail.loading ? '🧠 Découpage en cours…' : '✂️ Découper en petits morceaux'
        );
        decomposeBtn.disabled = state.taskDetail.loading;
        decomposeBtn.addEventListener('click', () => decomposeTask(task));
        els.taskDetailBody.append(h('div', { class: 'task-detail-actions' }, decomposeBtn));
      }
    }

    // Ajout manuel d'une sous-tâche (explorateur).
    const form = h('form', { class: 'task-detail-add' });
    const input = h('input', {
      type: 'text',
      maxlength: '200',
      placeholder: 'Ajouter une sous-tâche…',
      'aria-label': 'Titre de la nouvelle sous-tâche',
    });
    const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-small' }, 'Ajouter');
    form.append(input, submit);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const content = input.value.trim();
      if (content) addSubtask(task, content, submit, input);
    });
    els.taskDetailBody.append(
      h('h3', { class: 'task-detail-heading' }, 'Ajouter une sous-tâche'),
      form
    );

    if (state.taskDetail.error) {
      els.taskDetailBody.append(
        h('p', { class: 'day-status is-error' }, state.taskDetail.error)
      );
    }

    if (state.taskDetail.strategy) {
      els.taskDetailBody.append(
        h('p', { class: 'day-strategy' }, `🧠 ${state.taskDetail.strategy}`)
      );
    }

    if (state.taskDetail.proposals.length > 0) {
      const list = h('div', { class: 'proposals' });
      for (const proposal of state.taskDetail.proposals) list.append(proposalCard(proposal));
      els.taskDetailBody.append(list);
    }
  }

  async function addSubtask(task, content, button, input) {
    button.disabled = true;
    input.disabled = true;
    try {
      const result = await apiJson(`/api/tasks/${encodeURIComponent(task.id)}/subtasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-App-Request': '1' },
        body: JSON.stringify({ content }),
      });
      toast(
        result.verified === false
          ? 'Sous-tâche envoyée, mais la relecture est incomplète.'
          : 'Sous-tâche ajoutée.',
        result.verified === false ? 'error' : 'ok'
      );
      await load({ force: true, silent: true });
      state.taskDetail.proposals = [];
      state.taskDetail.strategy = null;
      renderTaskDetail();
    } catch (error) {
      if (error.code === 'SESSION_REQUIRED') return;
      toast(error.message || 'Impossible d’ajouter la sous-tâche.', 'error');
    } finally {
      if (button.isConnected) button.disabled = false;
      if (input.isConnected) input.disabled = false;
    }
  }

  async function decomposeTask(task) {
    state.taskDetail.loading = true;
    state.taskDetail.error = null;
    state.taskDetail.strategy = null;
    state.taskDetail.proposals = [];
    renderTaskDetail();

    try {
      const result = await apiJson(`/api/tasks/${encodeURIComponent(task.id)}/decompose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-App-Request': '1' },
        body: JSON.stringify({}),
      });
      state.taskDetail.proposals = Array.isArray(result.proposals) ? result.proposals : [];
      state.taskDetail.strategy = result.strategy || null;
    } catch (error) {
      if (error.code === 'SESSION_REQUIRED') return;
      state.taskDetail.error = error.message || 'Découpage impossible.';
    } finally {
      state.taskDetail.loading = false;
      renderTaskDetail();
    }
  }

  // ---------------------------------------------------------------------------
  // Assistant « Notes & idées »
  // ---------------------------------------------------------------------------

  function assistantDate(note) {
    const iso = String(note.created_at || '');
    if (!iso) return '';
    const date = iso.slice(0, 10);
    const time = iso.slice(11, 16);
    return time ? `${formatDate(date)} · ${time}` : formatDate(date);
  }

  function renderAssistant() {
    const stats = state.assistant.stats || { pending: 0, total: 0 };
    els.assistantBadge.textContent = String(stats.pending);
    els.assistantBadge.hidden = stats.pending === 0;
    els.assistantSub.textContent =
      stats.pending === 0 ? 'rien en attente' : `${stats.pending} en attente`;

    clear(els.assistantList);
    const notes = state.assistant.notes || [];
    if (notes.length === 0) {
      els.assistantList.append(
        h('li', { class: 'assistant-empty' }, 'Aucune note pour l’instant.')
      );
      return;
    }

    const labels = { amelioration: 'Amélioration', bug: 'Bug', note: 'Note', idee: 'Idée' };
    for (const note of notes) {
      const toggle = h(
        'button',
        {
          type: 'button',
          class: `assistant-check${note.done ? ' is-done' : ''}`,
          'aria-label': note.done ? 'Remettre à faire' : 'Marquer comme fait',
          title: note.done ? 'Remettre à faire' : 'Marquer comme fait',
        },
        note.done ? '✓' : '○'
      );
      toggle.addEventListener('click', () => toggleNote(note));

      const edit = h(
        'button',
        {
          type: 'button',
          class: 'icon-btn assistant-edit',
          'aria-label': 'Modifier la note',
          title: 'Modifier',
        },
        '✎'
      );

      const remove = h(
        'button',
        { type: 'button', class: 'icon-btn assistant-remove', 'aria-label': 'Supprimer la note', title: 'Supprimer' },
        '×'
      );
      remove.addEventListener('click', () => deleteNote(note));

      const item = h(
        'li',
        { class: `assistant-item kind-${note.kind}${note.done ? ' is-done' : ''}` },
        toggle,
        h(
          'div',
          { class: 'assistant-item-body' },
          h(
            'div',
            { class: 'assistant-item-head' },
            h('span', { class: 'assistant-kind-pill' }, labels[note.kind] || note.kind),
            h('span', { class: 'assistant-item-date' }, assistantDate(note))
          ),
          h('p', { class: 'assistant-item-text' }, note.text),
          note.context
            ? h('p', { class: 'assistant-item-context' }, `Contexte : ${note.context}`)
            : null
        ),
        h('div', { class: 'assistant-item-tools' }, edit, remove)
      );
      edit.addEventListener('click', () => renderNoteEditor(item, note));
      els.assistantList.append(item);
    }
  }

  /** Édition en place d'une note : texte + type, sans la supprimer. */
  function renderNoteEditor(item, note) {
    clear(item);
    const labels = { amelioration: 'Amélioration', bug: 'Bug', note: 'Note', idee: 'Idée' };
    const kind = h('select', { class: 'assistant-kind', 'aria-label': 'Type de note' });
    for (const [value, label] of Object.entries(labels)) {
      kind.append(h('option', { value }, label));
    }
    kind.value = note.kind;

    const text = h('textarea', {
      class: 'assistant-text',
      rows: '4',
      maxlength: '4000',
      'aria-label': 'Texte de la note',
    });
    text.value = note.text;

    const save = h('button', { type: 'submit', class: 'btn btn-primary btn-small' }, 'Enregistrer');
    const cancel = h('button', { type: 'button', class: 'btn btn-ghost btn-small' }, 'Annuler');
    cancel.addEventListener('click', () => renderAssistant());

    const form = h(
      'form',
      { class: 'assistant-edit-form' },
      kind,
      text,
      h('div', { class: 'assistant-edit-actions' }, save, cancel)
    );
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const value = text.value.trim();
      if (!value) {
        toast('La note ne peut pas être vide.', 'error');
        return;
      }
      save.disabled = true;
      try {
        await apiJson(`/api/notes/${encodeURIComponent(note.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'X-App-Request': '1' },
          body: JSON.stringify({ text: value, kind: kind.value }),
        });
        toast('Note modifiée.', 'ok');
        await loadAssistantNotes();
      } catch (error) {
        if (error.code === 'SESSION_REQUIRED') return;
        toast(error.message || 'Impossible de modifier la note.', 'error');
        save.disabled = false;
      }
    });

    item.append(form);
    text.focus();
  }

  async function loadAssistantNotes() {
    try {
      const result = await apiJson('/api/notes');
      state.assistant.notes = Array.isArray(result.notes) ? result.notes : [];
      state.assistant.stats = result.stats || { pending: 0, total: 0 };
      renderAssistant();
    } catch (error) {
      if (error.code === 'SESSION_REQUIRED') return;
      /* le carnet reste vide si le serveur ne répond pas */
    }
  }

  function setAssistantOpen(open) {
    state.assistant.open = open;
    els.assistantPanel.hidden = !open;
    els.assistantFab.setAttribute('aria-expanded', String(open));
    if (open) {
      renderAssistant();
      els.assistantText.focus();
    }
  }

  async function addAssistantNote(event) {
    event.preventDefault();
    const text = els.assistantText.value.trim();
    if (!text) return;
    const submit = els.assistantForm.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      await apiJson('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-App-Request': '1' },
        body: JSON.stringify({
          text,
          kind: els.assistantKind.value,
          page: 'triage',
          context: state.selectedDate ? `jour ${state.selectedDate}` : null,
        }),
      });
      els.assistantText.value = '';
      await loadAssistantNotes();
      toast('Note ajoutée. Elle sera relue à la prochaine demande OpenCode.', 'ok');
    } catch (error) {
      if (error.code === 'SESSION_REQUIRED') return;
      toast(error.message || 'Impossible d’ajouter la note.', 'error');
    } finally {
      submit.disabled = false;
    }
  }

  async function toggleNote(note) {
    try {
      await apiJson(`/api/notes/${encodeURIComponent(note.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-App-Request': '1' },
        body: JSON.stringify({ done: !note.done }),
      });
      await loadAssistantNotes();
    } catch (error) {
      if (error.code === 'SESSION_REQUIRED') return;
      toast(error.message || 'Impossible de modifier la note.', 'error');
    }
  }

  async function deleteNote(note) {
    try {
      await apiJson(`/api/notes/${encodeURIComponent(note.id)}`, {
        method: 'DELETE',
        headers: { 'X-App-Request': '1' },
      });
      await loadAssistantNotes();
    } catch (error) {
      if (error.code === 'SESSION_REQUIRED') return;
      toast(error.message || 'Impossible de supprimer la note.', 'error');
    }
  }

  async function clearDoneNotes() {
    try {
      const result = await apiJson('/api/notes/clear-done', {
        method: 'POST',
        headers: { 'X-App-Request': '1' },
      });
      await loadAssistantNotes();
      toast(
        result.removed > 0 ? `${result.removed} note(s) faite(s) supprimée(s).` : 'Aucune note faite à vider.',
        'ok'
      );
    } catch (error) {
      if (error.code === 'SESSION_REQUIRED') return;
      toast(error.message || 'Impossible de vider les notes faites.', 'error');
    }
  }

  function buildOpencodePrompt() {
    const labels = { amelioration: 'Amélioration', bug: 'Bug', note: 'Note', idee: 'Idée' };
    const pending = (state.assistant.notes || []).filter((note) => !note.done);
    if (pending.length === 0) return null;
    const lines = [
      'Voici mes demandes en attente pour le projet opencode (Triage Todoist) :',
      'Implémente-les toutes, puis liste précisément ce qui a été fait pour que je vérifie.',
      '',
    ];
    for (const note of pending) {
      lines.push(
        `- [${labels[note.kind] || note.kind}] ${note.text}${
          note.context ? ` (${note.context})` : ''
        }`
      );
    }
    return lines.join('\n');
  }

  async function copyForOpencode() {
    const prompt = buildOpencodePrompt();
    if (!prompt) {
      toast('Aucune note en attente à copier.', 'ok');
      return;
    }
    try {
      await navigator.clipboard.writeText(prompt);
      toast('Notes copiées : colle-les dans ta prochaine demande OpenCode.', 'ok');
      return;
    } catch {
      /* clipboard indisponible : on propose le fichier Markdown */
    }
    try {
      const response = await fetch('/api/notes/export');
      if (!response.ok) throw new Error('Export impossible.');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'notes-opencode.md';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      toast('Copie impossible : notes téléchargées en Markdown.', 'ok');
    } catch (error) {
      toast(error.message || 'Impossible de copier les notes.', 'error');
    }
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  async function exportJson() {
    if (!state.data) return;
    const original = els.exportBtn.innerHTML;
    els.exportBtn.disabled = true;
    els.exportBtn.textContent = 'Préparation…';
    try {
      const response = await fetch('/api/export', {
        headers: { Accept: 'application/json' },
      });
      if (response.status === 401) {
        window.location.replace('/login');
        return;
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error?.message || `Erreur ${response.status}.`);
      }
      const blob = await response.blob();
      const disposition = response.headers.get('content-disposition') || '';
      const match = /filename="([^"]+)"/.exec(disposition);
      const fallback = `todoist-export-${state.data.meta.today}.json`;
      const filename = match?.[1] || fallback;

      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      toast('Export préparé. Sur iPhone, il arrive dans Fichiers → Téléchargements.', 'ok');
    } catch (error) {
      toast(error.message || 'Export impossible.', 'error');
    } finally {
      els.exportBtn.disabled = false;
      els.exportBtn.innerHTML = original;
    }
  }

  async function logout() {
    try {
      await apiJson('/api/logout', {
        method: 'POST',
        headers: { 'X-App-Request': '1' },
      });
    } catch (error) {
      if (error.code === 'SESSION_REQUIRED') return;
    }
    window.location.replace('/login');
  }

  function toast(message, tone = 'ok') {
    clearTimeout(state.toastTimer);
    els.toast.textContent = message;
    els.toast.className = `toast toast-${tone}`;
    els.toast.hidden = false;
    state.toastTimer = setTimeout(() => {
      els.toast.hidden = true;
    }, 4500);
  }

  // ---------------------------------------------------------------------------
  // Événements
  // ---------------------------------------------------------------------------

  let searchTimer = null;
  els.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = els.search.value;
      renderProjects();
    }, 120);
  });

  els.refreshBtn.addEventListener('click', () => load({ force: true }));
  els.retryBtn.addEventListener('click', () => load({ force: true }));
  els.exportBtn.addEventListener('click', exportJson);
  els.logoutBtn.addEventListener('click', logout);
  els.dayOrderBtn.addEventListener('click', loadDayOrder);

  // Assistant « Notes & idées ».
  els.assistantFab.addEventListener('click', () => setAssistantOpen(!state.assistant.open));
  els.assistantClose.addEventListener('click', () => setAssistantOpen(false));
  els.assistantForm.addEventListener('submit', addAssistantNote);
  els.assistantCopy.addEventListener('click', copyForOpencode);
  els.assistantClearDone.addEventListener('click', clearDoneNotes);

  // Nettoyage approfondi.
  els.cleanupScanBtn.addEventListener('click', scanCleanup);

  // Fenêtre de préparation et détail de tâche.
  for (const el of document.querySelectorAll('[data-close="prepare"]')) {
    el.addEventListener('click', closePrepare);
  }
  for (const el of document.querySelectorAll('[data-close="task-detail"]')) {
    el.addEventListener('click', closeTaskDetail);
  }
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (state.taskDetail.open) closeTaskDetail();
    else if (state.prepare.open) closePrepare();
    if (state.assistant.open) setAssistantOpen(false);
  });

  // Démarrage.
  state.ignored = loadIgnoredProposals();
  state.checkins = loadCheckins();
  state.feedback = loadFeedback();
  state.reminderPlans = loadReminderPlans();
  if ('serviceWorker' in navigator) {
    // `updateViaCache: 'none'` : le navigateur ne réutilise pas un vieux sw.js
    // en cache HTTP, sinon les mises à jour de l'app peuvent rester bloquées.
    navigator.serviceWorker
      .register('/sw.js', { updateViaCache: 'none' })
      .then((registration) => registration.update())
      .catch(() => {});
  }
  (async () => {
    try {
      const session = await apiJson('/api/session');
      state.checkinQuestions = session.checkin?.questions || [];
      state.checkinDefaults = session.checkin?.defaults || {};
      state.ignoreFeedback = session.ignore_feedback || null;
    } catch {
      /* le questionnaire ne s'affichera pas, le reste fonctionne */
    }
    loadAssistantNotes();
    load({ force: false });
  })();
})();
