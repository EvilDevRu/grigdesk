import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  access, chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { knowledgeStorageFactory, record } from './helpers/knowledge.js';
import { runKnowledgeCli } from '../../server/src/lib/search/cli.ts';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const KNOWLEDGE_BIN = path.join(ROOT, 'bin', 'knowledge');

function run(file, args, { cwd, dbPath }) {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd,
      env: {
        ...process.env,
        COCKPIT_KNOWLEDGE_DB_PATH: dbPath,
        COCKPIT_URL: 'http://127.0.0.1:1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => resolve({ code: null, stdout, stderr: String(error.message) }));
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function cliFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-knowledge-cli-'));
  const dbPath = path.join(root, 'state', 'knowledge.db');
  const cwd = path.join(root, 'foreign-worktree');
  const linkDir = path.join(root, 'bin');
  const link = path.join(linkDir, 'knowledge');
  await mkdir(cwd, { recursive: true });
  await mkdir(linkDir, { recursive: true });
  await symlink(KNOWLEDGE_BIN, link);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, dbPath, cwd, link };
}

async function runnerFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-knowledge-cli-runner-'));
  const rootDir = path.join(root, 'repository');
  const dbPath = path.join(root, 'state', 'knowledge.db');
  await mkdir(path.join(rootDir, 'docs/cockpit'), { recursive: true });
  await writeFile(path.join(rootDir, 'CLAUDE.md'), '# Временный репозиторий\n');
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, rootDir, dbPath };
}

async function invokeRunner(args, fixture, env = {}) {
  let stdout = '';
  let stderr = '';
  const code = await runKnowledgeCli(args, {
    dbPath: fixture.dbPath,
    rootDir: fixture.rootDir,
    mapsRootFor: () => fixture.rootDir,
    env,
    preflight: async () => ({ ok: true }),
    io: {
      stdout: { write(value) { stdout += String(value); } },
      stderr: { write(value) { stderr += String(value); } },
    },
  });
  return { code, stdout, stderr };
}

async function seed(t) {
  const fixture = await cliFixture(t);
  const factory = knowledgeStorageFactory();
  const storage = await factory({ dbPath: fixture.dbPath, seedSamples: false });
  const created = await storage.create(record({
    project: 'alpha',
    repository: 'backend',
    title: 'Деплой очереди',
    body: 'Полная инструкция деплоя очереди без сокращений.',
    tags: ['queue', 'release'],
  }));
  await storage.close?.();
  return { ...fixture, created };
}

test('CLI через симлинк ищет из чужого рабочего дерева без сервера', async (t) => {
  const { dbPath, cwd, link, created } = await seed(t);
  const result = await run(link, [
    'search', 'деплой', '--project', 'alpha', '--repository', 'backend', '--tag', 'queue',
  ], { cwd, dbPath });
  const body = result.code === 0 ? JSON.parse(result.stdout) : null;

  assert.deepEqual({
    code: result.code,
    ids: body?.items?.map((item) => item.id),
    stderr: result.stderr,
  }, {
    code: 0,
    ids: [created.id],
    stderr: '',
  });
});

test('CLI search открывает существующую базу только для чтения и не меняет её режим', async (t) => {
  const { dbPath, cwd, link, created } = await seed(t);
  await chmod(dbPath, 0o440);

  const result = await run(link, ['search', 'деплой'], { cwd, dbPath });
  const mode = (await stat(dbPath)).mode & 0o777;

  assert.deepEqual({
    code: result.code,
    ids: result.code === 0 ? JSON.parse(result.stdout).items.map((item) => item.id) : [],
    mode,
    stderr: result.stderr,
  }, {
    code: 0,
    ids: [created.id],
    mode: 0o440,
    stderr: '',
  });
});

test('CLI read возвращает полную запись отдельной командой', async (t) => {
  const { dbPath, cwd, link, created } = await seed(t);
  const result = await run(link, ['read', created.id], { cwd, dbPath });
  const body = result.code === 0 ? JSON.parse(result.stdout) : null;

  assert.deepEqual({ code: result.code, id: body?.record?.id, body: body?.record?.body }, {
    code: 0,
    id: created.id,
    body: 'Полная инструкция деплоя очереди без сокращений.',
  });
});

