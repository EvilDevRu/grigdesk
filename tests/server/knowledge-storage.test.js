import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  knowledgeFixture,
  knowledgeStorageFactory,
  record,
} from './helpers/knowledge.js';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);

function runNode(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('Путь базы из окружения попадает в серверную конфигурацию без преобразования', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-knowledge-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = path.join(root, 'knowledge.db');
  const moduleUrl = new URL('../../server/src/config.js', import.meta.url).href;
  const script = `import { config } from ${JSON.stringify(moduleUrl)};`
    + " process.stdout.write(config.knowledgeDbPath || '');";
  const result = await runNode([
    '--input-type=module',
    '-e',
    script,
  ], { COCKPIT_KNOWLEDGE_DB_PATH: dbPath });

  assert.deepEqual({ code: result.code, value: result.stdout, stderr: result.stderr }, {
    code: 0,
    value: dbPath,
    stderr: '',
  });
});

test('Путь базы по умолчанию находится вне рабочего дерева в приватном namespace', async () => {
  const moduleUrl = new URL('../../server/src/config.js', import.meta.url).href;
  const script = `import { config } from ${JSON.stringify(moduleUrl)};`
    + " process.stdout.write(config.knowledgeDbPath || '');";
  const result = await runNode([
    '--input-type=module',
    '-e',
    script,
  ], { COCKPIT_KNOWLEDGE_DB_PATH: '' });
  const expected = path.join(os.homedir(), '.config', 'cockpit', 'knowledge', 'knowledge.db');

  assert.deepEqual({
    code: result.code,
    path: result.stdout,
    insideCheckout: result.stdout.startsWith(ROOT),
  }, {
    code: 0,
    path: expected,
    insideCheckout: false,
  });
});

test('Ленивый клиент не создаёт файл до первого содержательного обращения', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-knowledge-lazy-'));
  const dbPath = path.join(root, 'state', 'knowledge.db');
  t.after(() => rm(root, { recursive: true, force: true }));
  let clientModule;
  try {
    clientModule = await import('../../server/src/lib/search/client.js');
  } catch (error) {
    assert.fail(`Ленивый клиент знаний ещё не реализован: ${error.message}`);
  }
  const create = clientModule.createKnowledgeClient || clientModule.default;
  const client = await create({ dbPath, seedSamples: false });
  const before = await access(dbPath).then(() => true).catch(() => false);
  await client.list({});
  const after = await access(dbPath).then(() => true).catch(() => false);
  await client.close?.();

  assert.deepEqual({ before, after }, { before: false, after: true });
});

test('Первое обращение создаёт приватный каталог 0700 и обычный файл базы 0600', async (t) => {
  const { dbPath } = await knowledgeFixture(t);
  const parentStat = await stat(path.dirname(dbPath));
  const dbStat = await stat(dbPath);

  assert.deepEqual({
    parentMode: parentStat.mode & 0o777,
    dbMode: dbStat.mode & 0o777,
    regular: dbStat.isFile(),
  }, {
    parentMode: 0o700,
    dbMode: 0o600,
    regular: true,
  });
});

test('Read-only storage читает без chmod и явно запрещает мутации', async (t) => {
  const { dbPath, storage } = await knowledgeFixture(t);
  const created = await storage.create(record({ body: 'Факт для безопасного чтения.' }));
  await storage.close?.();
  await chmod(dbPath, 0o440);

  const readOnly = await knowledgeStorageFactory()({
    dbPath,
    seedSamples: false,
    readOnly: true,
  });
  const found = await readOnly.read(created.id);
  await assert.rejects(
    readOnly.create(record()),
    (error) => error?.code === 'KNOWLEDGE_UNAVAILABLE' && error?.reasonCode === 'read_only',
  );
  await readOnly.close?.();

  assert.deepEqual({ body: found.body, mode: (await stat(dbPath)).mode & 0o777 }, {
    body: 'Факт для безопасного чтения.',
    mode: 0o440,
  });
});

