import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Fastify from '../../server/node_modules/fastify/fastify.js';
import systemModule from '../../server/src/modules/system/index.ts';
import authPlugin from '../../server/src/plugins/auth.ts';
import { AuthStore } from '../../server/src/lib/authStore.ts';
import { PackagedReleaseService, PackagedUpdateManager } from '../../server/src/lib/packagedRelease.ts';

/**
 * Маршруты получают внедрённые сервисы и отдельную папку состояния.
 * Запуск задания проверяется без сетевого канала, смены файлов и перезапуска сервера.
 */
async function appFixture(t, kind) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'package-route-'));
  const app = Fastify();
  const calls = [];
  const job = {
    id: 'route-job',
    kind: 'package-update',
    status: 'downloading',
  };

  t.after(async () => {
    await app.close();
    await fs.rm(root, {
      recursive: true,
      force: true
    });
  });
  await app.register(systemModule, {
    config: {
      rootDir: root,
      grigDeskUpdateStatePath: path.join(root, 'update.json'),
      port: 9999,
      cliTokenPath: path.join(root, 'token'),
    },
    runtimeKind: () => {
      return kind;
    },
    system: {
      read: async () => {
        return {};
      },
    },
    releases: {
      getStatus: async () => {
        return { running: { version: '0.2.0' } };
      },
      checkRemote: async () => {
        calls.push('check');

        return { updateAvailable: true };
      },
      start() {},
      stop() {},
    },
    updates: {
      async recover() {},
      async getJob() {
        return job;
      },
      async startPackageUpdate(body) {
        calls.push(body);

        return job;
      },
    },
  });

  return {
    app,
    calls,
    job
  };
}

test('PUR-1: packaged POST принимает подтверждение и GET сохраняет задание', async (t) => {
  const { app, calls, job } = await appFixture(t, 'packaged');
  const body = {
    expectedVersion: '0.3.0',
    expectedArchiveSha256: 'a'.repeat(64),
  };
  const started = await app.inject({
    method: 'POST',
    url: '/api/system/package-update',
    payload: body,
  });

  assert.equal(started.statusCode, 202);
  assert.deepEqual(calls, [body]);
  assert.deepEqual(started.json().job, job);

  const status = await app.inject('/api/system/version');
  const checked = await app.inject({
    method: 'POST',
    url: '/api/system/version/check'
  });

  assert.deepEqual(status.json().job, job);
  assert.deepEqual(checked.json().job, job);
  assert.equal(checked.json().updateAvailable, true);
  assert.equal(calls.at(-1), 'check');
});

test('PUR-2: source-установка запрещает package POST до менеджера', async (t) => {
  const { app, calls } = await appFixture(t, 'source');
  const result = await app.inject({
    method: 'POST',
    url: '/api/system/package-update',
    payload: {
      expectedVersion: '0.3.0',
      expectedArchiveSha256: 'a'.repeat(64),
    },
  });

  assert.equal(result.statusCode, 409);
  assert.equal(result.json().error, 'packaged_update_requires_package');
  assert.deepEqual(calls, []);
});

/**
 * Настоящие release service, менеджер и auth guard получают только временную установку.
 * Смена её файлов после регистрации не должна менять identity уже запущенного сервера.
 */
async function runtimeIdentityFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-identity-'));
  const app = Fastify();
  const identityPath = path.join(root, 'release.json');
  const manifest = {
    schema: 1,
    packagingVersion: 1,
    version: '0.2.0',
    contentId: 'e'.repeat(64),
  };

  t.after(async () => {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.writeFile(identityPath, JSON.stringify(manifest));

  const releases = new PackagedReleaseService(root);
  const running = (await releases.getStatus()).running;
  const authStore = new AuthStore({
    legacyAccountPath: path.join(root, 'account.json'),
    sessionsPath: path.join(root, 'sessions.json'),
  });

  await app.register(authPlugin, { authStore, cliToken: 'synthetic-cli-token' });
  await app.register(systemModule, {
    config: {
      rootDir: root,
      grigDeskUpdateStatePath: path.join(root, 'update.json'),
      port: 9999,
      cliTokenPath: path.join(root, 'token'),
    },
    runtimeKind: () => 'packaged',
    system: { read: async () => ({}) },
    releases,
    updates: new PackagedUpdateManager({
      installRoot: root,
      statePath: path.join(root, 'update.json'),
    }),
  });

  return {
    app,
    running,
    identityPath,
    manifest,
  };
}

test('LIVE-PROOF: runtime identity закрыт настоящим auth guard', async (t) => {
  const { app } = await runtimeIdentityFixture(t);
  const response = await app.inject('/api/system/runtime-identity');

  assert.equal(response.statusCode, 401, response.body);
});

test('LIVE-PROOF: авторизованный runtime identity не подменяется изменившимся диском', async (t) => {
  const { app, running, identityPath, manifest } = await runtimeIdentityFixture(t);
  const request = {
    url: '/api/system/runtime-identity',
    headers: { 'x-grigdesk-token': 'synthetic-cli-token' },
  };
  const first = await app.inject(request);

  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().version, running.version);
  assert.equal(first.json().instanceId, running.instanceId);
  await fs.writeFile(identityPath, JSON.stringify({ ...manifest, version: '0.3.0' }));

  const second = await app.inject(request);

  assert.equal(second.statusCode, 200, second.body);
  assert.deepEqual(second.json(), first.json(), 'boot identity остаётся identity текущего процесса');
});

const { installedFixture, pinnedKeyHook } = await import('../helpers/installedUpdateFixture.mjs');
const { confirmInstalledUpdate } = await import('../../shared/node/installedUpdateApply.ts');
const { saveInstalledUpdate } = await import('../../shared/node/installedUpdateState.ts');
const { execFile } = await import('node:child_process');
const { promisify } = await import('node:util');