test('Usage без аргументов перечисляет search, read и write', async (t) => {
  const fixture = await runnerFixture(t);
  const result = await invokeRunner([], fixture);

  assert.deepEqual({
    code: result.code,
    commands: ['search', 'read', 'write'].filter((command) => result.stderr.includes(command)),
  }, {
    code: 64,
    commands: ['search', 'read', 'write'],
  });
});

test('CLI write создаёт запись и публикует её UUID в карте новой темы', async (t) => {
  const fixture = await runnerFixture(t);
  const canary = '# Соседняя карта\n\nне менять\n';
  await writeFile(path.join(fixture.rootDir, 'docs/cockpit/unrelated.md'), canary);
  const result = await invokeRunner([
    'write',
    '--project', 'alpha',
    '--repository', 'main',
    '--kind', 'fact',
    '--title', 'Новая проверяемая запись',
    '--body', 'Тело новой записи.',
    '--tag', 'new-topic',
    '--tag', 'release',
  ], fixture, { FACTORY_LIFECYCLE_NODE_ID: 'tests_red' });
  const payload = result.code === 0 ? JSON.parse(result.stdout) : null;
  const map = payload?.record?.id
    ? await readFile(path.join(fixture.rootDir, 'docs/cockpit/new-topic.md'), 'utf8').catch(() => '')
    : '';
  const mapRow = map.split('\n').find((line) => line.includes(payload?.record?.id || '__missing__')) || '';

  assert.deepEqual({
    code: result.code,
    stderr: result.stderr,
    project: payload?.record?.project,
    provenance: payload?.record?.provenance,
    mapHasUuid: map.includes(payload?.record?.id || '__missing__'),
    smokeRowFitsReserve: Buffer.byteLength(mapRow, 'utf8') <= 512,
    neighbor: await readFile(path.join(fixture.rootDir, 'docs/cockpit/unrelated.md'), 'utf8'),
  }, {
    code: 0,
    stderr: '',
    project: 'alpha',
    provenance: { actor: 'executor', channel: 'pipeline', ref: 'tests_red' },
    mapHasUuid: true,
    smokeRowFitsReserve: true,
    neighbor: canary,
  });
});

test('CLI write с устаревшей ревизией сообщает конфликт и не затирает запись', async (t) => {
  const fixture = await runnerFixture(t);
  const factory = knowledgeStorageFactory();
  const storage = await factory({ dbPath: fixture.dbPath, seedSamples: false });
  const created = await storage.create(record({
    project: 'alpha',
    body: 'Исходный факт.',
    tags: ['knowledge'],
  }));
  await storage.close?.();

  const result = await invokeRunner([
    'write', created.id,
    '--expected-revision', String(created.revision + 1),
    '--repository', 'main',
    '--kind', 'fact',
    '--title', 'Конфликтующая правка',
    '--body', 'Это тело не должно сохраниться.',
    '--tag', 'knowledge',
  ], fixture);
  const reopened = await factory({ dbPath: fixture.dbPath, seedSamples: false });
  const after = await reopened.read(created.id);
  await reopened.close?.();

  assert.deepEqual({
    code: result.code,
    conflict: /knowledge_conflict/iu.test(result.stderr),
    currentRevision: result.stderr.includes(String(created.revision)),
    body: after.body,
    revision: after.revision,
  }, {
    code: 2,
    conflict: true,
    currentRevision: true,
    body: 'Исходный факт.',
    revision: created.revision,
  });
});

test('CLI отвергает подкоманду delete как недоступную исполнителю', async (t) => {
  const fixture = await runnerFixture(t);
  const result = await invokeRunner([
    'delete', '00000000-0000-4000-8000-000000000001', '--expected-revision', '1',
  ], fixture);

  assert.equal(result.code, 64);
});