test('Созданная запись получает UUID, серверное время и начальную ревизию', async (t) => {
  const { storage } = await knowledgeFixture(t);
  const created = await storage.create(record());

  assert.deepEqual({
    uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(created.id),
    updatedAt: Number.isFinite(Date.parse(created.updatedAt)),
    revision: created.revision,
  }, {
    uuid: true,
    updatedAt: true,
    revision: 1,
  });
});

const INVALID_RECORD_TAGS = [
  undefined,
  null,
  'knowledge',
  [],
  [''],
  [' ', 'knowledge'],
  ['../outside'],
  ['/outside'],
  ['topic/child'],
  ['Тема'],
  ['Topic'],
  ['topic_name'],
  ['-topic'],
  ['topic-'],
  [42],
];

test('Создание без безопасной первой темы отклоняется до изменения базы и индекса', async (t) => {
  const { storage } = await knowledgeFixture(t);
  await storage.create(record({ body: 'Сохранённый факт.' }));
  const before = await storage.exportSnapshot();

  for (const tags of INVALID_RECORD_TAGS) {
    await assert.rejects(
      storage.create(record({ tags, body: 'Недопустимыйуникальныймаркер' })),
      (error) => error?.code === 'KNOWLEDGE_INVALID_ARGUMENTS',
      `Недопустимые теги: ${JSON.stringify(tags)}`,
    );
  }

  assert.deepEqual(await storage.exportSnapshot(), before);
  assert.deepEqual(await storage.search({ query: 'Недопустимыйуникальныймаркер' }), { items: [] });
});

test('Недопустимая первая тема не меняет ревизию, тело, теги и индекс при правке', async (t) => {
  const { storage } = await knowledgeFixture(t);
  const created = await storage.create(record({ body: 'Сохранённыйуникальныймаркер' }));

  for (const tags of INVALID_RECORD_TAGS) {
    await assert.rejects(
      storage.update(created.id, {
        tags,
        body: 'Недопустимыйуникальныймаркер',
        expectedRevision: created.revision,
      }),
      (error) => error?.code === 'KNOWLEDGE_INVALID_ARGUMENTS',
      `Недопустимые теги: ${JSON.stringify(tags)}`,
    );
  }

  assert.deepEqual(await storage.read(created.id), created);
  assert.deepEqual(await storage.search({ query: 'Недопустимыйуникальныймаркер' }), { items: [] });
  assert.equal((await storage.search({ query: 'Сохранённыйуникальныймаркер' })).items[0]?.id, created.id);
});

test('Тема нормализуется, а правка без поля tags сохраняет её и русские теги', async (t) => {
  const { storage } = await knowledgeFixture(t);
  const created = await storage.create(record({ tags: [' ｒｅｌｅａｓｅ-2 ', 'сборка', 'сборка'] }));
  const updated = await storage.update(created.id, {
    body: 'Уточнённый факт.',
    expectedRevision: created.revision,
  });

  assert.deepEqual(updated.tags, ['release-2', 'сборка']);
  assert.equal(updated.revision, 2);
});

