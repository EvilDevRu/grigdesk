// Черновик паспорта проекта: чистая правка формы без сети и состояния.
//
// Форма меняет не серверный снимок, а его копию: сравнивать правки с исходным
// снимком, переносить выбор по умолчанию вместе со строкой и отдавать на сервер
// ровно поля паспорта — всё это арифметика над объектом, и проверяется она здесь,
// а не через смонтированный компонент.
import assert from 'node:assert/strict';
import test from 'node:test';

import { compileModule, webFile } from './helpers/compile-vue.js';

const draftModule = await compileModule(webFile('src/views/projects/projectDraft.ts'));

const DETAIL = {
  id: 'demo',
  title: 'Демо-проект',
  description: 'Описание проекта',
  tags: ['метка'],
  repos: [
    { key: 'be', dir: '/srv/be', exists: true },
    { key: 'fe', dir: '/srv/fe', exists: false },
  ],
  defaultRepoKey: 'be',
  archivedAt: null,
  revision: 3,
  updatedAt: '2026-09-22T10:00:00.000Z',
  profile: {
    present: false,
    pathsSource: 'passport',
    readable: null,
    repos: [],
    capabilities: [],
    mismatch: [],
  },
  importStatus: 'none',
  routes: [],
  warnings: [],
  createdAt: null,
  import: { status: 'none', fingerprint: null, at: null, error: null, candidates: null },
};

function keysOf(draft) {
  return draft.repos.map((repo) => repo.key);
}

test('createDraft копирует снимок, isDirty ложно без правок и истинно после изменения title', () => {
  const snapshot = draftModule.createDraft(DETAIL);
  const draft = draftModule.createDraft(DETAIL);

  assert.deepEqual(draft, {
    id: 'demo',
    title: 'Демо-проект',
    description: 'Описание проекта',
    tags: ['метка'],
    repos: [{ key: 'be', dir: '/srv/be' }, { key: 'fe', dir: '/srv/fe' }],
    defaultRepoKey: 'be',
    defaultRepoRequired: false,
  });
  assert.equal(draftModule.isDirty(draft, snapshot), false);

  draft.tags.push('ещё');
  draft.repos[0].dir = '/srv/другой';

  assert.equal(DETAIL.tags.length, 1, 'снимок не меняется вместе с черновиком');
  assert.equal(DETAIL.repos[0].dir, '/srv/be');

  draft.title = 'Другое название';
  assert.equal(draftModule.isDirty(draft, snapshot), true);
});

test('createDraft(null) даёт пустой черновик нового проекта', () => {
  assert.deepEqual(draftModule.createDraft(null), {
    id: '',
    title: '',
    description: '',
    tags: [],
    repos: [],
    defaultRepoKey: null,
    defaultRepoRequired: false,
  });
});

test('removeRepo последней строки обнуляет defaultRepoKey', () => {
  const single = draftModule.createDraft({ ...DETAIL, repos: [DETAIL.repos[0]] });
  const afterRemoval = draftModule.removeRepo(single, 0);

  assert.deepEqual(afterRemoval.repos, []);
  assert.equal(afterRemoval.defaultRepoKey, null);
  assert.equal(afterRemoval.defaultRepoRequired, false);

  // Строка невыбранного репозитория уходит, не трогая выбор по умолчанию.
  const other = draftModule.removeRepo(draftModule.createDraft(DETAIL), 1);

  assert.deepEqual(keysOf(other), ['be']);
  assert.equal(other.defaultRepoKey, 'be');
  assert.equal(other.defaultRepoRequired, false);
});

test('удаление выбранного репозитория при оставшихся строках помечает требование выбора', () => {
  const afterRemoval = draftModule.removeRepo(draftModule.createDraft(DETAIL), 0);

  assert.deepEqual(keysOf(afterRemoval), ['fe']);
  assert.equal(afterRemoval.defaultRepoKey, null);
  assert.equal(afterRemoval.defaultRepoRequired, true);
});

test('renameRepoKey переносит defaultRepoKey вместе со строкой', () => {
  const renamed = draftModule.renameRepoKey(draftModule.createDraft(DETAIL), 0, 'backend');

  assert.deepEqual(keysOf(renamed), ['backend', 'fe']);
  assert.equal(renamed.defaultRepoKey, 'backend');

  const untouched = draftModule.renameRepoKey(draftModule.createDraft(DETAIL), 1, 'frontend');

  assert.deepEqual(keysOf(untouched), ['be', 'frontend']);
  assert.equal(untouched.defaultRepoKey, 'be');
});

test('moveRepo меняет порядок и не выходит за границы', () => {
  const moved = draftModule.moveRepo(draftModule.createDraft(DETAIL), 0, 1);

  assert.deepEqual(keysOf(moved), ['fe', 'be']);
  assert.equal(moved.defaultRepoKey, 'be');

  assert.deepEqual(keysOf(draftModule.moveRepo(moved, 1, 1)), ['fe', 'be']);
  assert.deepEqual(keysOf(draftModule.moveRepo(moved, 0, -1)), ['fe', 'be']);
  assert.deepEqual(keysOf(draftModule.moveRepo(moved, 5, 1)), ['fe', 'be']);
});

test('changedFields перечисляет только отличающиеся поля, repos сравниваются по содержимому', () => {
  const snapshot = draftModule.createDraft(DETAIL);

  assert.deepEqual(draftModule.changedFields(snapshot, snapshot), []);
  assert.deepEqual(
    draftModule.changedFields({ ...snapshot, tags: ['метка'] }, snapshot),
    [],
  );
  assert.deepEqual(
    draftModule.changedFields(
      { ...snapshot, title: 'Другое', repos: [{ key: 'fe', dir: '/srv/fe' }] },
      snapshot,
    ),
    ['title', 'repos'],
  );
  assert.deepEqual(
    draftModule.changedFields({ ...snapshot, defaultRepoKey: null }, snapshot),
    ['defaultRepoKey'],
  );
  assert.deepEqual(
    draftModule.changedFields({ ...snapshot, description: 'Правка', tags: ['метка', 'новая'] }, snapshot),
    ['description', 'tags'],
  );
});

test('toInput отдаёт repos: [] явно и не содержит серверных полей', () => {
  const draft = { ...draftModule.createDraft(DETAIL), repos: [] };
  const input = draftModule.toInput(draft);

  assert.deepEqual(input, {
    title: 'Демо-проект',
    description: 'Описание проекта',
    tags: ['метка'],
    repos: [],
    defaultRepoKey: 'be',
  });
  assert.deepEqual(
    Object.keys(input).sort(),
    ['defaultRepoKey', 'description', 'repos', 'tags', 'title'],
  );
  assert.equal('revision' in input, false);
  assert.equal('id' in input, false);
});
