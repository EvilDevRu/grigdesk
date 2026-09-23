// Контракт раздела «Проекты» на стороне клиента: что принимается за паспорт проекта,
// а что обязано отвергаться.
//
// Ответ сервера приходит по сети и до проверки данными не является. Здесь это особенно
// важно: по ревизии паспорта решается, чья правка победит, а по полям ошибки форма
// раскладывает подсказки по своим полям.
import assert from 'node:assert/strict';
import test from 'node:test';

import { compileModule, webFile } from './helpers/compile-vue.js';

const contract = await compileModule(webFile('../shared/projectsContracts.ts'));

const SUMMARY = {
  id: 'demo',
  title: 'Демо-проект',
  tags: ['конвейер'],
  repos: [{ key: 'be', dir: '/srv/demo/be', exists: true }],
  defaultRepoKey: 'be',
  archivedAt: null,
  revision: 3,
  updatedAt: '2026-09-22T10:00:00.000Z',
  profile: { present: true, pathsSource: 'passport' },
  importStatus: 'none',
  routes: ['hunt'],
  warnings: ['Каталог объявлен дважды'],
};

const DETAIL = {
  ...SUMMARY,
  description: 'Описание проекта',
  createdAt: '2026-09-22T09:00:00.000Z',
  import: {
    status: 'conflict',
    fingerprint: 'abc',
    at: '2026-09-22T09:30:00.000Z',
    error: null,
    candidates: {
      prefs: [{ key: 'be', dir: '/srv/demo/be' }],
      profile: [
        { key: 'be', dir: '/srv/demo/be' },
        { key: 'fe', dir: '/srv/demo/fe' },
      ],
    },
  },
  profile: {
    present: true,
    pathsSource: 'passport',
    readable: true,
    repos: [{ key: 'be', dir: '/srv/demo/be' }],
    capabilities: ['triage'],
    mismatch: [{ key: 'fe', dir: '/srv/demo/fe' }],
  },
};

// Тело запроса на создание: ровно те поля, которые форма шлёт серверу.
const INPUT = {
  id: 'demo',
  title: 'Демо-проект',
  description: 'Описание проекта',
  tags: ['конвейер'],
  repos: [{ key: 'be', dir: '/srv/demo/be' }],
  defaultRepoKey: 'be',
};

// Поле ошибки называет путь внутри формы; форма по нему ставит подсказку у своего поля.
function pathsOf(result) {
  assert.equal(result.ok, false, 'ожидался отказ проверки');

  return result.fieldErrors.map((error) => error.path);
}

function errorsOf(input, options = { creating: true }) {
  return pathsOf(contract.validateProjectInput(input, options));
}

test('parseProjectSummaries принимает сводку по контракту и не теряет поля', () => {
  assert.deepEqual(contract.parseProjectSummaries({ projects: [SUMMARY] }), [SUMMARY]);
});

test('parseProjectSummaries отвергает revision не целым и отсутствующий archivedAt', () => {
  for (const invalid of [
    { ...SUMMARY, revision: 1.5 },
    { ...SUMMARY, revision: -1 },
  ]) {
    assert.throws(
      () => contract.parseProjectSummaries({ projects: [invalid] }),
      (error) => error instanceof contract.ProjectsContractError
        && error.message.includes('projects.0.revision'),
    );
  }

  const withoutArchived = structuredClone(SUMMARY);

  delete withoutArchived.archivedAt;
  assert.throws(
    () => contract.parseProjectSummaries({ projects: [withoutArchived] }),
    (error) => error instanceof contract.ProjectsContractError
      && error.message.includes('projects.0.archivedAt'),
  );
  assert.throws(
    () => contract.parseProjectSummaries({ projects: [{ ...SUMMARY, importStatus: 'готово' }] }),
    contract.ProjectsContractError,
  );
});