test('Существующая база схемы v1 открывается с записью и мигрирует marker на v2', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-knowledge-v1-'));
  const dbPath = path.join(root, 'knowledge.db');
  t.after(() => rm(root, { recursive: true, force: true }));
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE records (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      repository TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 1)
    );
    CREATE TABLE record_tags (
      record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      position INTEGER NOT NULL,
      PRIMARY KEY (record_id, tag)
    );
  `);
  legacy.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('schema_version', '1');
  legacy.prepare(`
    INSERT INTO records(id, project, repository, kind, title, body, updated_at, revision)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    '00000000-0000-4000-8000-000000000031',
    'cockpit-test',
    'main',
    'fact',
    'Запись старой схемы',
    'Тело должно пережить миграцию.',
    '2026-08-30T00:00:00.000Z',
    4,
  );
  legacy.prepare('INSERT INTO record_tags(record_id, tag, position) VALUES (?, ?, ?)').run(
    '00000000-0000-4000-8000-000000000031',
    'knowledge',
    0,
  );
  legacy.close();

  const storage = await knowledgeStorageFactory()({ dbPath, seedSamples: false });
  const restored = await storage.read('00000000-0000-4000-8000-000000000031');
  await storage.close?.();
  const migrated = new DatabaseSync(dbPath, { readOnly: true });
  const marker = migrated.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value;
  const columns = migrated.prepare('PRAGMA table_info(records)').all().map((row) => row.name);
  migrated.close();

  assert.deepEqual({ marker, provenanceColumn: columns.includes('provenance'), restored }, {
    marker: '2',
    provenanceColumn: true,
    restored: {
      id: '00000000-0000-4000-8000-000000000031',
      project: 'cockpit-test',
      repository: 'main',
      kind: 'fact',
      title: 'Запись старой схемы',
      body: 'Тело должно пережить миграцию.',
      tags: ['knowledge'],
      updatedAt: '2026-08-30T00:00:00.000Z',
      revision: 4,
      provenance: null,
    },
  });
});

test('Запись возвращает закрытое происхождение исполнителя без runtime identifiers', async (t) => {
  const { storage } = await knowledgeFixture(t);
  const created = await storage.create(record({
    provenance: {
      actor: 'executor',
      channel: 'pipeline',
      ref: 'tests_red',
    },
  }));

  assert.deepEqual(created.provenance, {
    actor: 'executor',
    channel: 'pipeline',
    ref: 'tests_red',
  });
});

test('Хранилище отвергает runtime identifier внутри происхождения', async (t) => {
  const { storage } = await knowledgeFixture(t);

  await assert.rejects(
    storage.create(record({
      provenance: {
        actor: 'executor',
        channel: 'pipeline',
        ref: 'tests_red',
        runId: 'runtime-secret',
      },
    })),
    (error) => error?.code === 'KNOWLEDGE_INVALID_ARGUMENTS',
  );
});

test('Обычная правка без происхождения сохраняет прежнего исполнителя', async (t) => {
  const { storage } = await knowledgeFixture(t);
  const provenance = { actor: 'executor', channel: 'chat', ref: 'chat-42' };
  const created = await storage.create(record({ provenance }));
  const updated = await storage.update(created.id, {
    ...record({ body: 'Исправленный факт.' }),
    expectedRevision: created.revision,
  });

  assert.deepEqual(updated.provenance, provenance);
});

test('SQLite содержит записи, точные теги, FTS-индекс и marker схемы', async (t) => {
  const { dbPath, storage } = await knowledgeFixture(t);
  await storage.create(record());
  await storage.close?.();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const names = db.prepare(
    "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name",
  ).all().map((row) => row.name);
  db.close();

  assert.deepEqual(
    ['meta', 'records', 'record_tags'].map((name) => names.includes(name)).concat([
      names.some((name) => /fts/i.test(name)),
    ]),
    [true, true, true, true],
  );
});

test('SQLite использует переносимый DELETE journal и внешний ключ тегов', async (t) => {
  const { dbPath, storage } = await knowledgeFixture(t);
  await storage.close?.();
  const db = new DatabaseSync(dbPath);
  const values = {
    journal: db.prepare('PRAGMA journal_mode').get().journal_mode,
    tagForeignKeys: db.prepare('PRAGMA foreign_key_list(record_tags)').all().length,
  };
  db.close();

  assert.deepEqual({
    journal: String(values.journal).toLowerCase(),
    tagForeignKeyConfigured: values.tagForeignKeys > 0,
  }, {
    journal: 'delete',
    tagForeignKeyConfigured: true,
  });
});

