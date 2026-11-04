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
    kpis: document.getElementById('kpis'),
    widgetSummary: document.getElementById('widget-summary'),
    widgetLists: document.getElementById('widget-lists'),
    proposalsCount: document.getElementById('proposals-count'),
    capacity: document.getElementById('capacity'),
    dayPlan: document.getElementById('day-plan'),
    weekRecap: document.getElementById('week-recap'),
    proposalsNote: document.getElementById('proposals-note'),
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
  };

  function cleanupKindLabel(kind) {
    return (
      { ghost: 'Fantôme', duplicate: 'Doublon', orphan: 'Orpheline' }[kind] || 'À supprimer'
    );
  }
  const IGNORED_KEY = 'todoist-triage:ignored-proposals';

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
      render();
      ensureDefaultDay();
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

  function sortedTodayTasks() {
    return activeTasks()
      .filter((task) => task.is_due_today || task.is_overdue)
      .sort((a, b) => {
        if (a.is_overdue !== b.is_overdue) return a.is_overdue ? -1 : 1;
        return (b.days_overdue || 0) - (a.days_overdue || 0) ||
          a.display_title.localeCompare(b.display_title);
      });
  }

  function renderWidget() {
    const tasks = activeTasks();
    const todayTasks = sortedTodayTasks();
    const titleOnly = tasks
      .filter((task) => task.date_convention.valid && !task.due_date)
      .sort((a, b) => (a.title_due_date || '').localeCompare(b.title_due_date || '') ||
        a.display_title.localeCompare(b.display_title));
    const conflicts = tasks.filter((task) => task.conflict);

    clear(els.widgetSummary);
    clear(els.widgetLists);

    const stats = [
      {
        tone: todayTasks.length > 0 ? 'ok' : 'muted',
        value: todayTasks.length,
        label: 'tâche(s) avec une échéance aujourd’hui ou en retard',
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

    if (todayTasks.length > 0) {
      els.widgetLists.append(
        buildListBlock(
          'Visibles dans le widget',
          `${todayTasks.length} tâche(s)`,
          todayTasks.slice(0, 8).map((task) => taskLine(task)),
          'ok'
        )
      );
    } else {
      els.widgetLists.append(
        buildListBlock(
          'Visibles dans le widget',
          '0 tâche',
          [h('p', { class: 'empty-line' }, 'Aucune échéance aujourd’hui ni en retard.')],
          'ok'
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

  function taskLine(task, meta = null) {
    return h(
      'li',
      { class: 'plain-item' },
      h('span', { class: `prio prio-${task.priority}` }, task.priority_label),
      h(
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
      ),
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

  async function selectDay(date, { force = false } = {}) {
    state.selectedDate = date;
    state.dayLoading = true;
    state.dayError = null;
    renderPlanner();
    await loadDay(date, { force });
  }

  async function loadDay(date, { force = false } = {}) {
    try {
      const plan = await apiJson('/api/day/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-App-Request': '1' },
        body: JSON.stringify({ date, force, checkin: getCheckin(date) }),
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
              h('span', { class: 'plain-item-title' }, task.title)
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
      (p) => !state.ignored.has(p.id) && !state.applied.has(p.id)
    );
    const splits = (plan.splits || []).filter(
      (p) => !state.ignored.has(p.id) && !state.applied.has(p.id)
    );

    if (proposals.length === 0 && splits.length === 0) {
      els.dayPlan.append(
        h(
          'p',
          { class: 'empty-line' },
          plan.ai === false
            ? 'L’IA n’est pas activée : impossible de proposer des tâches.'
            : 'Rien à proposer pour cette journée (place pleine ou aucune tâche adaptée).'
        )
      );
    } else {
      const list = h('div', { class: 'proposals' });
      for (const proposal of proposals) list.append(proposalCard(proposal));
      for (const proposal of splits) list.append(proposalCard(proposal));
      els.dayPlan.append(list);
    }

    const reviews = h('div', { class: 'day-actions' });
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
          onclick: () => selectDay(date, { force: true }),
        },
        'Nouvelles propositions pour ce jour'
      )
    );
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
      h('h3', { class: 'week-title' }, 'Récap de la semaine'),
      h(
        'p',
        { class: 'week-line' },
        `${week.length} journée(s) · ${totalPlanned} tâche(s) planifiée(s) · ${freeDays} jour(s) libre(s) · ${fullDays} jour(s) complet(s).`
      ),
      biggest.total > 0
        ? h('p', { class: 'week-line' }, `Le jour le plus chargé : ${formatDate(biggest.date)} (${biggest.total} tâche(s)).`)
        : null,
      biggest.total > 0 && biggest.full
        ? h('p', { class: 'week-note' }, 'La semaine est dense : pense au check-in ou au report des journées pleines.')
        : null
    );
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
    const selects = {};

    for (const question of state.checkinQuestions) {
      const select = h('select', { class: 'checkin-select', 'aria-label': question.label });
      for (const option of question.options) {
        select.append(h('option', { value: option.value }, option.label));
      }
      select.value = answers[question.key] || (state.checkinDefaults[question.key] ?? '');
      selects[question.key] = select;
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
        next[question.key] = selects[question.key].value;
      }
      setCheckin(date, next);
      selectDay(date, { force: true });
    });

    details.append(form);
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

    if (Array.isArray(proposal.subtasks) && proposal.subtasks.length > 0) {
      const list = h('ul', { class: 'proposal-subtasks' });
      for (const subtask of proposal.subtasks) list.append(h('li', {}, subtask));
      card.append(list);
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

    const validateBtn = h('button', { class: 'btn btn-primary', type: 'button' }, isDelete ? 'Supprimer' : 'Valider');
    const ignoreBtn = h('button', { class: 'btn btn-ghost', type: 'button' }, 'Ignorer');

    validateBtn.addEventListener('click', () =>
      validateProposal(proposal, dateInput, validateBtn, ignoreBtn)
    );
    ignoreBtn.addEventListener('click', () => {
      state.ignored.add(proposal.id);
      saveIgnoredProposals();
      renderPlanner();
      renderProposals();
    });

    card.append(h('div', { class: 'proposal-actions' }, validateBtn, ignoreBtn));
    return card;
  }

  /** Applique une proposition (réutilisé par la carte et « Tout valider »). */
  async function sendApply(proposal, dueDateValue) {
    const body = {};
    if (dueDateValue) body.due_date = dueDateValue;
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
    const items = [...(plan?.proposals || []), ...(plan?.splits || [])];
    return items.filter((p) => !state.ignored.has(p.id) && !state.applied.has(p.id));
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

  async function validateProposal(proposal, dateInput, validateBtn, ignoreBtn) {
    validateBtn.disabled = true;
    ignoreBtn.disabled = true;
    const original = validateBtn.textContent;
    validateBtn.textContent = 'Application…';

    try {
      const result = await sendApply(proposal, dateInput ? dateInput.value : undefined);
      consumeApplied(proposal, result);
      toast(result.message || 'Proposition appliquée.', result.verified === false ? 'error' : 'ok');
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

  function renderProposals() {
    const all = Array.isArray(state.data.proposals) ? state.data.proposals : [];
    const summary = state.data.summary.proposals || { total: all.length, truncated: {} };
    const visible = all.filter(
      (proposal) => !state.ignored.has(proposal.id) && !state.applied.has(proposal.id)
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

    const renderTask = (task, depth) => {
      const listItem = h('li', { class: 'task' });
      const row = h('div', { class: `task-row${depth > 0 ? ' is-subtask' : ''}` });

      row.append(h('span', { class: `prio prio-${task.priority}` }, task.priority_label));

      const content = h('div', { class: 'task-content' });
      content.append(
        h('div', { class: 'task-head' }, h('span', { class: 'task-title' }, task.display_title || task.content))
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
      if (badges.childElementCount > 0) content.append(badges);

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
        for (const child of childTasks) childList.append(renderTask(child, depth + 1));
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

  // Démarrage.
  state.ignored = loadIgnoredProposals();
  state.checkins = loadCheckins();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  (async () => {
    try {
      const session = await apiJson('/api/session');
      state.checkinQuestions = session.checkin?.questions || [];
      state.checkinDefaults = session.checkin?.defaults || {};
    } catch {
      /* le questionnaire ne s'affichera pas, le reste fonctionne */
    }
    load({ force: false });
  })();
})();