test('parseProjectDetail требует profile.repos, import и description', () => {
  assert.deepEqual(contract.parseProjectDetail(DETAIL), DETAIL);

  for (const field of ['description', 'import', 'createdAt']) {
    const invalid = structuredClone(DETAIL);

    delete invalid[field];
    assert.throws(() => contract.parseProjectDetail(invalid), contract.ProjectsContractError);
  }

  const withoutRepos = structuredClone(DETAIL);

  delete withoutRepos.profile.repos;
  assert.throws(() => contract.parseProjectDetail(withoutRepos), contract.ProjectsContractError);

  const withoutCandidates = structuredClone(DETAIL);

  delete withoutCandidates.import.candidates;
  assert.throws(
    () => contract.parseProjectDetail(withoutCandidates),
    contract.ProjectsContractError,
  );
});

test('parseProjectsError даёт fieldErrors и currentRevision, если они есть, и терпит их отсутствие', () => {
  const withDetails = {
    error: 'revision_conflict',
    message: 'Паспорт изменился в другой вкладке',
    fieldErrors: [{ path: 'title', message: 'Слишком длинное название' }],
    currentRevision: 4,
  };

  assert.deepEqual(contract.parseProjectsError(withDetails), withDetails);
  assert.deepEqual(
    contract.parseProjectsError({ error: 'not_found', message: 'Проект не найден' }),
    {
      error: 'not_found',
      message: 'Проект не найден',
      fieldErrors: [],
      currentRevision: null,
    },
  );
  assert.throws(
    () => contract.parseProjectsError({ error: 42, message: 'Проект не найден' }),
    contract.ProjectsContractError,
  );
});

test('parseRepositoryCheck принимает состояния из §1.3 и отвергает незнакомое', () => {
  const results = ['git', 'worktree', 'dir', 'missing', 'file', 'denied', 'timeout']
    .map((state) => ({ dir: `/srv/demo/${state}`, state, message: 'Проверено' }));

  assert.deepEqual(contract.parseRepositoryCheck({ results }), { results });

  for (const invalid of [
    { results: [{ dir: '/srv/demo', state: 'symlink', message: '' }] },
    { results: [{ dir: '/srv/demo', state: 'git' }] },
    { results: null },
  ]) {
    assert.throws(() => contract.parseRepositoryCheck(invalid), contract.ProjectsContractError);
  }
});

test('PROJECT_ID_RE и REPO_KEY_RE', () => {
  for (const id of ['a', 'new', 'a-b_1', `a${'b'.repeat(40)}`]) {
    assert.ok(contract.PROJECT_ID_RE.test(id), `id ${id} должен приниматься`);
  }

  for (const id of ['2gis', '', 'A', `a${'b'.repeat(41)}`, 'a b']) {
    assert.ok(!contract.PROJECT_ID_RE.test(id), `id ${id} должен отвергаться`);
  }

  for (const key of ['a', '1fe', 'b'.repeat(16)]) {
    assert.ok(contract.REPO_KEY_RE.test(key), `ключ ${key} должен приниматься`);
  }

  for (const key of ['', 'b'.repeat(17), 'Be', 'be fe']) {
    assert.ok(!contract.REPO_KEY_RE.test(key), `ключ ${key} должен отвергаться`);
  }
});