test('Чтение по id возвращает полный исходный текст и точные теги', async (t) => {
  const { storage } = await knowledgeFixture(t);
  const input = record({
    body: 'Полный текст без сокращения.',
    tags: ['architecture', 'архитектура', 'API'],
  });
  const created = await storage.create(input);
  const found = await storage.read(created.id);

  assert.deepEqual({ body: found.body, tags: found.tags }, {
    body: input.body,
    tags: input.tags,
  });
});

test('Правка по актуальной ревизии увеличивает её ровно на единицу', async (t) => {
  const { storage } = await knowledgeFixture(t);
  const created = await storage.create(record());
  const updated = await storage.update(created.id, {
    ...record({ title: 'Новый заголовок' }),
    expectedRevision: created.revision,
  });

  assert.deepEqual({ title: updated.title, revision: updated.revision }, {
    title: 'Новый заголовок',
    revision: 2,
  });
});

test('Удаление по актуальной ревизии делает отдельное чтение пустым', async (t) => {
  const { storage } = await knowledgeFixture(t);
  const created = await storage.create(record());
  await storage.delete(created.id, { expectedRevision: created.revision });

  assert.equal(await storage.read(created.id), null);
});

test('Две одновременные правки одной ревизии дают одного победителя и один конфликт', async (t) => {
  const { storage } = await knowledgeFixture(t);
  const created = await storage.create(record());
  const attempts = await Promise.allSettled([
    storage.update(created.id, {
      ...record({ body: 'Правка из первой вкладки.' }),
      expectedRevision: created.revision,
    }),
    storage.update(created.id, {
      ...record({ body: 'Правка из второй вкладки.' }),
      expectedRevision: created.revision,
    }),
  ]);

  assert.deepEqual({
    fulfilled: attempts.filter((item) => item.status === 'fulfilled').length,
    conflicts: attempts.filter((item) => (
      item.status === 'rejected' && item.reason?.code === 'KNOWLEDGE_CONFLICT'
    )).length,
  }, {
    fulfilled: 1,
    conflicts: 1,
  });
});

test('Отклонённая CAS-правка атомарно сохраняет прежнее тело и теги', async (t) => {
  const { storage } = await knowledgeFixture(t);
  const created = await storage.create(record({ body: 'Исходное тело.', tags: ['original', 'исходное'] }));
  await assert.rejects(storage.update(created.id, {
    ...record({ body: 'Не должно сохраниться.', tags: ['invalid', 'битое'] }),
    expectedRevision: created.revision + 10,
  }));
  const after = await storage.read(created.id);

  assert.deepEqual({ body: after.body, tags: after.tags, revision: after.revision }, {
    body: 'Исходное тело.',
    tags: ['original', 'исходное'],
    revision: 1,
  });
});

test('Каталог на месте файла базы даёт именованную недоступность, а не пустой список', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-knowledge-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = path.join(root, 'knowledge.db');
  await mkdir(dbPath);
  const factory = knowledgeStorageFactory();

  await assert.rejects(
    factory({ dbPath, seedSamples: false }),
    (error) => error?.code === 'KNOWLEDGE_UNAVAILABLE' && Boolean(error?.reasonCode),
  );
});

test('Симлинк на месте файла базы отклоняется именованной недоступностью', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-knowledge-symlink-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'target.db');
  const dbPath = path.join(root, 'knowledge.db');
  await mkdir(target);
  await symlink(target, dbPath);
  const factory = knowledgeStorageFactory();

  await assert.rejects(
    factory({ dbPath, seedSamples: false }),
    (error) => error?.code === 'KNOWLEDGE_UNAVAILABLE' && Boolean(error?.reasonCode),
  );
});

