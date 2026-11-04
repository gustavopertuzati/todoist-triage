'use strict';

/**
 * Construit un instantané lisible et complet du compte Todoist.
 *
 * Aucune écriture : ce module ne fait que normaliser les données du full sync.
 * Les champs bruts sont conservés (spread) pour que l'export JSON reste une
 * sauvegarde exploitable, et des champs dérivés sont ajoutés pour l'affichage.
 */

const {
  parseDateConvention,
  daysBetweenIso,
  isValidIsoDate,
} = require('./dates');

const PRIORITY_LABELS = { 4: 'P1', 3: 'P2', 2: 'P3', 1: 'P4' };

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isoDateOnly(value) {
  if (typeof value !== 'string' || value.length < 10) return null;
  const candidate = value.slice(0, 10);
  return isValidIsoDate(candidate) ? candidate : null;
}

function projectIsInbox(project) {
  return (
    project.inbox_project === true ||
    project.is_inbox_project === true ||
    project.name === 'Inbox'
  );
}

function projectSortKey(project) {
  return project.order_key || String(project.child_order ?? 0).padStart(12, '0');
}

function taskSortKey(task) {
  return task.order_key || String(task.child_order ?? 0).padStart(12, '0');
}

function normalizeProject(project) {
  return {
    ...project,
    id: String(project.id),
    name: typeof project.name === 'string' ? project.name : '(sans nom)',
    is_inbox: projectIsInbox(project),
    is_archived: project.is_archived === true,
  };
}

function normalizeSection(section) {
  return {
    ...section,
    id: String(section.id),
    project_id: String(section.project_id),
    name: typeof section.name === 'string' ? section.name : '(sans nom)',
    is_archived: section.is_archived === true,
  };
}

function normalizeLabel(label) {
  return {
    ...label,
    id: String(label.id),
    name: typeof label.name === 'string' ? label.name : '(sans nom)',
  };
}

function normalizeTask(task, today, oldTaskDays, archivedProjectIds = new Set()) {
  const content = typeof task.content === 'string' ? task.content : '';
  const parsed = parseDateConvention(content, today);
  const dueDate = isoDateOnly(task.due?.date);
  const deadlineDate = isoDateOnly(task.deadline?.date);
  const titleDueDate = parsed.valid ? parsed.dueDate : null;
  const priority = Math.min(4, Math.max(1, Number(task.priority) || 1));

  const addedDate = isoDateOnly(task.added_at);
  const ageDays = addedDate ? daysBetweenIso(addedDate, today) : null;

  const conflict = Boolean(parsed.valid && dueDate && parsed.dueDate !== dueDate);
  const needsApply = Boolean(parsed.valid && parsed.dueDate !== dueDate);
  const isOverdue = Boolean(dueDate && dueDate < today);
  const isDueToday = Boolean(dueDate && dueDate === today);

  return {
    ...task,
    id: String(task.id),
    project_id: task.project_id ? String(task.project_id) : null,
    section_id: task.section_id ? String(task.section_id) : null,
    parent_id: task.parent_id ? String(task.parent_id) : null,
    content,
    description: typeof task.description === 'string' ? task.description : '',
    priority,
    priority_label: PRIORITY_LABELS[priority],
    labels: asArray(task.labels).filter((label) => typeof label === 'string'),
    due_date: dueDate,
    deadline_date: deadlineDate,
    due_is_recurring: task.due?.is_recurring === true,
    due_string: task.due?.string || null,

    // Champs dérivés de la convention personnelle.
    display_title: parsed.valid ? parsed.title : content.trim(),
    date_convention: {
      detected: parsed.detected,
      valid: parsed.valid,
      kind: parsed.kind,
      token: parsed.token,
      due_date: parsed.dueDate,
      reason: parsed.reason,
    },
    title_due_date: titleDueDate,
    effective_due_date: dueDate || titleDueDate,
    due_source: dueDate ? 'todoist' : titleDueDate ? 'title' : null,
    needs_apply: needsApply,
    conflict,
    is_overdue: isOverdue,
    is_due_today: isDueToday,
    days_overdue: isOverdue ? daysBetweenIso(dueDate, today) : null,
    title_due_today: Boolean(!dueDate && titleDueDate === today),
    title_due_overdue: Boolean(!dueDate && titleDueDate && titleDueDate < today),
    is_subtask: Boolean(task.parent_id),
    // Les tâches d'un projet archivé restent dans l'export mais sont
    // exclues des compteurs de la page (elles ne sont plus « actives »).
    project_archived: Boolean(task.project_id && archivedProjectIds.has(String(task.project_id))),
    age_days: ageDays,
    is_old: Boolean(ageDays !== null && ageDays >= oldTaskDays),
  };
}

