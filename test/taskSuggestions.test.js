'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSuggestPrompt,
  validateTaskSuggestions,
} = require('../src/taskSuggestions');

const DATE = '2026-11-05';

function snapshot() {
  return {
    projects: [
      { id: 'p1', name: 'Maison', is_archived: false },
      { id: 'p2', name: 'Travail', is_archived: false },
    ],
    tasks: [
      {
        id: 't1',
        content: 'Ranger la cave',
        display_title: 'Ranger la cave',
        project_id: 'p1',
        project_archived: false,
      },
    ],
  };
}

const digest = { date: DATE, can_add: { L: 1, M: 1, S: 1 } };

test('validateTaskSuggestions crée des propositions valides', () => {
  const { items } = validateTaskSuggestions(
    {
      summary: 'Deux idées utiles.',
      tasks: [
        {
          title: 'Trier les cartons de la cave',
          project_id: 'p1',
          life_area: 'Ranger la maison',
          due_date: DATE,
          size: 'M',
          priority: 4,
          reason: 'Avance le rangement',
        },
      ],
    },
    snapshot(),
    DATE,
    digest,
    3
  );

  assert.equal(items.length, 1);
  const item = items[0];
  assert.equal(item.type, 'create_task');
  assert.equal(item.action.content, 'Trier les cartons de la cave');
  assert.equal(item.action.project_id, 'p1');
  assert.equal(item.action.life_area, 'Ranger la maison');
  assert.equal(item.action.priority, 4);
  assert.equal(item.target.project_name, 'Maison');
  assert.equal(item.editable.includes('due_date'), true);
});

test('validateTaskSuggestions rejette doublons, projets inconnus et dates trop lointaines', () => {
  const { items } = validateTaskSuggestions(
    {
      tasks: [
        { title: 'Ranger la cave', project_id: 'p1', due_date: DATE, size: 'M' },
        { title: 'Tâche inconnue', project_id: 'nope', due_date: DATE, size: 'M' },
        { title: 'Trop loin', project_id: 'p1', due_date: '2027-01-01', size: 'M' },
        { title: 'Sans projet', due_date: DATE, size: 'M' },
        { title: 'Demain', project_id: 'p2', due_date: '2026-11-06', size: 'S' },
      ],
    },
    snapshot(),
    DATE,
    digest,
    3
  );
  assert.deepEqual(items.map((item) => item.action.content), ['Demain']);
  assert.equal(items[0].action.due_date, '2026-11-06');
});

test('validateTaskSuggestions ne repropose pas une tâche déjà faite aujourd’hui', () => {
  const snap = snapshot();
  snap.completed = { today: [{ title: 'Enregistrer mes 3 repas dans Lose It!' }] };
  const { items } = validateTaskSuggestions(
    {
      tasks: [
        {
          title: 'Enregistrer mes 3 repas dans Lose It!',
          project_id: 'p1',
          due_date: DATE,
          size: 'S',
        },
      ],
    },
    snap,
    DATE,
    digest,
    3
  );
  assert.equal(items.length, 0);
});

test('validateTaskSuggestions respecte la place et le maximum', () => {
  const many = Array.from({ length: 6 }, (_, i) => ({
    title: `Nouvelle tâche ${i}`,
    project_id: 'p1',
    due_date: DATE,
    size: 'S',
  }));
  const { items } = validateTaskSuggestions(
    { tasks: many },
    snapshot(),
    DATE,
    { date: DATE, can_add: { L: 0, M: 0, S: 2 } },
    3
  );
  assert.equal(items.length, 2);
});

test('buildSuggestPrompt interdit les doublons et les tâches vagues', () => {
  const prompt = buildSuggestPrompt(
    { date: DATE, can_add: { L: 1, M: 1, S: 1 } },
    3
  );
  assert.match(prompt, /NOUVELLES tâches/);
  assert.match(prompt, /Ne duplique aucune tâche existante/);
  assert.match(prompt, /project_context/);
  assert.match(prompt, /life_context/);
  assert.match(prompt, /date future/);
});