for (const mode of ['local', 'server']) {
  test(`PUR-REGISTERED-PAIR/UPDATE-DRAIN-AUTH/REPEAT: ${mode}`, async (t) => {
    const box = await installedFixture(t, { mode });
    const created = await box.create();

    await box.manager.prepare(created.id);

    const job = await confirmInstalledUpdate(box.root, created.id);

    job.stage = 'stopping';
    await saveInstalledUpdate(box.receipt, job);

    const binary = path.join(box.root, box.previous.server, 'bin/grigdesk-server');
    const payloadFile = path.join(box.temporary, 'payload/server/server.cjs');
    const hook = await pinnedKeyHook(box.temporary, box.release.publicKeyPem);
    const runner = path.join(box.temporary, 'routes.mjs');
    const repository = path.resolve(import.meta.dirname, '../..');
    const moduleUrl = (relative) => JSON.stringify(path.join(repository, relative));
    const context = {
      mode: 'payload',
      binary,
      bundleFile: payloadFile,
    };

    await fs.mkdir(path.dirname(binary), { recursive: true, mode: 0o700 });
    await fs.writeFile(binary, 'фикстурный ELF', { mode: 0o555 });
    await fs.mkdir(path.dirname(payloadFile), { recursive: true });
    await fs.writeFile(payloadFile, '');
    await fs.writeFile(runner, [
      "import assert from 'node:assert/strict';",
      "import { registerHooks } from 'node:module';",
      'registerHooks({ load(url, ctx, next) {',
      "  if (url.endsWith('/server/src/lib/runtimeBuildContext.ts')) {",
      `    return { format: 'module', shortCircuit: true, source:`,
      `      'export const runtimeBuildContext = () => (${JSON.stringify(context)});' };`,
      '  }',
      "  if (url.endsWith('/server/src/config.ts')) {",
      `    return { format: 'module', shortCircuit: true, source:`,
      `      'export const config = ${JSON.stringify({ dataHome: box.receipt.dataHome })};' };`,
      '  }',
      '  return next(url, ctx);',
      '} });',
      `const { default: Fastify } = await import(${moduleUrl('server/node_modules/fastify/fastify.js')});`,
      `const { default: systemModule } = await import(${moduleUrl('server/src/modules/system/index.ts')});`,
      `const { default: authPlugin } = await import(${moduleUrl('server/src/plugins/auth.ts')});`,
      `const { AuthStore } = await import(${moduleUrl('server/src/lib/authStore.ts')});`,
      'const app = Fastify();',
      `const root = ${JSON.stringify(box.temporary)};`,
      'const store = new AuthStore({',
      '  legacyAccountPath: root + "/account", sessionsPath: root + "/sessions",',
      '});',
      'let stops = 0;',
      'let jobs = 0;',
      'app.decorate("shutdown", { active: false, afterDrain() {}, begin: async () => { stops += 1; } });',
      "await app.register(authPlugin, { authStore: store, cliToken: 'fixture-token' });",
      'await app.register(systemModule, {',
      `  config: { rootDir: root, grigDeskUpdateStatePath: root + '/state',`,
      '    port: 9999, cliTokenPath: root },',
      "  runtimeKind: () => 'packaged', serverMode: () => 'manual',",
      '  system: { read: async () => ({}) },',
      '  releases: { getStatus: async () => ({ running: { version: "0.2.0" } }), start() {}, stop() {} },',
      '  updates: { recover: async () => {}, getJob: async () => null,',
      '    startPackageUpdate: async () => { jobs += 1; } },',
      '});',
      "const headers = { 'x-grigdesk-token': 'fixture-token' };",
      `const body = ${JSON.stringify({
        jobId: job.id,
        installationId: job.installationId,
        manifestDigest: job.manifestDigest,
      })};`,
      "const legacy = await app.inject({ method: 'POST', url: '/api/system/package-update', headers,",
      "  payload: { expectedVersion: '0.3.0', expectedArchiveSha256: 'a'.repeat(64) } });",
      'assert.equal(legacy.statusCode, 409, legacy.body);',
      `assert.equal(legacy.json().error,`,
      `  '${mode === 'local' ? 'pair_update_required' : 'server_update_requires_cli'}');`,
      "const request = { method: 'POST', url: '/api/system/update-drain', payload: body };",
      'assert.equal((await app.inject(request)).statusCode, 401);',
      'assert.equal((await app.inject({ ...request, headers: {',
      '  cookie: "grigdesk_sid=" + store.createSession().id,',
      '} })).statusCode, 403);',
      'assert.equal((await app.inject({ ...request, headers, payload: { ...body,',
      '  manifestDigest: "0".repeat(64),',
      '} })).statusCode, 409);',
      'assert.equal((await app.inject({ ...request, headers })).statusCode, 202);',
      'assert.equal((await app.inject({ ...request, headers })).statusCode, 202);',
      'await new Promise((resolve) => setTimeout(resolve, 500));',
      'assert.equal(stops, 1);',
      'assert.equal(jobs, 0);',
      'await app.close();',
      'process.stdout.write("REGISTERED_OK\\n");',
    ].join('\n'));

    const result = await promisify(execFile)(process.execPath, ['--import', hook, runner], {
      env: {
        HOME: box.temporary,
        GRIGDESK_HOME: box.receipt.dataHome,
        PATH: '/usr/bin:/bin',
      },
      timeout: 10000,
    });

    assert.match(result.stdout, /REGISTERED_OK/);
    assert.deepEqual(await box.pointer(), box.previous);
    await box.preserved();
  });
}
