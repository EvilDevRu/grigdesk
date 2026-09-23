// Чтение реестра паспортов: обе схемы записи приводятся к одной форме.
//
// В файле настроек лежат записи двух поколений: старая знает только `repos`, новая —
// весь паспорт. Читатели не должны различать их сами, иначе каждый новый потребитель
// повторял бы разбор умолчаний по-своему и расходился с остальными.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  listProjectRecords,
  readProjectRecord,
  readProjectsMeta,
} from '../../server/src/lib/projects.ts';

function prefsWith(stored) {
  return { read: () => stored };
}

const LEGACY = { repos: [{ key: 'be', dir: '/srv/be' }] };

test('readProjectRecord дополняет legacy-запись значениями по умолчанию', () => {
  assert.deepEqual(readProjectRecord(prefsWith({ projects: { demo: LEGACY } }), 'demo'), {
    title: 'demo',
    description: '',
    tags: [],
    repos: [{ key: 'be', dir: '/srv/be' }],
    defaultRepoKey: null,
    archivedAt: null,
    import: { status: 'none', fingerprint: null, at: null, error: null, candidates: null },
    revision: 0,
    createdAt: null,
    updatedAt: null,
  });
});

test('readProjectRecord возвращает null для отсутствующего id и записи не-объекта', () => {
  assert.equal(readProjectRecord(prefsWith({ projects: {} }), 'demo'), null);
  assert.equal(readProjectRecord(prefsWith({}), 'demo'), null);
  assert.equal(readProjectRecord(prefsWith({ projects: { demo: 'строка' } }), 'demo'), null);
  assert.equal(readProjectRecord(prefsWith({ projects: { demo: [] } }), 'demo'), null);
  assert.equal(readProjectRecord(prefsWith({ projects: { demo: null } }), 'demo'), null);
  assert.equal(readProjectRecord(null, 'demo'), null);
});

test('listProjectRecords сортирует по id и пропускает ключи вне PROFILE_RE', () => {
  const prefs = prefsWith({
    projects: {
      zebra: LEGACY,
      'Bad Key': LEGACY,
      alpha: LEGACY,
      '2gis': LEGACY,
      'a b': LEGACY,
    },
  });

  assert.deepEqual(
    listProjectRecords(prefs).map((record) => record.id),
    ['2gis', 'alpha', 'zebra'],
  );
  assert.equal(listProjectRecords(prefs)[0].title, '2gis');
});

test('readProjectsMeta отдаёт умолчание при отсутствии ключа', () => {
  const defaults = { schemaVersion: 0, migratedAt: null, tombstones: {} };

  assert.deepEqual(readProjectsMeta(prefsWith({})), defaults);
  assert.deepEqual(readProjectsMeta(prefsWith({ projectsMeta: {} })), defaults);
  assert.deepEqual(readProjectsMeta(null), defaults);
  assert.deepEqual(readProjectsMeta(prefsWith({ projectsMeta: { schemaVersion: 1 } })), {
    ...defaults,
    schemaVersion: 1,
  });

  const full = {
    schemaVersion: 1,
    migratedAt: '2026-09-22T10:00:00.000Z',
    tombstones: { old: { deletedAt: '2026-09-22T09:00:00.000Z', revision: 3 } },
  };

  assert.deepEqual(readProjectsMeta(prefsWith({ projectsMeta: full })), full);
});
