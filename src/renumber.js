'use strict';

/**
 * Renumérotation des sous-tâches (itération 15).
 *
 * Les préparations et les découpages créent des titres « 1. … », « 2. … ».
 * Quand une de ces sous-tâches est supprimée (ou ajoutée), les numéros doivent
 * se recoller à l'ordre réel. On ne touche qu'aux titres qui possèdent déjà un
 * préfixe numérique : une sous-tâche nommée librement reste intacte.
 */

const { updateTask } = require('./todoist');
const { stripOrderPrefix } = require('./prepare');

const ORDER_PREFIX = /^\s*\d+[.)]\s+/;

function titleOf(task) {
  return String(task?.display_title || task?.content || '');
}

function hasOrderPrefix(value) {
  return ORDER_PREFIX.test(String(value || ''));
}

function compareTasks(a, b) {
  return (
    String(a.order_key || '').localeCompare(String(b.order_key || '')) ||
    Number(a.child_order ?? 0) - Number(b.child_order ?? 0) ||
    titleOf(a).localeCompare(titleOf(b), 'fr-FR')
  );
}

/**
 * Calcule les renommages nécessaires pour que les sous-tâches numérotées
 * forment une suite 1, 2, 3… dans l'ordre courant.
 * @returns {{changes: {id:string, from:string, to:string}[], numbered: number}}
 */
function renumberPlan(children) {
  const numbered = (Array.isArray(children) ? children : [])
    .filter((task) => hasOrderPrefix(titleOf(task)))
    .sort(compareTasks);

  const changes = [];
  for (const [index, task] of numbered.entries()) {
    const from = titleOf(task);
    const to = `${index + 1}. ${stripOrderPrefix(from)}`;
    if (from !== to) changes.push({ id: task.id, from, to });
  }
  return { changes, numbered: numbered.length };
}

/** Applique le plan via l'API Todoist. */
async function applyRenumberPlan(plan) {
  for (const change of plan.changes) {
    await updateTask(change.id, { content: change.to });
  }
  return plan.changes.length;
}

/** Renumérote les enfants numérotés d'un parent, à partir d'un instantané. */
async function renumberNumberedChildren(snapshot, parentId) {
  const children = (snapshot.tasks || []).filter(
    (task) => task.parent_id === String(parentId) && !task.project_archived
  );
  const plan = renumberPlan(children);
  const updated = await applyRenumberPlan(plan);
  return { updated, numbered: plan.numbered, changes: plan.changes };
}

/** Prochain numéro pour une nouvelle sous-tâche d'un groupe numéroté. */
function nextNumberedTitle(children, title) {
  const numbered = (Array.isArray(children) ? children : []).filter((task) =>
    hasOrderPrefix(titleOf(task))
  );
  return `${numbered.length + 1}. ${stripOrderPrefix(title)}`;
}

module.exports = {
  ORDER_PREFIX,
  hasOrderPrefix,
  compareTasks,
  renumberPlan,
  renumberNumberedChildren,
  nextNumberedTitle,
  titleOf,
};
