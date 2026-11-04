'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSubtaskDigest,
  validateOrderResponse,
  buildOrderPrompt,
} = require('../src/subtaskOrder');

function task(id, title, parentId = null) {
  return {
    id,
    content: title,
    display_title: title,
    description: '',
    parent_id: parentId,
    due_date: null,
    project_archived: false,
    project_name: 'Projet',
  };
}

function snapshot() {
  return {
    tasks: [
      task('root', 'Ranger la cave'),
      task('a', 'Trier les outils', 'root'),
      task('b', 'Descendre les cartons', 'root'),
      task('a1', 'Lister les outils', 'a'),
      task('a2', 'Ranger les outils', 'a'),
    ],
  };
}

test('buildSubtaskDigest construit l’arbre récursif complet', () => {
  const digest = buildSubtaskDigest(snapshot(), 'root');
  assert.equal(digest.root_id, 'root');
  assert.equal(digest.tree.title, 'Ranger la cave');
  assert.equal(digest.tree.children.length, 2);

  const a = digest.tree.children.find((node) => node.id === 'a');
  assert.deepEqual(a.children.map((node) => node.id), ['a1', 'a2']);
  assert.equal(digest.truncated.length, 0);
});

test('buildOrderPrompt demande un ordre pour chaque parent', () => {
  const prompt = buildOrderPrompt(buildSubtaskDigest(snapshot(), 'root'));
  assert.match(prompt, /ordre logique/);
  assert.match(prompt, /TOUS ses enfants directs/);
  assert.match(prompt, /orders/);
});

test('validateOrderResponse applique l’ordre et complète les oublis', () => {
  const digest = buildSubtaskDigest(snapshot(), 'root');
  const { orders, changed, summary } = validateOrderResponse(
    {
      summary: 'Descendre les cartons avant de trier.',
      orders: {
        root: ['b', 'a'],
        a: ['a2'], // a1 oublié
      },
    },
    digest
  );

  assert.deepEqual(orders.root, ['b', 'a']);
  assert.deepEqual(orders.a, ['a2', 'a1']);
  assert.equal(changed, 1);
  assert.match(summary, /Descendre/);
});

test('validateOrderResponse ignore les identifiants inconnus et les doublons', () => {
  const digest = buildSubtaskDigest(snapshot(), 'root');
  const { orders, changed } = validateOrderResponse(
    { orders: { root: ['ghost', 'a', 'a', 'b'] } },
    digest
  );

  assert.deepEqual(orders.root, ['a', 'b']);
  // L'ordre Todoist de départ est b, a (tri par titre) : l'IA le change bien.
  assert.equal(changed, 1);
  assert.deepEqual(orders.a, ['a1', 'a2']);
});

test('buildSubtaskDigest renvoie null pour une tâche absente', () => {
  assert.equal(buildSubtaskDigest(snapshot(), 'nope'), null);
});
