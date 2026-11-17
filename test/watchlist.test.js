'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const watchlist = require('../src/watchlist');

function snapshot(overrides = {}) {
  return {
    meta: { today: '2026-11-17' },
    projects: [
      { id: '6fVFQXGQmXGq83WF', name: 'QG – Vie Gustavo', is_archived: false },
    ],
    tasks: [],
    completed: { recent: [] },
    proposals: [],
    summary: { proposals: { total: 0, by_type: {}, truncated: {} } },
    ...overrides,
  };
}

test('six propositions de veille sont datées sur des jours creux', () => {
  const items = watchlist.buildWatchProposals(snapshot());
  assert.equal(items.length, 6);
  assert.deepEqual(
    items.map((item) => item.action.due_date),
    ['2026-11-27', '2026-11-30', '2026-12-02', '2026-12-04', '2026-12-07', '2026-12-09']
  );
  assert.ok(items.every((item) => item.type === 'create_task'));
  assert.ok(items.every((item) => item.source === 'watchlist'));
  assert.equal(items[0].action.project_id, '6fVFQXGQmXGq83WF');
  assert.equal(items[0].action.priority, 3);
});

test('une tâche déjà créée ou terminée n’est plus proposée', () => {
  const withTask = watchlist.buildWatchProposals(
    snapshot({
      tasks: [{ content: 'Veille : tester Vite.js (30 min)' }],
    })
  );
  assert.equal(withTask.length, 5);
  assert.equal(
    withTask.some((item) => item.action.content.includes('Vite.js')),
    false
  );

  const withCompleted = watchlist.buildWatchProposals(
    snapshot({
      completed: { recent: [{ title: 'Veille : explorer CesiumJS (30 min)' }] },
    })
  );
  assert.equal(withCompleted.length, 5);
});

test('une date passée est reproposée pour aujourd’hui', () => {
  const items = watchlist.buildWatchProposals(
    snapshot({ meta: { today: '2026-12-15' } })
  );
  assert.ok(items.length >= 6);
  assert.ok(items.every((item) => item.action.due_date === '2026-12-15'));
});

test('injectWatchProposals ajoute les propositions et met à jour le résumé', () => {
  const base = snapshot();
  const injected = watchlist.injectWatchProposals(base);
  assert.equal(injected.proposals.length, 6);
  assert.equal(injected.summary.proposals.total, 6);
  assert.equal(injected.summary.proposals.by_type.create_task, 6);
});
