import assert from 'node:assert/strict';
import test from 'node:test';

import {
  KnowledgeContractError,
  parseKnowledgeImportPreview,
  parseKnowledgeImportResult,
  parseKnowledgeList,
  parseKnowledgeMapsResult,
  parseKnowledgeRecord,
  parseKnowledgeRemoval,
  parseKnowledgeSearch,
} from '../../shared/knowledgeContracts.ts';
import { api } from '../../web/src/shared/api-client.js';
import {
  knowledgeApi,
  knowledgeErrorCode,
  knowledgeErrorMessage,
} from '../../web/src/shared/knowledgeApi.ts';

const ID = '00000000-0000-4000-8000-000000000001';
const record = {
  id: ID,
  project: 'demo',
  repository: 'backend',
  kind: 'fact',
  title: 'Очередь деплоя',
  body: 'Полный текст записи.',
  tags: ['queue'],
  updatedAt: '2026-09-01T00:00:00.000Z',
  revision: 3,
  provenance: null,
};
const imported = {
  id: ID,
  title: record.title,
  body: 'Текст из файла.',
  tags: ['queue'],
  kind: 'fact',
  project: 'demo',
  repository: 'backend',
  revision: 3,
  updatedAt: record.updatedAt,
};
const preview = {
  snapshotHash: 'a'.repeat(64),
  summary: { create: 1, update: 0, unchanged: 2, conflict: 1, targetOnly: 0 },
  conflicts: [{
    id: ID,
    title: record.title,
    baseRevision: 3,
    currentRevision: 4,
    changedFields: ['body'],
    incoming: imported,
    current: { ...record, revision: 4 },
  }],
};
const contracts = [
  [parseKnowledgeList, { items: [record], facets: { projects: ['demo'], tags: ['queue'] } }],
  [parseKnowledgeSearch, {
    items: [{ id: ID, title: record.title, tags: ['queue'], fragment: '…деплоя…' }],
  }],
  [parseKnowledgeRecord, { record }],
  [parseKnowledgeRemoval, { deleted: true, id: ID }],
  [parseKnowledgeImportPreview, preview],
  [parseKnowledgeImportResult, {
    created: 1, updated: 0, unchanged: 2, keptCurrent: 1, overwritten: 0, targetOnly: 0, total: 4,
  }],
  [parseKnowledgeMapsResult, { recordCount: 4, mapCount: 2, mapBytes: 1024 }],
];

test('контракты знаний принимают ответ сервера и отбрасывают посторонние поля', () => {
  for (const [parse, payload] of contracts) {
    assert.deepEqual(parse({ ...payload, ignored: 'лишнее поле' }), payload);
    for (const invalid of [null, [], 'text', 12, false, {}]) {
      assert.throws(() => parse(invalid), KnowledgeContractError);
    }
  }
  const provenance = { actor: 'agent', channel: 'chat', ref: 'x' };

  assert.deepEqual(
    parseKnowledgeRecord({ record: { ...record, provenance } }).record.provenance,
    provenance,
  );
});

test('повреждённый элемент отклоняет весь ответ до показа записи человеку', () => {
  const facets = { projects: [], tags: [] };

  assert.throws(
    () => parseKnowledgeList({ items: [record, { ...record, revision: '4' }], facets }),
    /list\.items\[1\]\.revision/,
  );
  assert.throws(() => parseKnowledgeList({ items: [record] }), /list\.facets/);
  assert.throws(() => parseKnowledgeRecord({ record: { ...record, tags: 'queue' } }), /record\.record\.tags/);
  assert.throws(() => parseKnowledgeRemoval({ deleted: false, id: ID }), /removal\.deleted/);
  const conflicts = [{ ...preview.conflicts[0], currentRevision: -1 }];

  assert.throws(
    () => parseKnowledgeImportPreview({ ...preview, conflicts }),
    /importPreview\.conflicts\[0\]\.currentRevision/,
  );
  for (const invalid of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseKnowledgeMapsResult({ recordCount: invalid, mapCount: 1, mapBytes: 1 }),
      /mapsResult\.recordCount/);
  }
});

