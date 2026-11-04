'use strict';

/**
 * Corbeille (itération 8).
 *
 * Toute suppression passe par ici : on garde une copie de la tâche pour pouvoir
 * la recréer à l'identique si l'utilisateur clique « Annuler ». Les entrées
 * expirent au bout de 24 h (mémoire serveur, rien n'est persisté sur disque).
 */

const { createTask } = require('./todoist');

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX = 100;

let entries = new Map(); // id -> { restore, title, project_name, at }

function prune() {
  const now = Date.now();
  for (const [id, entry] of entries) {
    if (now - entry.at > TTL_MS) entries.delete(id);
  }
  if (entries.size > MAX) {
    const oldest = [...entries.entries()].sort((a, b) => a[1].at - b[1].at);
    for (let i = 0; i < oldest.length - MAX; i += 1) entries.delete(oldest[i][0]);
  }
}

function add({ restore, title, project_name }) {
  prune();
  const id = `trash_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  entries.set(id, { restore, title, project_name: project_name || null, at: Date.now() });
  return id;
}

function list() {
  prune();
  return [...entries.entries()]
    .map(([id, entry]) => ({
      id,
      title: entry.title,
      project_name: entry.project_name,
      deleted_at: new Date(entry.at).toISOString(),
    }))
    .sort((a, b) => b.deleted_at.localeCompare(a.deleted_at));
}

async function restore(id) {
  prune();
  const entry = entries.get(id);
  if (!entry) return null;

  const payload = { ...entry.restore };
  // On ne recrée pas les champs vides.
  for (const key of Object.keys(payload)) {
    if (payload[key] === null || payload[key] === undefined || payload[key] === '') delete payload[key];
  }

  let created;
  try {
    created = await createTask(payload);
  } catch (error) {
    // Le parent ou la section peut avoir disparu entre-temps : on réessaie sans.
    if (payload.parent_id || payload.section_id) {
      delete payload.parent_id;
      delete payload.section_id;
      created = await createTask(payload);
    } else {
      throw error;
    }
  }

  entries.delete(id);
  return { restored_id: created?.id || null, title: entry.title };
}

function clearTrash() {
  entries = new Map();
}

module.exports = { add, list, restore, clearTrash };
