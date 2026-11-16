'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createStore, sanitizeState, emptyState } = require('../src/adaptiveState');

test('emptyState contient les quatre registres attendus', () => {
  const state = emptyState();
  assert.deepEqual(Object.keys(state).sort(), ['days', 'goals', 'reviews', 'tasks', 'updated_at', 'version'].sort());
});

test('sanitizeState ignore les entrées invalides et borne l’historique', () => {
  const state = sanitizeState({
    tasks: {
      lire: {
        task_key: 'lire',
        title: 'Lire 40 pages',
        history: Array.from({ length: 80 }, (_, index) => ({ date: `2026-01-${index + 1}` })),
      },
      vide: null,
    },
    goals: { reading: { id: 'reading', title: 'Lire', current: 20, base: 40 } },
    days: { '2026-11-16': { hints: ['a', 'b'], cap: 3 } },
    reviews: {},
  });
  assert.equal(state.tasks.lire.history.length, 60);
  assert.equal(state.tasks.vide, undefined);
  assert.equal(state.goals.reading.current, 20);
  assert.equal(state.days['2026-11-16'].cap, 3);
});

test('createStore persiste et relit un état sur disque', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-adaptive-'));
  const file = path.join(dir, 'adaptive-state.json');
  const store = createStore({ file });

  store.update((state) => {
    state.goals.reading = {
      id: 'reading',
      title: 'Lire 7 livres',
      unit: 'pages',
      base: 40,
      current: 20,
      history: [],
    };
  });

  const reloaded = createStore({ file });
  assert.equal(reloaded.get().goals.reading.current, 20);
  fs.rmSync(dir, { recursive: true, force: true });
});