test('ошибка контракта показывает путь поля без отклонённого значения', () => {
  try {
    parseKnowledgeRecord({ record: { ...record, title: { secret: 'непубликуемое значение' } } });
    assert.fail('Ожидалась ошибка контракта');
  } catch (error) {
    assert.ok(error instanceof KnowledgeContractError);
    assert.match(error.message, /record\.record\.title/);
    assert.doesNotMatch(error.message, /непубликуемое/);
  }
  assert.equal(
    knowledgeErrorMessage({ data: { message: 'Ответ сервера' }, message: 'Транспорт' }),
    'Ответ сервера',
  );
  assert.equal(knowledgeErrorMessage(null, 'Запасной текст'), 'Запасной текст');
  assert.equal(knowledgeErrorMessage({ data: { message: [] }, message: 'Транспорт' }), 'Транспорт');
  assert.equal(knowledgeErrorCode({ data: { error: 'plugin_disabled' } }), 'plugin_disabled');
  assert.equal(knowledgeErrorCode(new Error('обрыв сети')), '');
});

test('адаптер собирает адреса фильтров и передаёт ревизию мутациями', async (t) => {
  const seen = [];
  t.mock.method(api, 'get', async (url) => {
    seen.push(['GET', url]);
    return url.includes('/search')
      ? { items: [] }
      : { items: [], facets: { projects: [], tags: [] } };
  });
  t.mock.method(api, 'put', async (url, body) => {
    seen.push(['PUT', url, body]);
    return { record };
  });
  t.mock.method(api, 'del', async (url, body) => {
    seen.push(['DELETE', url, body]);
    return { deleted: true, id: ID };
  });

  await knowledgeApi.list({ project: 'demo', tag: '' });
  await knowledgeApi.search({ query: 'деплой', project: '', tag: 'queue' });
  const input = {
    project: 'demo', repository: 'backend', kind: 'fact', title: 'Заголовок', body: '', tags: ['queue'],
  };
  const messyId = 'id со слэшем/и пробелом';
  await knowledgeApi.update(messyId, input, 3);
  await knowledgeApi.remove(ID, 3);

  const [, , put, removal] = seen;

  assert.deepEqual(seen.slice(0, 2), [
    ['GET', '/api/knowledge?project=demo'],
    ['GET', `/api/knowledge/search?q=${encodeURIComponent('деплой')}&tag=queue`],
  ]);
  assert.deepEqual(put, ['PUT', `/api/knowledge/${encodeURIComponent(messyId)}`, {
    ...input,
    expectedRevision: 3,
  }]);
  // Слэш внутри id не имеет права создать новый сегмент адреса.
  assert.equal(put[1].split('/').length, 4);
  assert.deepEqual(removal, ['DELETE', `/api/knowledge/${ID}`, { expectedRevision: 3 }]);
});

test('адаптер не выдаёт повреждённый HTTP JSON за успешный результат', async (t) => {
  t.mock.method(api, 'get', async () => ({
    items: [{ ...record, tags: null }],
    facets: { projects: [], tags: [] },
  }));
  t.mock.method(api, 'post', async () => ({ recordCount: 1 }));
  t.mock.method(api, 'upload', async () => ({ ...preview, snapshotHash: 12 }));
  t.mock.method(api, 'download', async () => ({ filename: 'cockpit-knowledge.json' }));

  await assert.rejects(knowledgeApi.list(), KnowledgeContractError);
  await assert.rejects(knowledgeApi.refreshMaps(), KnowledgeContractError);
  await assert.rejects(
    knowledgeApi.previewImport(new File(['{}'], 'backup.json')),
    KnowledgeContractError,
  );
  await assert.rejects(knowledgeApi.exportBackup(), /backup\.blob/);
});

test('импорт отправляет тот же файл, увиденный hash и решения человека', async (t) => {
  const uploads = [];
  t.mock.method(api, 'upload', async (url, formData) => {
    uploads.push([url, formData]);
    return url.endsWith('/preview') ? preview : {
      created: 0, updated: 0, unchanged: 2, keptCurrent: 1, overwritten: 0, targetOnly: 0, total: 3,
    };
  });
  const file = new File(['{"schemaVersion":1}'], 'cockpit-knowledge.json');

  await knowledgeApi.previewImport(file);
  await knowledgeApi.applyImport(file, preview.snapshotHash, [{
    id: ID,
    decision: 'keep-current',
    expectedCurrentRevision: 4,
  }]);

  assert.deepEqual(uploads.map(([url]) => url), [
    '/api/knowledge/backup/import/preview',
    '/api/knowledge/backup/import/apply',
  ]);
  assert.equal(uploads[0][1].get('file'), file);
  assert.equal(uploads[1][1].get('file'), file);
  assert.equal(uploads[1][1].get('snapshotHash'), preview.snapshotHash);
  assert.deepEqual(JSON.parse(uploads[1][1].get('resolutions')), [{
    id: ID,
    decision: 'keep-current',
    expectedCurrentRevision: 4,
  }]);
});
