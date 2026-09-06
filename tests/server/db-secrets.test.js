import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PrefsStore } from '../../server/src/lib/prefs-store.js';

async function load(relative, contract) {
  try {
    return await import(new URL(relative, import.meta.url));
  } catch (error) {
    assert.fail(`${contract}: ${error.message}`);
  }
}

async function allText(root) {
  const names = await readdir(root, { recursive: true });
  const chunks = [];
  for (const name of names) {
    const target = path.join(root, name);
    chunks.push(await readFile(target, 'utf8').catch(() => ''));
  }
  return chunks.join('\n');
}

test('пароль не сохраняется в профиле БД и публичном DTO', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-db-profile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const module = await load(
    '../../server/src/lib/db/store.js',
    'приватное хранилище DB-профилей ещё не реализовано',
  );
  const create = module.createDbStore || module.createProfileStore || module.default;
  const store = await create({ path: path.join(root, 'profiles.json') });
  const sentinel = 'DB_PASSWORD_SENTINEL_91012';
  const profile = await store.create({
    projectId: 'project-a',
    label: 'Прод-заказы',
    role: 'read',
    engine: 'mysql',
    host: 'db.internal',
    port: 3306,
    user: 'reader',
    database: 'orders',
    prod: true,
    via: 'direct',
    password: sentinel,
  });
  const disk = await allText(root);

  assert.deepEqual({
    dtoLeaks: JSON.stringify(profile).includes(sentinel),
    diskLeaks: disk.includes(sentinel),
  }, {
    dtoLeaks: false,
    diskLeaks: false,
  });
});

test('DB-сессия затирает входной буфер пароля после открытия драйвера', async () => {
  const module = await load(
    '../../server/src/lib/db/session-manager.js',
    'server-owned DB-сессии ещё не реализованы',
  );
  const create = module.createDbSessionManager || module.default;
  const password = Buffer.from('DB_PASSWORD_SENTINEL_91012');
  const manager = create({
    engines: {
      get() {
        return {
          id: 'mysql',
          async open() {
            return { close() {} };
          },
        };
      },
    },
  });
  const session = await manager.open({
    profile: {
      id: 'profile-a', projectId: 'project-a', label: 'Прод-заказы', role: 'read',
      engine: 'mysql', host: 'db.internal', port: 3306, user: 'reader', database: 'orders',
      prod: true, via: 'direct',
    },
    password,
  });

  assert.deepEqual({
    passwordBytes: [...password],
    dtoLeaks: JSON.stringify(session).includes('DB_PASSWORD_SENTINEL_91012'),
  }, {
    passwordBytes: Array(password.length).fill(0),
    dtoLeaks: false,
  });
});

test('пароль DB-сессии отсутствует в prefs журнале argv env и артефактах', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-db-session-secret-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sentinel = 'DB_PASSWORD_SENTINEL_91012_FULL_BOUNDARY';
  const prefsPath = path.join(root, 'prefs.json');
  const prefs = new PrefsStore({ prefsPath });
  prefs.write({
    plugins: { db: true },
    pluginSettings: { db: { autoRead: false, maxRows: 1000 } },
  });
  const auditModule = await load(
    '../../server/src/lib/db/audit.js',
    'приватный DB-журнал ещё не реализован',
  );
  const createAudit = auditModule.createDbAudit || auditModule.default;
  const audit = await createAudit({
    dir: path.join(root, 'audit'),
    now: () => new Date('2026-09-02T10:00:00.000Z'),
  });
  await audit.append({
    projectId: 'project-a',
    actor: 'human',
    query: 'SELECT 1',
    outcome: 'success',
    password: sentinel,
  });
  const sessionModule = await load(
    '../../server/src/lib/db/session-manager.js',
    'server-owned DB-сессии ещё не реализованы',
  );
  const createSessions = sessionModule.createDbSessionManager || sessionModule.default;
  const spawned = [];
  const manager = createSessions({
    prefs,
    audit,
    artifactsDir: path.join(root, 'sessions'),
    spawnProcess(file, argv, options) {
      spawned.push({ file, argv, env: options?.env });
      throw new Error('DB-драйвер не должен запускать внешний CLI');
    },
    engines: {
      get() {
        return {
          id: 'mysql',
          async open() {
            return { close() {} };
          },
        };
      },
    },
  });
  const password = Buffer.from(sentinel);
  const session = await manager.open({
    profile: {
      id: 'profile-a', projectId: 'project-a', label: 'Прод-заказы', role: 'read',
      engine: 'mysql', host: 'db.internal', port: 3306, user: 'reader', database: 'orders',
      prod: true, via: 'direct',
    },
    password,
  });
  const sessionSnapshot = JSON.stringify({ session, sessions: manager.list() });
  await manager.closeAll?.();
  const disk = await allText(root);
  const prefsSnapshot = JSON.stringify(prefs.read());
  const processArgv = JSON.stringify(process.argv);
  const processEnv = JSON.stringify(process.env);
  const spawnedSnapshot = JSON.stringify(spawned);

  assert.deepEqual({
    prefs: prefsSnapshot.includes(sentinel),
    auditAndArtifacts: disk.includes(sentinel),
    processArgv: processArgv.includes(sentinel),
    processEnv: processEnv.includes(sentinel),
    spawnedArgvEnv: spawnedSnapshot.includes(sentinel),
    spawnedProcesses: spawned.length,
    sessionArtifacts: sessionSnapshot.includes(sentinel),
  }, {
    prefs: false,
    auditAndArtifacts: false,
    processArgv: false,
    processEnv: false,
    spawnedArgvEnv: false,
    spawnedProcesses: 0,
    sessionArtifacts: false,
  });
});