test('Пробные записи сеются один раз и не воскресают после ручного удаления', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-knowledge-seed-'));
  const dbPath = path.join(root, 'knowledge.db');
  const factory = knowledgeStorageFactory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await factory({ dbPath, seedSamples: true });
  const seeded = await first.list({});
  const sample = seeded.items[0];
  await first.delete(sample.id, { expectedRevision: sample.revision });
  await first.close?.();
  const second = await factory({ dbPath, seedSamples: true });
  const reopened = await second.list({});
  await second.close?.();

  assert.deepEqual({
    atLeastThree: seeded.items.length >= 3,
    bodySizesValid: seeded.items.slice(0, 3).every((item) => (
      Buffer.byteLength(item.body, 'utf8') >= 1024 && Buffer.byteLength(item.body, 'utf8') <= 5120
    )),
    deletedStayedDeleted: !reopened.items.some((item) => item.id === sample.id),
  }, {
    atLeastThree: true,
    bodySizesValid: true,
    deletedStayedDeleted: true,
  });
});

function importedRecord(overrides = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000011',
    project: 'cockpit-test',
    repository: 'main',
    kind: 'decision',
    title: 'Точный снимок записи',
    body: '\nТело с начальным и конечным переводом строки.\n',
    tags: ['knowledge', 'перенос', 'третий тег'],
    updatedAt: '2026-08-28T10:20:30.000Z',
    revision: 7,
    ...overrides,
  };
}

function requireStorageMethod(storage, name, message) {
  assert.equal(typeof storage[name], 'function', message);
}

function snapshotRecords(snapshot) {
  return Array.isArray(snapshot) ? snapshot : snapshot.records;
}

test('Экспорт возвращает все поля всех записей в UUID-порядке', async (t) => {
  const { storage } = await knowledgeFixture(t);
  const first = await storage.create(record({ title: 'Бета', tags: ['knowledge', 'beta'] }));
  const second = await storage.create(record({ title: 'Альфа', tags: ['knowledge', 'alpha'] }));
  requireStorageMethod(storage, 'exportSnapshot', 'хранилище обязано экспортировать снимок');

  const snapshot = snapshotRecords(await storage.exportSnapshot());

  assert.deepEqual(snapshot, [first, second].sort((left, right) => left.id.localeCompare(right.id)));
});

test('Импорт в пустую базу восстанавливает UUID, время, ревизию и порядок тегов', async (t) => {
  const { storage } = await knowledgeFixture(t);
  requireStorageMethod(storage, 'applyImport', 'хранилище обязано атомарно применять импорт');
  const expected = importedRecord();

  await storage.applyImport([expected], []);
  const restored = await storage.read(expected.id);

  assert.deepEqual(restored, { ...expected, provenance: null });
});

test('Повторный импорт того же снимка не меняет запись и её ревизию', async (t) => {
  const { storage } = await knowledgeFixture(t);
  requireStorageMethod(storage, 'applyImport', 'хранилище обязано атомарно применять импорт');
  const expected = importedRecord();
  await storage.applyImport([expected], []);

  await storage.applyImport([expected], []);
  const after = snapshotRecords(await storage.exportSnapshot());

  assert.deepEqual(after, [{ ...expected, provenance: null }]);
});

test('Импорт не удаляет запись, которой нет в снимке', async (t) => {
  const { storage } = await knowledgeFixture(t);
  const targetOnly = await storage.create(record({ title: 'Локальная запись' }));
  requireStorageMethod(storage, 'applyImport', 'хранилище обязано атомарно применять импорт');
  const expected = importedRecord();

  await storage.applyImport([expected], []);
  const after = snapshotRecords(await storage.exportSnapshot());

  assert.equal(after.some((item) => item.id === targetOnly.id), true);
});

