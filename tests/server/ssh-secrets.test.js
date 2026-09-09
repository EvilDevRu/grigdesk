import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PrefsStore } from '../../server/src/lib/prefs-store.js';

class FakeSsh2Client extends EventEmitter {
  connect(options) {
    this.options = options;
    queueMicrotask(() => this.emit('ready'));
    return this;
  }

  end() {
    this.emit('close');
  }
}

async function walkText(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await walkText(target));
    else result.push(await readFile(target, 'utf8'));
  }
  return result.join('\n');
}

test('пароль не появляется в сохранённых SSH-профилях и клиентском DTO', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-ssh-secret-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let module;
  try {
    module = await import('../../server/src/lib/ssh/store.ts');
  } catch (error) {
    assert.fail(`приватное хранилище SSH-профилей ещё не реализовано: ${error.message}`);
  }
  const create = module.createSshStore || module.createConnectionStore || module.default;
  assert.equal(typeof create, 'function', 'store.js обязан экспортировать фабрику');
  const store = await create({ dir: root, projects: () => [{ id: 'project-a' }] });
  const password = 'SSH_PASSWORD_SENTINEL_91006';
  const dto = await store.create({
    projectId: 'project-a',
    label: 'Боевой код',
    role: 'code',
    host: 'server.internal',
    port: 22,
    user: 'deploy',
    password,
  });
  const disk = await walkText(root);

  assert.deepEqual({
    dtoHasPassword: JSON.stringify(dto).includes(password),
    diskHasPassword: disk.includes(password),
  }, {
    dtoHasPassword: false,
    diskHasPassword: false,
  });
});

test('пара метка и роль уникальна только внутри одного проекта', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-ssh-profile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let module;
  try {
    module = await import('../../server/src/lib/ssh/store.ts');
  } catch (error) {
    assert.fail(`валидация SSH-профилей ещё не реализована: ${error.message}`);
  }
  const create = module.createSshStore || module.createConnectionStore || module.default;
  const store = await create({ dir: root, projects: () => [{ id: 'project-a' }, { id: 'project-b' }] });
  const base = {
    label: 'Боевой код', role: 'code', host: 'server.internal', port: 22, user: 'deploy',
  };
  await store.create({ ...base, projectId: 'project-a' });
  const duplicate = await store.create({ ...base, projectId: 'project-a' })
    .then(() => 'accepted', (error) => error.code);
  const neighbor = await store.create({ ...base, projectId: 'project-b' })
    .then(() => 'accepted', (error) => error.code);

  assert.deepEqual({ duplicate, neighbor }, {
    duplicate: 'duplicate_selector',
    neighbor: 'accepted',
  });
});

test('SSH transport использует ssh2 и не запускает пароль через системный процесс', async () => {
  const packageJson = JSON.parse(await readFile(
    new URL('../../server/package.json', import.meta.url),
    'utf8',
  ));
  let module;
  try {
    module = await import('../../server/src/lib/ssh/transport.ts');
  } catch (error) {
    assert.fail(`управляемый SSH transport ещё не реализован: ${error.message}`);
  }
  const create = module.createSshTransport || module.default;
  assert.equal(typeof create, 'function', 'transport.js обязан экспортировать фабрику');
  const processCalls = [];
  const clients = [];
  const hostKey = Buffer.from('ssh2-host-key-fixture');
  const expectedFingerprint = `SHA256:${createHash('sha256').update(hostKey).digest('base64')}`;
  let verifiedFingerprint = '';
  const transport = create({
    createClient() {
      const client = new FakeSsh2Client();
      clients.push(client);
      return client;
    },
    spawnProcess(file, argv, options) {
      processCalls.push({ file, argv, env: options?.env });
      throw new Error('системный SSH-процесс запрещён');
    },
  });
  const connection = await transport.connect({
    host: 'server.internal',
    port: 22,
    user: 'deploy',
    password: Buffer.from('SSH_PASSWORD_SENTINEL_91006'),
    hostVerifier(fingerprint) {
      verifiedFingerprint = fingerprint;
      return fingerprint === expectedFingerprint;
    },
  });
  const verifierAccepted = clients[0].options.hostVerifier(
    createHash('sha256').update(hostKey).digest('hex'),
  );
  connection.close?.();

  assert.deepEqual({
    dependency: typeof packageJson.dependencies?.ssh2 === 'string',
    ssh2Clients: clients.length,
    processCalls,
    hostHash: clients[0].options.hostHash,
    verifiedFingerprint,
    verifierAccepted,
  }, {
    dependency: true,
    ssh2Clients: 1,
    processCalls: [],
    hostHash: 'sha256',
    verifiedFingerprint: expectedFingerprint,
    verifierAccepted: true,
  });
});

test('пароль из connect не попадает в prefs и их клиентский snapshot', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-ssh-prefs-secret-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prefsPath = path.join(root, 'prefs.json');
  const prefs = new PrefsStore({ prefsPath });
  prefs.write({
    plugins: { ssh: true },
    pluginSettings: { ssh: { outputLimitKiB: 64 } },
  });
  let module;
  try {
    module = await import('../../server/src/modules/ssh/index.ts');
  } catch (error) {
    assert.fail(`SSH connect API ещё не реализован: ${error.message}`);
  }
  const requireFromServer = (await import('node:module')).createRequire(
    new URL('../../server/package.json', import.meta.url),
  );
  const Fastify = requireFromServer('fastify');
  const app = Fastify({ logger: false });
  app.decorateRequest('authKind', null);
  app.addHook('onRequest', async (request) => { request.authKind = 'session'; });
  app.decorate('pluginEnabled', (id) => id === 'ssh');
  const sentinel = 'SSH_PASSWORD_SENTINEL_91006';
  let receivedPassword = '';
  await app.register(module.default, {
    prefs,
    service: {
      async openSession(_connectionId, password) {
        receivedPassword = Buffer.from(password).toString('utf8');
        return { session: { id: 'session-a', label: 'Боевой код', role: 'code' } };
      },
    },
  });
  t.after(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: '/api/ssh/connections/connection-a/sessions',
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.from(sentinel),
  });
  const persisted = await readFile(prefsPath, 'utf8');
  const snapshot = JSON.stringify(prefs.read());

  assert.deepEqual({
    status: response.statusCode,
    receivedPassword,
    responseLeaks: response.body.includes(sentinel),
    persistedLeaks: persisted.includes(sentinel),
    snapshotLeaks: snapshot.includes(sentinel),
  }, {
    status: 200,
    receivedPassword: sentinel,
    responseLeaks: false,
    persistedLeaks: false,
    snapshotLeaks: false,
  });
});
