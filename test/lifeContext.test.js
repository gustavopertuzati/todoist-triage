'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { appendLifeProgress, readLifeContext } = require('../src/lifeContext');

function tempFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-test-'));
  const file = path.join(dir, 'LIFE_CONTEXT.md');
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

test('appendLifeProgress crée la section et ajoute une ligne', () => {
  const file = tempFile('# Contexte\n\n## Projets\n\n- Projet A\n');
  const result = appendLifeProgress(
    {
      title: 'Faire une action',
      projectName: 'Projet A',
      dueDate: '2026-11-06',
      taskId: 'task1',
      createdAt: new Date('2026-11-05T10:00:00Z'),
    },
    { file }
  );

  assert.equal(result.saved, true);
  const text = readLifeContext(file);
  assert.match(text, /## Journal des tâches créées/);
  assert.match(text, /Projet A.*Faire une action.*2026-11-06.*task1/);
});

test('appendLifeProgress est idempotent par identifiant de tâche', () => {
  const file = tempFile('# Contexte\n');
  const entry = {
    title: 'Action',
    projectName: 'P',
    dueDate: '2026-11-06',
    taskId: 'same-id',
  };
  assert.equal(appendLifeProgress(entry, { file }).saved, true);
  assert.equal(appendLifeProgress(entry, { file }).saved, false);
  const lines = readLifeContext(file)
    .split('\n')
    .filter((line) => line.includes('same-id'));
  assert.equal(lines.length, 1);
});

test('appendLifeProgress refuse un titre vide', () => {
  const file = tempFile('# Contexte\n');
  const result = appendLifeProgress({ title: '  ', projectName: 'P' }, { file });
  assert.equal(result.saved, false);
  assert.equal(result.reason, 'EMPTY_TITLE');
});
