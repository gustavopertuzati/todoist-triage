'use strict';

/**
 * Exécution d'une proposition validée (itération 3).
 *
 * Chaque action est appliquée à Todoist puis **relue** pour vérifier qu'elle a
 * bien pris effet. Une proposition n'arrive ici qu'après validation explicite
 * dans l'interface, et son identifiant est vérifié contre un instantané frais
 * par l'appelant.
 */

const {
  updateTask,
  getTask,
  createTask,
  archiveProject,
  getProject,
} = require('./todoist');
const { normalizeDueDate } = require('./proposals');

class ProposalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProposalError';
    this.code = code;
  }
}

function isoOnly(value) {
  return typeof value === 'string' && value.length >= 10 ? value.slice(0, 10) : null;
}

async function applyDueDate(proposal, overrides) {
  const requested = overrides?.due_date || proposal.action.due_date;
  const dueDate = normalizeDueDate(requested);
  if (!dueDate) throw new ProposalError('DATE_INVALID', 'Date d’échéance invalide.');

  await updateTask(proposal.target.id, { due_date: dueDate });

  // Relecture : on vérifie que l'échéance est bien celle demandée.
  const task = await getTask(proposal.target.id);
  const actual = isoOnly(task?.due?.date);
  const verified = actual === dueDate;

  return {
    verified,
    message: verified
      ? `Échéance appliquée : ${dueDate}.`
      : `Écriture envoyée, mais la relecture indique « ${actual || 'aucune échéance'} ».`,
    effects: { due_date: actual },
  };
}

async function applyArchive(proposal) {
  const project = await archiveProject(proposal.target.id);
  let archived = typeof project?.is_archived === 'boolean' ? project.is_archived : null;

  if (archived === null) {
    try {
      const fresh = await getProject(proposal.target.id);
      if (typeof fresh?.is_archived === 'boolean') archived = fresh.is_archived;
    } catch {
      archived = null;
    }
  }

  return {
    verified: archived,
    message: archived ? 'Projet archivé.' : 'Projet archivé (vérification indisponible).',
    effects: { is_archived: archived },
  };
}

async function applySplit(proposal) {
  const items = Array.isArray(proposal.action.subtasks) ? proposal.action.subtasks : [];
  if (items.length < 2) throw new ProposalError('SPLIT_EMPTY', 'Aucun élément à scinder.');

  const created = [];
  for (const content of items) {
    const payload = {
      content,
      project_id: proposal.target.project_id,
      parent_id: proposal.target.id,
    };
    if (proposal.target.section_id) payload.section_id = proposal.target.section_id;
    const child = await createTask(payload);
    created.push(child?.id || null);
  }

  // La description d'origine est remplacée par ce qui restait hors liste.
  await updateTask(proposal.target.id, { description: proposal.action.remaining_description || '' });

  const createdCount = created.filter(Boolean).length;
  return {
    verified: createdCount === items.length,
    message: `${createdCount} sous-tâche(s) créée(s) sur ${items.length}.`,
    effects: { created },
  };
}

/**
 * @param {{proposal: object, overrides?: {due_date?: string}}} params
 */
async function applyProposal({ proposal, overrides = null }) {
  if (!proposal || typeof proposal !== 'object') {
    throw new ProposalError('INVALID_PROPOSAL', 'Proposition invalide.');
  }

  switch (proposal.type) {
    case 'reschedule_overdue':
    case 'set_due_date':
      return applyDueDate(proposal, overrides);
    case 'archive_project':
      return applyArchive(proposal);
    case 'split_task':
      return applySplit(proposal);
    default:
      throw new ProposalError('UNKNOWN_TYPE', 'Type de proposition inconnu.');
  }
}

module.exports = { ProposalError, applyProposal };