test('Правка базы после экспорта становится конфликтом с обеими версиями', async (t) => {
  const { storage } = await knowledgeFixture(t);
  requireStorageMethod(storage, 'applyImport', 'хранилище обязано атомарно применять импорт');
  const exported = importedRecord({ revision: 1 });
  await storage.applyImport([exported], []);
  await storage.update(exported.id, {
    ...exported,
    body: 'Более свежая правка в базе.',
    expectedRevision: 1,
  });
  const incoming = { ...exported, body: 'Правка экспортированного файла.' };
  requireStorageMethod(storage, 'previewImport', 'хранилище обязано строить план импорта');

  const preview = await storage.previewImport([incoming]);

  assert.deepEqual(preview.conflicts.map((item) => ({
    id: item.id,
    baseRevision: item.baseRevision,
    currentRevision: item.currentRevision,
    incomingBody: item.incoming.body,
    currentBody: item.current.body,
  })), [{
    id: exported.id,
    baseRevision: 1,
    currentRevision: 2,
    incomingBody: 'Правка экспортированного файла.',
    currentBody: 'Более свежая правка в базе.',
  }]);
});

test('Неразрешённый конфликт отклоняет весь импорт без частичных записей', async (t) => {
  const { storage } = await knowledgeFixture(t);
  requireStorageMethod(storage, 'applyImport', 'хранилище обязано атомарно применять импорт');
  const conflicted = importedRecord({ revision: 1 });
  await storage.applyImport([conflicted], []);
  await storage.update(conflicted.id, {
    ...conflicted,
    body: 'Свежая версия базы.',
    expectedRevision: 1,
  });
  const fresh = importedRecord({
    id: '00000000-0000-4000-8000-000000000012',
    title: 'Не должна примениться частично',
  });

  await assert.rejects(
    storage.applyImport([{ ...conflicted, body: 'Версия файла.' }, fresh], []),
    (error) => error?.code === 'KNOWLEDGE_IMPORT_STALE',
  );
  const after = snapshotRecords(await storage.exportSnapshot());

  assert.equal(after.some((item) => item.id === fresh.id), false);
});

test('Решение оставить базу сохраняет свежую версию конфликтной записи', async (t) => {
  const { storage } = await knowledgeFixture(t);
  requireStorageMethod(storage, 'applyImport', 'хранилище обязано атомарно применять импорт');
  const exported = importedRecord({ revision: 1, body: 'Исходная версия.' });
  await storage.applyImport([exported], []);
  await storage.update(exported.id, {
    ...exported,
    body: 'Свежая версия базы.',
    expectedRevision: 1,
  });

  await storage.applyImport([{ ...exported, body: 'Версия файла.' }], [{
    id: exported.id,
    decision: 'keep-current',
    expectedCurrentRevision: 2,
  }]);
  const after = await storage.read(exported.id);

  assert.deepEqual({ body: after.body, revision: after.revision }, {
    body: 'Свежая версия базы.',
    revision: 2,
  });
});

test('Решение взять файл заменяет конфликтную запись и поднимает ревизию', async (t) => {
  const { storage } = await knowledgeFixture(t);
  requireStorageMethod(storage, 'applyImport', 'хранилище обязано атомарно применять импорт');
  const exported = importedRecord({ revision: 1, body: 'Исходная версия.' });
  await storage.applyImport([exported], []);
  await storage.update(exported.id, {
    ...exported,
    body: 'Свежая версия базы.',
    expectedRevision: 1,
  });

  await storage.applyImport([{ ...exported, body: 'Версия файла.' }], [{
    id: exported.id,
    decision: 'use-import',
    expectedCurrentRevision: 2,
  }]);
  const after = await storage.read(exported.id);

  assert.deepEqual({ body: after.body, revision: after.revision }, {
    body: 'Версия файла.',
    revision: 3,
  });
});

test('Хранилище без явного seedSamples открывается без пробных записей', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-knowledge-no-seed-'));
  const dbPath = path.join(root, 'knowledge.db');
  const factory = knowledgeStorageFactory();
  t.after(() => rm(root, { recursive: true, force: true }));

  const storage = await factory({ dbPath });
  t.after(() => storage.close?.());
  const result = await storage.list({});

  assert.equal(result.items.length, 0);
});
