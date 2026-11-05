'use strict';

/**
 * Contexte de vie (LIFE_CONTEXT.md) et journal de progression.
 *
 * - `readLifeContext` fournit à l'IA les projets/objectifs/blocages.
 * - `appendLifeProgress` ajoute une ligne dans le fichier quand une nouvelle
 *   tâche issue d'une suggestion est créée. Le fichier reste la source de
 *   vérité réutilisable par l'agent.
 */

const fs = require('node:fs');
const path = require('node:path');

const START = '<!-- TRIAGE_PROGRESS_START -->';
const END = '<!-- TRIAGE_PROGRESS_END -->';
const MAX_PROGRESS_LINES = 200;

function defaultFile() {
  return process.env.LIFE_CONTEXT_FILE
    ? path.resolve(process.env.LIFE_CONTEXT_FILE)
    : path.join(__dirname, '..', 'LIFE_CONTEXT.md');
}

let cache = { file: null, mtimeMs: 0, text: null };

function readLifeContext(file = defaultFile()) {
  try {
    const stat = fs.statSync(file);
    if (cache.file === file && cache.mtimeMs === stat.mtimeMs && cache.text) {
      return cache.text;
    }
    const text = fs.readFileSync(file, 'utf8');
    const trimmed = text.slice(0, 14000);
    cache = { file, mtimeMs: stat.mtimeMs, text: trimmed };
    return trimmed;
  } catch {
    return null;
  }
}

function ensureSection(text) {
  if (text.includes(START) && text.includes(END)) return text;
  return `${text.trimEnd()}\n\n## Journal des tâches créées\n\n${START}\n${END}\n`;
}

/**
 * Ajoute une ligne de progression (idempotente par taskId).
 * @returns {{saved: boolean, file: string, reason?: string}}
 */
function appendLifeProgress(
  { title, projectName, dueDate, taskId, createdAt = new Date() },
  { file = defaultFile() } = {}
) {
  const cleanTitle = String(title || '').trim().slice(0, 200);
  if (!cleanTitle) return { saved: false, file, reason: 'EMPTY_TITLE' };
  const project = String(projectName || 'Projet').trim().slice(0, 120);
  const due = String(dueDate || '').slice(0, 10);
  const when = createdAt.toISOString().slice(0, 10);
  const id = taskId ? String(taskId) : '';
  const line = `- [ ] **${project}** — ${cleanTitle} (échéance ${due || '—'}) · créée ${when}${
    id ? ` · id ${id}` : ''
  }`;

  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { saved: false, file, reason: 'NOT_FOUND' };
  }
  if (id && text.includes(`id ${id}`)) return { saved: false, file, reason: 'ALREADY' };

  let next = ensureSection(text);
  const startIndex = next.indexOf(START);
  const endIndex = next.indexOf(END, startIndex);
  if (startIndex < 0 || endIndex < 0) return { saved: false, file, reason: 'NO_SECTION' };

  const before = next.slice(0, endIndex).trimEnd();
  const after = next.slice(endIndex);
  const existingLines = before.split('\n').filter((l) => l.startsWith('- ['));
  const kept = existingLines.slice(-(MAX_PROGRESS_LINES - 1));
  const sectionLines = [
    START,
    ...kept,
    line,
  ].join('\n');
  next = `${next.slice(0, startIndex)}${sectionLines}\n${END}${next.slice(endIndex + END.length)}`;

  try {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, next, 'utf8');
    fs.renameSync(tmp, file);
    cache = { file: null, mtimeMs: 0, text: null };
    return { saved: true, file };
  } catch (error) {
    return { saved: false, file, reason: error?.code || 'WRITE_FAILED' };
  }
}

module.exports = { readLifeContext, appendLifeProgress, defaultFile, START, END };
