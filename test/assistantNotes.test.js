'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createStore, KINDS } = require('../src/assistantNotes');

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-test-'));
  return { store: createStore({ file: path.join(dir, 'notes.json') }), dir };
}

test('les types de notes sont stables', () => {
  assert.deepEqual(KINDS, ['amelioration', 'bug', 'note', 'idee']);
});

test('ajout, lecture et persistance sur disque', () => {
  const { store } = tempStore();
  const note = store.add({ text: '  Ajouter un bouton Préparer  ', kind: 'amelioration' });

  assert.equal(note.text, 'Ajouter un bouton Préparer');
  assert.equal(note.kind, 'amelioration');
  assert.equal(note.done, false);
  assert.equal(note.page, 'triage');

  const reloaded = createStore({ file: store.file });
  assert.equal(reloaded.list().length, 1);
  assert.equal(reloaded.list()[0].text, 'Ajouter un bouton Préparer');
});

test('une note vide est refusée', () => {
  const { store } = tempStore();
  assert.throws(() => store.add({ text: '   ' }), (error) => error.code === 'NOTE_EMPTY');
});

test('un type inconnu retombe sur « note »', () => {
  const { store } = tempStore();
  const note = store.add({ text: 'Idée libre', kind: 'inconnu' });
  assert.equal(note.kind, 'note');
});

test('les notes en attente passent avant les notes faites', () => {
  const { store } = tempStore();
  const first = store.add({ text: 'Première', kind: 'note' });
  const second = store.add({ text: 'Deuxième', kind: 'bug' });
  store.update(first.id, { done: true });

  const list = store.list();
  assert.equal(list[0].id, second.id);
  assert.equal(list[1].id, first.id);
  assert.deepEqual(store.stats(), { total: 2, pending: 1, done: 1 });
});

test('marquer fait / remettre à faire', () => {
  const { store } = tempStore();
  const note = store.add({ text: 'À faire', kind: 'idee' });
  assert.equal(store.update(note.id, { done: true }).done, true);
  assert.equal(store.update(note.id, { done: false }).done, false);
  assert.equal(store.update('absent', { done: true }), null);
});

test('suppression et vidage des notes faites', () => {
  const { store } = tempStore();
  const a = store.add({ text: 'A' });
  const b = store.add({ text: 'B' });
  store.update(a.id, { done: true });

  assert.equal(store.clearDone(), 1);
  assert.deepEqual(store.list().map((n) => n.id), [b.id]);
  assert.equal(store.remove(b.id), true);
  assert.equal(store.remove(b.id), false);
  assert.equal(store.list().length, 0);
});

test('export Markdown sépare à faire et fait', () => {
  const { store } = tempStore();
  const a = store.add({ text: 'Ajouter un thème sombre', kind: 'amelioration' });
  store.add({ text: 'Le bouton plante', kind: 'bug' });
  store.update(a.id, { done: true });

  const markdown = store.toMarkdown();
  assert.match(markdown, /# Notes & améliorations/);
  assert.match(markdown, /## À faire \(1\)/);
  assert.match(markdown, /## Fait \(1\)/);
  assert.match(markdown, /- \[ \] \*\*Bug\*\*/);
  assert.match(markdown, /- \[x\] \*\*Amélioration\*\*/);
  assert.match(markdown, /Le bouton plante/);
});
