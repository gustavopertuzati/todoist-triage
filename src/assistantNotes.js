'use strict';

/**
 * Carnet de notes / améliorations (itération 12, « assistant »).
 *
 * Petite zone en bas à droite de l'app où l'on note une idée, un bug, une
 * amélioration en une phrase. Les notes sont **persistées côté serveur** dans
 * un fichier JSON (par défaut `data/assistant-notes.json`) : elles survivent
 * aux rechargements et restent lisibles par l'agent qui travaille sur le
 * projet (OpenCode) à la prochaine demande.
 *
 * Aucune écriture Todoist ici : c'est un carnet, pas une action.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const KINDS = ['amelioration', 'bug', 'note', 'idee'];
const KIND_LABELS = {
  amelioration: 'Amélioration',
  bug: 'Bug',
  note: 'Note',
  idee: 'Idée',
};

const MAX_TEXT = 4000;
const MAX_PAGE = 200;
const MAX_CONTEXT = 500;
const MAX_NOTES = 500;

function defaultFile() {
  return process.env.ASSISTANT_NOTES_FILE
    ? path.resolve(process.env.ASSISTANT_NOTES_FILE)
    : path.join(__dirname, '..', 'data', 'assistant-notes.json');
}

function normalizeKind(value) {
  return KINDS.includes(value) ? value : 'note';
}

function clean(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/**
 * Fabrique un carnet sur un fichier donné (injectable pour les tests).
 */
function createStore({ file = defaultFile() } = {}) {
  let notes = null;

  function load() {
    if (notes) return notes;
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      notes = Array.isArray(parsed?.notes) ? parsed.notes.filter(Boolean) : [];
    } catch {
      notes = [];
    }
    return notes;
  }

  /** Écriture atomique : fichier temporaire puis renommage. */
  function persist() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    const payload = { updated_at: new Date().toISOString(), notes: load() };
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  }

  /** Les notes en attente d'abord, puis les plus récentes. */
  function list() {
    return [...load()].sort((a, b) => {
      if (Boolean(a.done) !== Boolean(b.done)) return a.done ? 1 : -1;
      return String(b.created_at || '').localeCompare(String(a.created_at || ''));
    });
  }

  function add(input) {
    const text = clean(input?.text, MAX_TEXT);
    if (!text) {
      const error = new Error('Note vide.');
      error.code = 'NOTE_EMPTY';
      throw error;
    }

    const note = {
      id: `note_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`,
      text,
      kind: normalizeKind(input?.kind),
      page: clean(input?.page, MAX_PAGE) || 'triage',
      context: clean(input?.context, MAX_CONTEXT) || null,
      done: Boolean(input?.done),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    load().push(note);
    // Plafond : on retire les plus anciennes notes déjà faites.
    const items = load();
    if (items.length > MAX_NOTES) {
      const removable = items
        .filter((item) => item.done)
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      while (items.length > MAX_NOTES && removable.length > 0) {
        const oldest = removable.shift();
        const index = items.indexOf(oldest);
        if (index >= 0) items.splice(index, 1);
      }
    }

    persist();
    return note;
  }

  function update(id, patch) {
    const note = load().find((item) => item.id === String(id));
    if (!note) return null;
    if (typeof patch?.done === 'boolean') note.done = patch.done;
    if (typeof patch?.text === 'string') {
      const text = clean(patch.text, MAX_TEXT);
      if (text) note.text = text;
    }
    if (typeof patch?.kind === 'string') note.kind = normalizeKind(patch.kind);
    note.updated_at = new Date().toISOString();
    persist();
    return note;
  }

  function remove(id) {
    const items = load();
    const index = items.findIndex((item) => item.id === String(id));
    if (index < 0) return false;
    items.splice(index, 1);
    persist();
    return true;
  }

  function clearDone() {
    const items = load();
    const kept = items.filter((item) => !item.done);
    const removed = items.length - kept.length;
    if (removed > 0) {
      notes = kept;
      persist();
    }
    return removed;
  }

  function stats() {
    const items = load();
    const pending = items.filter((item) => !item.done).length;
    return { total: items.length, pending, done: items.length - pending };
  }

  /** Version Markdown : lisible et copiable vers la conversation OpenCode. */
  function toMarkdown() {
    const items = list();
    const pending = items.filter((item) => !item.done);
    const done = items.filter((item) => item.done);
    const lines = [
      '# Notes & améliorations — Triage Todoist',
      '',
      `Mis à jour : ${new Date().toISOString()}`,
      '',
      `## À faire (${pending.length})`,
      '',
    ];

    if (pending.length === 0) lines.push('_Rien en attente._', '');
    for (const note of pending) {
      lines.push(
        `- [ ] **${KIND_LABELS[note.kind] || note.kind}** · ${note.created_at}`,
        `  ${note.text.replace(/\n/g, '\n  ')}`,
        note.context ? `  _Contexte : ${note.context}_` : '',
        ''
      );
    }

    lines.push(`## Fait (${done.length})`, '');
    if (done.length === 0) lines.push('_Rien encore._', '');
    for (const note of done) {
      lines.push(
        `- [x] **${KIND_LABELS[note.kind] || note.kind}** · ${note.created_at}`,
        `  ${note.text.replace(/\n/g, '\n  ')}`,
        ''
      );
    }

    return lines.filter((line) => line !== '').join('\n') + '\n';
  }

  return { file, list, add, update, remove, clearDone, stats, toMarkdown };
}

const store = createStore();

module.exports = {
  KINDS,
  KIND_LABELS,
  MAX_TEXT,
  createStore,
  store,
  defaultFile,
};
