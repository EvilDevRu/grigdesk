import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { createKnowledgeTransfer } from '../../server/src/lib/search/transfer.ts';
import { knowledgeFixture, record } from './helpers/knowledge.js';

let knowledgeModule;
let knowledgeModuleError;
try {
  knowledgeModule = (await import('../../server/src/modules/knowledge/index.ts')).default;
} catch (error) {
  knowledgeModuleError = error;
}

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');
const multipartPlugin = requireFromServer('@fastify/multipart');

const BACKUP_BYTES = Buffer.from('{"schemaVersion":1,"snapshotHash":"snapshot-1","records":[]}');

function multipartBody({ files = [BACKUP_BYTES], fields = {}, fileFirst = false } = {}) {
  const boundary = `----cockpit-knowledge-${Math.random().toString(16).slice(2)}`;
  const fieldParts = Object.entries(fields).flatMap(([name, value]) => [
    `--${boundary}`,
    `Content-Disposition: form-data; name="${name}"`,
    '',
    String(value),
  ]);
  const fileParts = files.flatMap((content, index) => [
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="backup-${index}.json"`,
    'Content-Type: application/json',
    '',
    Buffer.from(content).toString('utf8'),
  ]);
  const parts = fileFirst ? [...fileParts, ...fieldParts] : [...fieldParts, ...fileParts];
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.from([...parts, `--${boundary}--`, ''].join('\r\n')),
  };
}

function requireKnowledgeModule() {
  assert.equal(
    typeof knowledgeModule,
    'function',
    `HTTP-модуль знаний ещё не реализован: ${knowledgeModuleError?.message || 'нет default export'}`,
  );
  return knowledgeModule;
}

function fakeRecord(overrides = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    project: 'alpha',
    repository: 'backend',
    kind: 'fact',
    title: 'Очередь деплоя',
    body: 'Полный текст записи.',
    tags: ['queue'],
    updatedAt: '2026-08-29T00:00:00.000Z',
    revision: 3,
    ...overrides,
  };
}

async function fixture(t, overrides = {}) {
  let enabled = overrides.enabled ?? true;
  const calls = [];
  const knowledge = {
    async list(input) {
      calls.push(['list', input]);
      return { items: [fakeRecord()], facets: { projects: ['alpha'], tags: ['queue'] } };
    },
    async search(input) {
      calls.push(['search', input]);
      return { items: [{
        id: fakeRecord().id,
        title: fakeRecord().title,
        tags: ['queue'],
        fragment: '…текст деплоя…',
      }] };
    },
    async read(id) {
      calls.push(['read', id]);
      return fakeRecord();
    },
    async create(input) {
      calls.push(['create', input]);
      return fakeRecord({ ...input, revision: 1 });
    },
    async update(id, input) {
      calls.push(['update', id, input]);
      return fakeRecord({ ...input, id, revision: input.expectedRevision + 1 });
    },
    async delete(id, input) {
      calls.push(['delete', id, input]);
      return { deleted: true, id };
    },
    ...overrides.knowledge,
  };
  const transfer = overrides.transfer || {
    async exportKnowledge() {
      calls.push(['transfer', 'exportKnowledge']);
      return overrides.exportResult || BACKUP_BYTES;
    },
    async previewImport(bytes) {
      calls.push(['transfer', 'previewImport', bytes]);
      return overrides.previewResult || {
        snapshotHash: 'snapshot-1',
        summary: { create: 0, update: 0, unchanged: 0, conflict: 0, targetOnly: 0 },
        conflicts: [],
      };
    },
    async applyImport(bytes, input) {
      calls.push(['transfer', 'applyImport', bytes, input]);
      return overrides.applyResult || {
        created: 0,
        updated: 0,
        unchanged: 0,
        keptCurrent: 0,
        overwritten: 0,
        targetOnly: 0,
        total: 0,
      };
    },
    async updateMaps() {
      calls.push(['transfer', 'updateMaps']);
      return overrides.mapsResult || {
        recordCount: 243,
        mapCount: 14,
        mapBytes: 30400,
        totalContextBytes: 48100,
      };
    },
  };
  const app = Fastify({ logger: false });
  app.decorate('pluginEnabled', (id) => id === 'knowledge' && enabled);
  await app.register(multipartPlugin, { limits: { fileSize: 70 * 1024 ** 2, files: 2 } });
  await app.register(requireKnowledgeModule(), { knowledge, transfer });
  t.after(() => app.close());
  return { app, calls, setEnabled(value) { enabled = value; } };
}

test('Список передаёт проект и тег сервису и возвращает фасеты без кеширования', async (t) => {
  const { app, calls } = await fixture(t);
  const response = await app.inject({
    method: 'GET',
    url: '/api/knowledge?project=alpha&tag=queue',
  });

  assert.deepEqual({
    status: response.statusCode,
    cache: response.headers['cache-control'],
    calls,
    body: response.json(),
  }, {
    status: 200,
    cache: 'no-store',
    calls: [['list', { project: 'alpha', tags: ['queue'] }]],
    body: { items: [fakeRecord()], facets: { projects: ['alpha'], tags: ['queue'] } },
  });
});

test('Поиск имеет отдельную ручку и возвращает только краткие результаты', async (t) => {
  const { app, calls } = await fixture(t);
  const response = await app.inject({
    method: 'GET',
    url: '/api/knowledge/search?q=%D0%B4%D0%B5%D0%BF%D0%BB%D0%BE%D0%B9&limit=7',
  });

  assert.deepEqual({ status: response.statusCode, calls, body: response.json() }, {
    status: 200,
    calls: [['search', { query: 'деплой', limit: 7 }]],
    body: { items: [{
      id: fakeRecord().id,
      title: 'Очередь деплоя',
      tags: ['queue'],
      fragment: '…текст деплоя…',
    }] },
  });
});

test('Чтение полной записи доступно по отдельному id-маршруту', async (t) => {
  const { app, calls } = await fixture(t);
  const id = fakeRecord().id;
  const response = await app.inject({ method: 'GET', url: `/api/knowledge/${id}` });

  assert.deepEqual({ calls, body: response.json() }, {
    calls: [['read', id]],
    body: { record: fakeRecord() },
  });
});

test('Неизвестный id возвращает именованный 404, а не пустую запись', async (t) => {
  const error = Object.assign(new Error('missing'), { code: 'KNOWLEDGE_NOT_FOUND' });
  const { app } = await fixture(t, { knowledge: { async read() { throw error; } } });
  const response = await app.inject({
    method: 'GET', url: '/api/knowledge/00000000-0000-4000-8000-000000000001',
  });

  assert.deepEqual({ status: response.statusCode, error: response.json().error }, {
    status: 404,
    error: 'not_found',
  });
});

test('Создание принимает только поля записи и возвращает серверную ревизию', async (t) => {
  const { app, calls } = await fixture(t);
  const payload = {
    project: 'alpha', repository: 'backend', kind: 'fact', title: 'Новая',
    body: 'Текст.', tags: ['queue'],
  };
  const response = await app.inject({ method: 'POST', url: '/api/knowledge', payload });

  assert.deepEqual({ calls, status: response.statusCode, revision: response.json().record?.revision }, {
    calls: [['create', payload]],
    status: 201,
    revision: 1,
  });
});

test('Правка передаёт expectedRevision и возвращает authoritative revision', async (t) => {
  const { app, calls } = await fixture(t);
  const id = fakeRecord().id;
  const payload = { title: 'Исправлено', body: 'Текст.', tags: ['queue'], expectedRevision: 3 };
  const response = await app.inject({ method: 'PUT', url: `/api/knowledge/${id}`, payload });

  assert.deepEqual({ calls, revision: response.json().record?.revision }, {
    calls: [['update', id, payload]],
    revision: 4,
  });
});

test('API отклоняет неверную тему до записи, сохраняя экспорт и карты рабочими', async (t) => {
  const { root, storage } = await knowledgeFixture(t);
  const transfer = createKnowledgeTransfer({ rootDir: root, knowledge: storage });
  const { app } = await fixture(t, { knowledge: storage, transfer });
  const created = await app.inject({
    method: 'POST',
    url: '/api/knowledge',
    payload: record({ tags: ['knowledge', 'знания'] }),
  });
  assert.equal(created.statusCode, 201);
  const saved = created.json().record;
  const snapshot = await storage.exportSnapshot();

  for (const tags of [[], [' ', 'knowledge'], ['../outside'], ['знания']]) {
    const responses = [
      await app.inject({
        method: 'POST',
        url: '/api/knowledge',
        payload: record({ tags }),
      }),
      await app.inject({
        method: 'PUT',
        url: `/api/knowledge/${saved.id}`,
        payload: { tags, body: 'Не сохранять.', expectedRevision: saved.revision },
      }),
    ];

    for (const response of responses) {
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error, 'invalid_arguments');
      assert.match(response.json().message, /Первый тег обязателен/);
    }
  }

  assert.deepEqual(await storage.exportSnapshot(), snapshot);
  const backup = await app.inject({ method: 'POST', url: '/api/knowledge/backup/export' });
  const maps = await app.inject({ method: 'POST', url: '/api/knowledge/maps/refresh' });
  assert.equal(backup.statusCode, 200);
  assert.equal(backup.json().records.length, 1);
  assert.equal(maps.statusCode, 200);
  assert.equal(maps.json().mapCount, 1);
});

test('Удаление требует expectedRevision в теле DELETE', async (t) => {
  const { app, calls } = await fixture(t);
  const id = fakeRecord().id;
  const response = await app.inject({
    method: 'DELETE', url: `/api/knowledge/${id}`, payload: { expectedRevision: 3 },
  });

  assert.deepEqual({ calls, body: response.json() }, {
    calls: [['delete', id, { expectedRevision: 3 }]],
    body: { deleted: true, id },
  });
});

test('Конфликт ревизий возвращает 409 и текущую ревизию', async (t) => {
  const error = Object.assign(new Error('stale'), {
    code: 'KNOWLEDGE_CONFLICT', currentRevision: 5,
  });
  const { app } = await fixture(t, { knowledge: { async update() { throw error; } } });
  const response = await app.inject({
    method: 'PUT',
    url: `/api/knowledge/${fakeRecord().id}`,
    payload: { title: 'Черновик', body: 'Текст', tags: [], expectedRevision: 3 },
  });

  assert.deepEqual({ status: response.statusCode, body: response.json() }, {
    status: 409,
    body: {
      error: 'knowledge_conflict',
      message: 'Запись уже изменена в другом окне.',
      currentRevision: 5,
    },
  });
});

test('Недоступность БД возвращает явный безопасный 503 без абсолютного пути', async (t) => {
  const sentinel = '/tmp/private-knowledge-path/knowledge.db';
  const error = Object.assign(new Error(`cannot open ${sentinel}`), {
    code: 'KNOWLEDGE_UNAVAILABLE', reasonCode: 'db_open_failed',
  });
  const { app } = await fixture(t, { knowledge: { async list() { throw error; } } });
  const response = await app.inject({ method: 'GET', url: '/api/knowledge' });

  assert.deepEqual({
    status: response.statusCode,
    error: response.json().error,
    reason: response.json().reason,
    pathLeaked: response.body.includes(sentinel),
  }, {
    status: 503,
    error: 'knowledge_unavailable',
    reason: 'db_open_failed',
    pathLeaked: false,
  });
});

test('Живой тумблер закрывает и возвращает API без перерегистрации', async (t) => {
  const { app, setEnabled } = await fixture(t);
  const before = await app.inject({ method: 'GET', url: '/api/knowledge' });
  setEnabled(false);
  const disabled = await app.inject({ method: 'GET', url: '/api/knowledge' });
  setEnabled(true);
  const after = await app.inject({ method: 'GET', url: '/api/knowledge' });

  assert.deepEqual({
    before: before.statusCode,
    disabled: [disabled.statusCode, disabled.json().error],
    after: after.statusCode,
  }, {
    before: 200,
    disabled: [404, 'plugin_disabled'],
    after: 200,
  });
});

test('Выключенный первый доступ не обращается к хранилищу', async (t) => {
  const { app, calls } = await fixture(t, { enabled: false });
  const response = await app.inject({ method: 'GET', url: '/api/knowledge' });

  assert.deepEqual({ status: response.statusCode, calls }, { status: 404, calls: [] });
});

test('Экспорт отдаёт единый JSON-файл с датированным именем вложения', async (t) => {
  const { app, calls } = await fixture(t);
  const response = await app.inject({
    method: 'POST',
    url: '/api/knowledge/backup/export',
  });

  assert.deepEqual({
    status: response.statusCode,
    contentType: response.headers['content-type'],
    disposition: response.headers['content-disposition'],
    body: response.rawPayload,
    calls,
  }, {
    status: 200,
    contentType: 'application/json; charset=utf-8',
    disposition: `attachment; filename="cockpit-knowledge-${new Date().toISOString().slice(0, 10)}.json"`,
    body: BACKUP_BYTES,
    calls: [['transfer', 'exportKnowledge']],
  });
});

test('Предпросмотр передаёт сервису байты единственного загруженного файла', async (t) => {
  const conflict = {
    id: fakeRecord().id,
    title: fakeRecord().title,
    baseRevision: 3,
    currentRevision: 4,
    changedFields: ['body'],
    incoming: fakeRecord({ body: 'Текст из файла.' }),
    current: fakeRecord({ body: 'Свежая версия базы.', revision: 4 }),
  };
  const expected = {
    snapshotHash: 'snapshot-preview',
    summary: { create: 0, update: 0, unchanged: 0, conflict: 1, targetOnly: 0 },
    conflicts: [conflict],
  };
  const { app, calls } = await fixture(t, { previewResult: expected });
  const response = await app.inject({
    method: 'POST',
    url: '/api/knowledge/backup/import/preview',
    ...multipartBody(),
  });

  assert.deepEqual({
    status: response.statusCode,
    body: response.json(),
    bytes: calls.find((call) => call[1] === 'previewImport')?.[2],
  }, {
    status: 200,
    body: expected,
    bytes: BACKUP_BYTES,
  });
});

test('Apply принимает тот же файл, hash и решения независимо от порядка multipart-частей', async (t) => {
  const input = {
    snapshotHash: 'snapshot-preview',
    resolutions: [{
      id: fakeRecord().id,
      decision: 'keep-current',
      expectedCurrentRevision: 4,
    }],
  };
  const expected = {
    created: 1,
    updated: 2,
    unchanged: 239,
    keptCurrent: 1,
    overwritten: 0,
    targetOnly: 3,
    total: 246,
  };
  const { app, calls } = await fixture(t, { applyResult: expected });
  const response = await app.inject({
    method: 'POST',
    url: '/api/knowledge/backup/import/apply',
    ...multipartBody({
      fileFirst: true,
      fields: {
        snapshotHash: input.snapshotHash,
        resolutions: JSON.stringify(input.resolutions),
      },
    }),
  });

  assert.deepEqual({
    status: response.statusCode,
    body: response.json(),
    transferArgs: calls.find((call) => call[1] === 'applyImport')?.slice(2),
  }, {
    status: 200,
    body: expected,
    transferArgs: [BACKUP_BYTES, input],
  });
});

test('Устаревший apply отвечает 409 и сохраняет новый предпросмотр', async (t) => {
  const preview = {
    snapshotHash: 'snapshot-new',
    summary: { create: 0, update: 0, unchanged: 0, conflict: 1, targetOnly: 0 },
    conflicts: [],
  };
  const error = Object.assign(new Error('changed backup'), {
    code: 'KNOWLEDGE_IMPORT_STALE',
    preview,
  });
  const transfer = {
    async applyImport() {
      throw error;
    },
  };
  const { app } = await fixture(t, { transfer });
  const response = await app.inject({
    method: 'POST',
    url: '/api/knowledge/backup/import/apply',
    ...multipartBody({
      fields: { snapshotHash: 'snapshot-old', resolutions: '[]' },
    }),
  });

  assert.deepEqual({ status: response.statusCode, body: response.json() }, {
    status: 409,
    body: {
      error: 'knowledge_import_stale',
      message: 'Экспорт или база изменились. Проверьте новый план импорта.',
      preview,
    },
  });
});

test('Отсутствующий и повторный файл импорта отклоняются до вызова transfer', async (t) => {
  const { app, calls } = await fixture(t);
  const missing = await app.inject({
    method: 'POST',
    url: '/api/knowledge/backup/import/preview',
    ...multipartBody({ files: [] }),
  });
  const duplicate = await app.inject({
    method: 'POST',
    url: '/api/knowledge/backup/import/preview',
    ...multipartBody({ files: [BACKUP_BYTES, BACKUP_BYTES] }),
  });

  assert.deepEqual({
    statuses: [missing.statusCode, duplicate.statusCode],
    transferCalls: calls.filter((call) => call[0] === 'transfer'),
  }, {
    statuses: [400, 400],
    transferCalls: [],
  });
});

test('Файл импорта больше 64 МиБ отклоняется кодом 413', async (t) => {
  const { app, calls } = await fixture(t);
  const response = await app.inject({
    method: 'POST',
    url: '/api/knowledge/backup/import/preview',
    ...multipartBody({ files: [Buffer.alloc(64 * 1024 ** 2 + 1, 0x61)] }),
  });

  assert.deepEqual({
    status: response.statusCode,
    transferCalls: calls.filter((call) => call[0] === 'transfer'),
  }, {
    status: 413,
    transferCalls: [],
  });
});

test('Обновление карт вызывает только отдельную человеческую операцию', async (t) => {
  const expected = {
    recordCount: 243,
    mapCount: 14,
    mapBytes: 30400,
    totalContextBytes: 48100,
  };
  const { app, calls } = await fixture(t, { mapsResult: expected });
  const response = await app.inject({ method: 'POST', url: '/api/knowledge/maps/refresh' });

  assert.deepEqual({ status: response.statusCode, body: response.json(), calls }, {
    status: 200,
    body: expected,
    calls: [['transfer', 'updateMaps']],
  });
});

test('Legacy transfer-адреса удалены и не вызывают сервис переноса', async (t) => {
  const { app, calls } = await fixture(t);
  const urls = [
    '/api/knowledge/export',
    '/api/knowledge/import/preview',
    '/api/knowledge/import/apply',
  ];
  const responses = await Promise.all(urls.map((url) => app.inject({ method: 'POST', url })));

  assert.deepEqual({
    statuses: responses.map((response) => response.statusCode),
    transferCalls: calls.filter((call) => call[0] === 'transfer'),
  }, {
    statuses: [404, 404, 404],
    transferCalls: [],
  });
});

test('Выключенный плагин не запускает новые human-only операции', async (t) => {
  const { app, calls } = await fixture(t, { enabled: false });

  const response = await app.inject({ method: 'POST', url: '/api/knowledge/backup/export' });

  assert.deepEqual({ status: response.statusCode, error: response.json().error, calls }, {
    status: 404,
    error: 'plugin_disabled',
    calls: [],
  });
});