test('CLI сообщает committed-запись при отказе пересборки карты', async (t) => {
  const fixture = await runnerFixture(t);
  await mkdir(path.join(fixture.rootDir, 'docs/cockpit/blocked-topic.md'));
  const result = await invokeRunner([
    'write',
    '--project', 'alpha',
    '--repository', 'main',
    '--kind', 'fact',
    '--title', 'Запись с недоступной картой',
    '--body', 'База успевает принять эту запись.',
    '--tag', 'blocked-topic',
  ], fixture);
  const storage = await knowledgeStorageFactory()({ dbPath: fixture.dbPath, seedSamples: false });
  const stored = await storage.list({ project: 'alpha' });
  await storage.close?.();

  assert.deepEqual({
    code: result.code,
    mapFailure: /maps_refresh_failed/iu.test(result.stderr),
    committed: /committed[^\n]{0,40}true/iu.test(result.stderr),
    safeIdentity: /"id"\s*:\s*"[0-9a-f-]+"/iu.test(result.stderr)
      && /"revision"\s*:\s*1/iu.test(result.stderr),
    stored: stored.items.length,
  }, {
    code: 2,
    mapFailure: true,
    committed: true,
    safeIdentity: true,
    stored: 1,
  });
});

test('CLI проходит полный цикл search, read, write и повторный read', async (t) => {
  const fixture = await runnerFixture(t);
  const created = await invokeRunner([
    'write',
    '--project', 'alpha',
    '--repository', 'main',
    '--kind', 'fact',
    '--title', 'Уникальная очередь',
    '--body', 'Первоначальный проверяемый факт.',
    '--tag', 'knowledge',
  ], fixture);
  if (created.code !== 0) {
    throw new Error(`CLI write недоступен: code=${created.code}, stderr=${created.stderr}`);
  }
  const first = JSON.parse(created.stdout).record;
  const mapPath = path.join(fixture.rootDir, 'docs/cockpit/knowledge.md');
  const mapBeforeUpdate = await readFile(mapPath, 'utf8');
  const searched = await invokeRunner(['search', 'очередь', '--project', 'alpha'], fixture);
  const readBefore = await invokeRunner(['read', first.id], fixture);
  const updated = await invokeRunner([
    'write', first.id,
    '--expected-revision', String(first.revision),
    '--repository', first.repository,
    '--kind', first.kind,
    '--title', first.title,
    '--body', 'Исправленный проверяемый факт.',
    '--tag', 'knowledge',
  ], fixture);
  const readAfter = await invokeRunner(['read', first.id], fixture);
  const mapAfterUpdate = await readFile(mapPath, 'utf8');
  const beforeRecord = readBefore.code === 0 ? JSON.parse(readBefore.stdout).record : null;
  const updatedRecord = updated.code === 0 ? JSON.parse(updated.stdout).record : null;
  const afterRecord = readAfter.code === 0 ? JSON.parse(readAfter.stdout).record : null;

  const renamed = await invokeRunner([
    'write', first.id,
    '--expected-revision', String(afterRecord?.revision),
    '--repository', first.repository,
    '--kind', first.kind,
    '--title', 'Переименованная очередь',
    '--body', 'Исправленный проверяемый факт.',
    '--tag', 'knowledge',
  ], fixture);
  const mapAfterRename = await readFile(mapPath, 'utf8');

  assert.deepEqual({
    searchedIds: searched.code === 0
      ? JSON.parse(searched.stdout).items.map((item) => item.id)
      : [],
    beforeBody: beforeRecord?.body,
    updatedId: updatedRecord?.id,
    afterBody: afterRecord?.body,
    revisionDelta: afterRecord?.revision - beforeRecord?.revision,
    mapKeepsBodyEdit: mapAfterUpdate === mapBeforeUpdate,
    renamedCode: renamed.code,
    mapTakesNewTitle: mapAfterRename.includes('Переименованная очередь'),
    mapDropsOldTitle: mapAfterRename.includes('Уникальная очередь'),
    provenance: first.provenance,
  }, {
    searchedIds: [first.id],
    beforeBody: 'Первоначальный проверяемый факт.',
    updatedId: first.id,
    afterBody: 'Исправленный проверяемый факт.',
    revisionDelta: 1,
    mapKeepsBodyEdit: true,
    renamedCode: 0,
    mapTakesNewTitle: true,
    mapDropsOldTitle: false,
    provenance: { actor: 'executor', channel: 'cli', ref: 'direct' },
  });
});