test('validateProjectInput возвращает fieldErrors по путям', () => {
  assert.deepEqual(errorsOf({ ...INPUT, repos: undefined }), ['repos']);
  assert.deepEqual(errorsOf({ ...INPUT, repos: null }), ['repos']);
  assert.deepEqual(
    errorsOf({ ...INPUT, repos: [{ key: 'be', dir: '/srv/a' }, { key: 'be', dir: '/srv/b' }] }),
    ['repos.1.key'],
  );
  assert.deepEqual(errorsOf({ ...INPUT, repos: [{ key: 'be', dir: 'srv/a' }] }), ['repos.0.dir']);
  assert.deepEqual(
    errorsOf({ ...INPUT, repos: [{ key: 'be', dir: '/srv/a\u0000b' }] }),
    ['repos.0.dir'],
  );
  assert.deepEqual(errorsOf({ ...INPUT, defaultRepoKey: 'fe' }), ['defaultRepoKey']);
  assert.deepEqual(errorsOf({ ...INPUT, title: 'т'.repeat(121) }), ['title']);
  assert.deepEqual(errorsOf({ ...INPUT, title: undefined }), ['title']);
  assert.deepEqual(errorsOf({ ...INPUT, foo: 1 }), ['foo']);
  assert.deepEqual(errorsOf({ ...INPUT, id: '2gis' }), ['id']);
  assert.deepEqual(errorsOf({ ...INPUT, id: undefined }), ['id']);

  // Ревизия приходит только на изменение: у создания её в теле быть не должно.
  assert.deepEqual(errorsOf({ ...INPUT, expectedRevision: 3 }), ['expectedRevision']);
  assert.deepEqual(errorsOf({ ...INPUT, id: undefined }, { creating: false }), ['id']);
  assert.deepEqual(errorsOf({ ...INPUT, repos: [{ key: 'BE', dir: '/srv/a' }] }), ['repos.0.key']);

  const tags = Array.from({ length: 21 }, (unused, index) => `метка-${index}`);

  assert.deepEqual(errorsOf({ ...INPUT, tags }), ['tags']);
  assert.deepEqual(errorsOf({ ...INPUT, tags: ['т'.repeat(33)] }), ['tags']);
  assert.deepEqual(errorsOf({ ...INPUT, description: 'о'.repeat(2001) }), ['description']);
  assert.deepEqual(
    errorsOf({ ...INPUT, repos: Array.from({ length: 33 }, (unused, index) => ({
      key: `r${index}`,
      dir: `/srv/${index}`,
    })) }),
    ['repos'],
  );
  assert.deepEqual(
    errorsOf({ ...INPUT, repos: [{ key: 'be', dir: `/${'п'.repeat(1024)}` }] }),
    ['repos.0.dir'],
  );
});

test('validateProjectInput обрезает пробелы и не трогает путь сверх этого', () => {
  const input = {
    id: ' demo ',
    title: '  Демо-проект  ',
    description: '  Описание  ',
    tags: ['  конвейер  '],
    repos: [{ key: ' be ', dir: ' /srv/demo/be/../fe ' }],
    defaultRepoKey: ' be ',
  };

  assert.deepEqual(contract.validateProjectInput(input, { creating: true }), {
    ok: true,
    value: {
      id: 'demo',
      title: 'Демо-проект',
      description: 'Описание',
      tags: ['конвейер'],
      repos: [{ key: 'be', dir: '/srv/demo/be/../fe' }],
      defaultRepoKey: 'be',
    },
  });

  const update = contract.validateProjectInput(
    {
      title: '  Демо-проект  ',
      description: '  Описание  ',
      tags: ['  конвейер  '],
      repos: [{ key: ' be ', dir: ' /srv/demo/be/../fe ' }],
      defaultRepoKey: ' be ',
      expectedRevision: 3,
    },
    { creating: false },
  );

  assert.equal(update.ok, true);
  assert.equal('id' in update.value, false);
  assert.equal(update.value.expectedRevision, 3);
});

test('parseProjectDependencies принимает сводку связей и отвергает отрицательный счётчик', () => {
  const summary = {
    items: [
      { kind: 'telegram', label: 'Правила Telegram', count: 2, items: ['Правило A', 'Правило B'] },
      { kind: 'ssh', label: 'Профили SSH', count: 1, items: [] },
    ],
    archivable: false,
    deletable: false,
    reasons: ['Архив невозможен: правила Telegram — 2.'],
  };

  assert.deepEqual(contract.parseProjectDependencies(summary), summary);
  assert.deepEqual(
    contract.parseProjectDependencies({
      items: [],
      archivable: true,
      deletable: false,
      reasons: [],
    }),
    { items: [], archivable: true, deletable: false, reasons: [] },
  );

  for (const invalid of [
    { ...summary, items: [{ ...summary.items[0], count: -1 }] },
    { ...summary, archivable: 'да' },
    { ...summary, items: [{ ...summary.items[0], items: null }] },
    { ...summary, reasons: null },
  ]) {
    assert.throws(
      () => contract.parseProjectDependencies(invalid),
      contract.ProjectsContractError,
    );
  }
});