/**
 * @param {object} params
 * @param {object} params.sync Réponse brute du full sync.
 * @param {{items: object[], truncated: boolean}|null} params.completed
 * @param {string} params.today Date ISO du jour.
 * @param {string} params.timezone Fuseau utilisé.
 * @param {string[]} [params.warnings]
 * @param {number} params.completedLookbackDays
 * @param {number} params.oldTaskDays
 * @param {number} params.noProgressMinAgeDays
 * @param {string} [params.generatedAt]
 * @param {string} [params.appVersion]
 */
function buildSnapshot({
  sync,
  completed,
  today,
  timezone,
  warnings = [],
  completedLookbackDays,
  oldTaskDays,
  noProgressMinAgeDays,
  generatedAt = new Date().toISOString(),
  appVersion = null,
}) {
  const allProjects = asArray(sync.projects)
    .filter((project) => project && project.is_deleted !== true)
    .map(normalizeProject);

  const allSections = asArray(sync.sections)
    .filter((section) => section && section.is_deleted !== true)
    .map(normalizeSection);

  const archivedProjectIds = new Set(
    allProjects.filter((project) => project.is_archived).map((project) => project.id)
  );

  const allTasks = asArray(sync.items)
    .filter((task) => task && task.is_deleted !== true && task.checked !== true)
    .map((task) => normalizeTask(task, today, oldTaskDays, archivedProjectIds));

  const labels = asArray(sync.labels)
    .filter((label) => label && label.is_deleted !== true)
    .map(normalizeLabel)
    .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0) || a.name.localeCompare(b.name));

  // Regroupements par projet pour calculer les statistiques en une passe.
  const tasksByProject = new Map();
  for (const task of allTasks) {
    const key = task.project_id || '__orphan__';
    if (!tasksByProject.has(key)) tasksByProject.set(key, []);
    tasksByProject.get(key).push(task);
  }

  const sectionsByProject = new Map();
  for (const section of allSections) {
    if (!sectionsByProject.has(section.project_id)) sectionsByProject.set(section.project_id, []);
    sectionsByProject.get(section.project_id).push(section);
  }

  const completedAvailable = completed !== null && completed !== undefined;
  const completedByProject = new Map();
  for (const item of completedAvailable ? asArray(completed.items) : []) {
    const projectId = item.project_id ? String(item.project_id) : null;
    if (!projectId) continue;
    const entry = completedByProject.get(projectId) || { count: 0, last_at: null };
    entry.count += 1;
    if (item.completed_at && (!entry.last_at || item.completed_at > entry.last_at)) {
      entry.last_at = item.completed_at;
    }
    completedByProject.set(projectId, entry);
  }

  if (!completedAvailable) {
    warnings.push(
      'L’historique des tâches terminées n’a pas pu être lu : l’activité des projets n’est pas mesurée.'
    );
  } else if (completed.truncated) {
    warnings.push(
      `Historique des tâches terminées tronqué (limite ${completed.items.length} éléments) : les compteurs d’activité sont partiels.`
    );
  }

  let projectsArchived = 0;
  let projectsEmpty = 0;
  let projectsNoProgress = 0;
  let sectionsTotal = 0;
  let tasksTotal = 0;
  let subtasksTotal = 0;
  let overdueTotal = 0;
  let dueTodayTotal = 0;
  let noDueTotal = 0;
  let titleDatesTotal = 0;
  let titleDatesToday = 0;
  let titleDatesOverdue = 0;
  let conflictsTotal = 0;
  let oldUndatedTotal = 0;
  const priorityCounts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const labelUsage = new Map();

  const projectIds = new Set(allProjects.map((project) => project.id));
  const orphanTasks = allTasks.filter((task) => !task.project_id || !projectIds.has(task.project_id));
  if (orphanTasks.length > 0) {
    warnings.push(
      `${orphanTasks.length} tâche(s) référencent un projet absent du compte (probablement un projet partagé ou supprimé).`
    );
  }

  const projects = allProjects
    .map((project) => {
      const projectTasks = tasksByProject.get(project.id) || [];
      const projectSections = sectionsByProject.get(project.id) || [];
      const completion = completedByProject.get(project.id) || { count: 0, last_at: null };

      const stats = {
        tasks: projectTasks.length,
        top_level_tasks: projectTasks.filter((task) => !task.parent_id).length,
        subtasks: projectTasks.filter((task) => task.parent_id).length,
        overdue: projectTasks.filter((task) => task.is_overdue).length,
        due_today: projectTasks.filter((task) => task.is_due_today).length,
        no_due: projectTasks.filter((task) => !task.due_date).length,
        title_dates: projectTasks.filter((task) => task.date_convention.valid).length,
        conflicts: projectTasks.filter((task) => task.conflict).length,
        completed_lookback: completion.count,
        last_completed_at: completion.last_at,
        sections: projectSections.filter((section) => !section.is_archived).length,
      };

      const createdDate = isoDateOnly(project.created_at);
      const ageDays = createdDate ? daysBetweenIso(createdDate, today) : null;
      const noProgress = Boolean(
        completedAvailable &&
          stats.tasks > 0 &&
          completion.count === 0 &&
          ageDays !== null &&
          ageDays >= noProgressMinAgeDays
      );
      const empty = stats.tasks === 0;

      stats.project_age_days = ageDays;
      stats.empty = empty;
      stats.no_progress = noProgress;

      const updateDates = projectTasks
        .map((task) => task.updated_at)
        .filter((value) => typeof value === 'string')
        .sort();
      stats.last_task_update_at = updateDates.length ? updateDates[updateDates.length - 1] : null;
      stats.last_activity_at =
        [stats.last_task_update_at, stats.last_completed_at]
          .filter(Boolean)
          .sort()
          .pop() || null;

      if (project.is_archived) projectsArchived += 1;
      if (!project.is_archived) {
        sectionsTotal += stats.sections;
        if (empty) projectsEmpty += 1;
        if (noProgress) projectsNoProgress += 1;
      }

      return { ...project, stats };
    })
    .sort((a, b) => {
      if (a.is_archived !== b.is_archived) return a.is_archived ? 1 : -1;
      if (a.is_inbox !== b.is_inbox) return a.is_inbox ? -1 : 1;
      if (a.is_favorite !== b.is_favorite) return a.is_favorite ? -1 : 1;
      return projectSortKey(a).localeCompare(projectSortKey(b)) || a.name.localeCompare(b.name);
    });

  for (const task of allTasks) {
    if (task.project_archived) continue;
    tasksTotal += 1;
    if (task.parent_id) subtasksTotal += 1;
    if (task.is_overdue) overdueTotal += 1;
    if (task.is_due_today) dueTodayTotal += 1;
    if (!task.due_date) noDueTotal += 1;
    if (task.date_convention.valid) titleDatesTotal += 1;
    if (task.title_due_today) titleDatesToday += 1;
    if (task.title_due_overdue) titleDatesOverdue += 1;
    if (task.conflict) conflictsTotal += 1;
    if (task.is_old && !task.due_date) oldUndatedTotal += 1;
    priorityCounts[task.priority] += 1;
    for (const label of task.labels) {
      labelUsage.set(label, (labelUsage.get(label) || 0) + 1);
    }
  }

  const labelsTop = [...labelUsage.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 12);

  const summary = {
    projects_total: projects.filter((project) => !project.is_archived).length,
    projects_archived: projectsArchived,
    projects_empty: projectsEmpty,
    projects_no_progress: projectsNoProgress,
    sections_total: sectionsTotal,
    tasks_total: tasksTotal,
    subtasks_total: subtasksTotal,
    overdue_total: overdueTotal,
    due_today_total: dueTodayTotal,
    no_due_total: noDueTotal,
    title_dates_total: titleDatesTotal,
    title_dates_today: titleDatesToday,
    title_dates_overdue: titleDatesOverdue,
    conflicts_total: conflictsTotal,
    old_undated_total: oldUndatedTotal,
    completed_lookback_total: completedAvailable
      ? asArray(completed.items).length
      : null,
    priority: {
      p1: priorityCounts[4],
      p2: priorityCounts[3],
      p3: priorityCounts[2],
      p4: priorityCounts[1],
    },
    labels_top: labelsTop,
  };

  const user = sync.user
    ? {
        id: sync.user.id ?? null,
        full_name: sync.user.full_name ?? null,
        email: sync.user.email ?? null,
        tz_info: sync.user.tz_info ?? null,
      }
    : null;

  return {
    meta: {
      format: 'todoist-triage-export',
      format_version: 1,
      app_version: appVersion,
      generated_at: generatedAt,
      today,
      timezone,
      old_task_days: oldTaskDays,
      no_progress_min_age_days: noProgressMinAgeDays,
      source: 'Todoist API v1 (full sync + tâches terminées)',
      completed_lookback_days: completedLookbackDays,
      completed_available: completedAvailable,
      warnings,
    },
    user,
    summary,
    projects,
    sections: allSections,
    tasks: allTasks,
    labels,
    completed: {
      available: completedAvailable,
      lookback_days: completedLookbackDays,
      total: completedAvailable ? asArray(completed.items).length : null,
      truncated: Boolean(completedAvailable && completed.truncated),
      by_project: Object.fromEntries(completedByProject),
    },
    orphan_tasks: orphanTasks.map((task) => task.id),
  };
}

module.exports = {
  buildSnapshot,
  PRIORITY_LABELS,
  normalizeTask,
  taskSortKey,
};