test('Пустая выдача CLI завершается кодом 1 и печатает пустой результат', async (t) => {
  const { dbPath, cwd, link } = await seed(t);
  const result = await run(link, ['search', 'неттакоготермина'], { cwd, dbPath });

  assert.deepEqual({ code: result.code, body: JSON.parse(result.stdout), stderr: result.stderr }, {
    code: 1,
    body: { items: [] },
    stderr: '',
  });
});

test('Отсутствующая запись CLI read завершается кодом 1', async (t) => {
  const { dbPath, cwd, link } = await seed(t);
  const missing = '00000000-0000-4000-8000-000000000001';
  const result = await run(link, ['read', missing], { cwd, dbPath });

  assert.equal(result.code, 1);
});

test('Недоступное хранилище CLI отличает кодом 2 и не раскрывает абсолютный путь', async (t) => {
  const { root, cwd, link } = await cliFixture(t);
  const dbPath = path.join(root, 'directory-instead-of-db');
  await mkdir(dbPath);
  const result = await run(link, ['search', 'деплой'], { cwd, dbPath });

  assert.deepEqual({
    code: result.code,
    namedReason: /knowledge_unavailable|storage|хранилищ/ui.test(result.stderr),
    leaksPath: result.stderr.includes(dbPath),
  }, {
    code: 2,
    namedReason: true,
    leaksPath: false,
  });
});

test('Ошибка синтаксиса CLI всегда завершается кодом 64', async (t) => {
  const { dbPath, cwd, link } = await cliFixture(t);
  const result = await run(link, ['unknown-command'], { cwd, dbPath });

  assert.equal(result.code, 64);
});

test('Обычная отсутствующая база создаётся и даёт пустой результат, а не отказ', async (t) => {
  const { dbPath, cwd, link } = await cliFixture(t);
  const result = await run(link, ['search', 'неттакоготермина'], { cwd, dbPath });
  const body = result.stdout ? JSON.parse(result.stdout) : null;

  assert.deepEqual({ code: result.code, body }, {
    code: 1,
    body: { items: [] },
  });
});

test('Runtime preflight сохраняет usage-код 64 даже при неверных аргументах', async (t) => {
  const { dbPath, cwd } = await cliFixture(t);
  const preflight = path.join(ROOT, 'server', 'scripts', 'knowledge-search-preflight.mjs');
  const result = await run(process.execPath, [preflight, '--unknown'], { cwd, dbPath });

  assert.equal(result.code, 64);
});

test('Runtime preflight публикует версионный JSON с SQLite и FTS5 проверками', async (t) => {
  const { dbPath, cwd } = await cliFixture(t);
  const preflight = path.join(ROOT, 'server', 'scripts', 'knowledge-search-preflight.mjs');
  const result = await run(process.execPath, [preflight, '--json'], { cwd, dbPath });
  const body = result.code === 0 ? JSON.parse(result.stdout) : null;
  const sqlite = body?.report?.checks?.find((check) => check.id === 'sqlite_runtime');
  const fts = body?.report?.checks?.find((check) => check.id === 'fts5');

  assert.deepEqual({
    code: result.code,
    protocol: typeof body?.protocol === 'string' && body.protocol.length > 0,
    version: Number.isInteger(body?.protocolVersion),
    ok: body?.report?.ok,
    sqliteVersion: typeof sqlite?.actualVersion === 'string',
    ftsOk: fts?.ok,
  }, {
    code: 0,
    protocol: true,
    version: true,
    ok: true,
    sqliteVersion: true,
    ftsOk: true,
  });
});

test('Runtime preflight не создаёт пользовательскую базу знаний', async (t) => {
  const { dbPath, cwd } = await cliFixture(t);
  const preflight = path.join(ROOT, 'server', 'scripts', 'knowledge-search-preflight.mjs');
  await run(process.execPath, [preflight, '--json'], { cwd, dbPath });

  assert.equal(await access(dbPath).then(() => true).catch(() => false), false);
});
