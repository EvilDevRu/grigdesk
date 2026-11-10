import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { SYSTEM, isEnabled } from '../../server/src/lib/pluginsRegistry.ts';
import pluginsModule from '../../server/src/modules/plugins/index.ts';
import { config } from '../../server/src/config.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');
const websocketPlugin = requireFromServer('@fastify/websocket');
const WebSocket = requireFromServer('ws');

async function pluginFixture(t, initial = {}) {
  let prefsData = structuredClone(initial);
  const app = Fastify({ logger: false });
  const prefs = {
    read: () => prefsData,
    write(patch) {
      prefsData = { ...prefsData, ...structuredClone(patch) };
    },
  };

  await app.register(pluginsModule, {
    config: { userPluginsDir: '/definitely/missing/plugins' },
    prefs,
  });
  t.after(() => app.close());

  return { app, readPrefs: () => prefsData };
}

test('SSH зарегистрирован системным плагином и выключен по умолчанию', () => {
  const ssh = SYSTEM.find((plugin) => plugin.id === 'ssh');

  assert.deepEqual({
    system: ssh?.system,
    defaultEnabled: ssh?.defaultEnabled,
    enabledWithoutPrefs: ssh ? isEnabled({}, ssh) : null,
    nav: ssh?.nav,
  }, {
    system: true,
    defaultEnabled: false,
    enabledWithoutPrefs: false,
    nav: {
      path: '/ssh',
      label: 'SSH',
      group: 'dock',
      order: 40,
    },
  });
});

test('SSH объявляет единый ограниченный лимит вывода в KiB', () => {
  const setting = SYSTEM.find((plugin) => plugin.id === 'ssh')
    ?.settings.find((item) => item.key === 'outputLimitKiB');

  assert.deepEqual(setting && {
    type: setting.type,
    default: setting.default,
    min: setting.min,
    max: setting.max,
    step: setting.step,
  }, {
    type: 'number',
    default: 64,
    min: 4,
    max: 1024,
    step: 4,
  });
});

test('SSH metadata known-hosts и audit имеют отдельные приватные пути состояния', () => {
  assert.deepEqual({
    connections: config.sshConnectionsPath?.endsWith('/state/ssh/connections.json'),
    knownHosts: config.sshKnownHostsPath?.endsWith('/state/ssh/known-hosts.json'),
    audit: config.sshAuditDir?.endsWith('/state/ssh/audit'),
    prefsIsSshState: config.prefsPath?.includes('/ssh/'),
  }, {
    connections: true,
    knownHosts: true,
    audit: true,
    prefsIsSshState: false,
  });
});

test('сервер клампит числовую настройку SSH по схеме до записи в prefs', async (t) => {
  const { app, readPrefs } = await pluginFixture(t, { plugins: { ssh: true } });
  const response = await app.inject({
    method: 'PUT',
    url: '/api/plugins/ssh/settings',
    payload: { values: { outputLimitKiB: 99999 } },
  });

  assert.deepEqual({
    status: response.statusCode,
    body: response.json(),
    saved: readPrefs().pluginSettings?.ssh,
  }, {
    status: 200,
    body: { ok: true, values: { outputLimitKiB: 1024 } },
    saved: { outputLimitKiB: 1024 },
  });
});

test('каждый SSH route проверяет живое выключение плагина', async (t) => {
  let sshModule;
  try {
    sshModule = await import('../../server/src/modules/ssh/index.ts');
  } catch (error) {
    assert.fail(`live-gated SSH API ещё не реализован: ${error.message}`);
  }
  const app = Fastify({ logger: false });
  app.decorateRequest('authKind', null);
  app.addHook('onRequest', async (request) => { request.authKind = 'session'; });
  app.decorate('pluginEnabled', () => false);
  const service = new Proxy({}, {
    get() {
      return async () => ({ ok: true, connections: [], sessions: [], files: [], items: [] });
    },
  });
  await app.register(sshModule.default, { service });
  t.after(() => app.close());
  const requests = [
    ['GET', '/api/ssh/connections'],
    ['POST', '/api/ssh/connections', {}],
    ['PUT', '/api/ssh/connections/connection-a', {}],
    ['DELETE', '/api/ssh/connections/connection-a'],
    ['POST', '/api/ssh/connections/connection-a/host-key/probe', {}],
    ['POST', '/api/ssh/host-key/challenge-a', { decision: 'trust' }],
    ['GET', '/api/ssh/sessions'],
    ['POST', '/api/ssh/connections/connection-a/sessions', Buffer.from('password'), 'application/octet-stream'],
    ['PUT', '/api/ssh/sessions/session-a/agent-access', { allowed: true }],
    ['DELETE', '/api/ssh/sessions/session-a'],
    ['GET', '/api/ssh/sessions/session-a/terminal'],
    ['GET', '/api/ssh/sessions/session-a/files?path=%2Ftmp'],
    ['GET', '/api/ssh/sessions/session-a/files/download?path=%2Ftmp%2Fa'],
    ['POST', '/api/ssh/sessions/session-a/files/upload'],
    ['GET', '/api/ssh/audit'],
    ['POST', '/api/ssh/approvals/pid-a', { allow: true }],
  ];
  const results = [];
  for (const [method, url, payload, contentType] of requests) {
    const response = await app.inject({
      method,
      url,
      ...(payload !== undefined ? { payload } : {}),
      ...(contentType ? { headers: { 'content-type': contentType } } : {}),
    });
    results.push([method, url, response.statusCode, response.json().error]);
  }

  assert.deepEqual(
    results.map(([method, url, status, error]) => [method, url, status, error]),
    requests.map(([method, url]) => [method, url, 404, 'plugin_disabled']),
  );
});

test('HTTP route видит выключение SSH без перерегистрации плагина', async (t) => {
  let sshModule;
  try {
    sshModule = await import('../../server/src/modules/ssh/index.ts');
  } catch (error) {
    assert.fail(`live-gated SSH API ещё не реализован: ${error.message}`);
  }
  let enabled = true;
  let brokerCalls = 0;
  const app = Fastify({ logger: false });
  app.decorateRequest('authKind', null);
  app.addHook('onRequest', async (request) => { request.authKind = 'session'; });
  app.decorate('pluginEnabled', (id) => id === 'ssh' && enabled);
  const service = {
    async listConnections() {
      brokerCalls += 1;
      return { connections: [] };
    },
  };
  await app.register(sshModule.default, { service });
  t.after(() => app.close());

  const before = await app.inject({ method: 'GET', url: '/api/ssh/connections' });
  enabled = false;
  const after = await app.inject({ method: 'GET', url: '/api/ssh/connections' });

  assert.deepEqual({
    before: before.statusCode,
    after: [after.statusCode, after.json().error],
    serviceCalls: brokerCalls,
  }, {
    before: 200,
    after: [404, 'plugin_disabled'],
    serviceCalls: 1,
  });
});

test('WebSocket terminal повторно читает флаг SSH при каждом upgrade', async (t) => {
  let sshModule;
  try {
    sshModule = await import('../../server/src/modules/ssh/index.ts');
  } catch (error) {
    assert.fail(`SSH WebSocket ещё не реализован: ${error.message}`);
  }
  let enabled = true;
  let attaches = 0;
  const app = Fastify({ logger: false });
  await app.register(websocketPlugin);
  app.decorateRequest('authKind', null);
  app.addHook('onRequest', async (request) => { request.authKind = 'session'; });
  app.decorate('pluginEnabled', (id) => id === 'ssh' && enabled);
  const service = {
    attachTerminal(_sid, socket) {
      attaches += 1;
      socket.send('ready');
      return () => {};
    },
  };
  await app.register(sshModule.default, { service });
  await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => app.close());
  const port = app.server.address().port;

  const opened = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/ssh/sessions/session-a/terminal`);
    socket.once('message', (data) => { resolve(String(data)); socket.close(); });
    socket.once('error', reject);
  });
  enabled = false;
  const disabledStatus = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/ssh/sessions/session-a/terminal`);
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    socket.once('open', () => reject(new Error('выключенный SSH WebSocket неожиданно открылся')));
    socket.once('error', reject);
  });

  assert.deepEqual({ opened, disabledStatus, attaches }, {
    opened: 'ready',
    disabledStatus: 404,
    attaches: 1,
  });
});

test('агентский broker отказывает сразу после живого выключения SSH', async () => {
  let module;
  try {
    module = await import('../../server/src/lib/ssh/broker.ts');
  } catch (error) {
    assert.fail(`SSH broker ещё не реализован: ${error.message}`);
  }
  const create = module.createSshBroker || module.default;
  assert.equal(typeof create, 'function', 'broker.js обязан экспортировать фабрику');
  let enabled = true;
  let sessionReads = 0;
  const broker = create({
    pluginEnabled: () => enabled,
    sessions: {
      listForAgent() {
        sessionReads += 1;

        return [{
          id: 'session-a',
          projectId: 'project-a',
          label: 'Боевой код',
          role: 'code',
          agentAllowed: true,
        }];
      },
    },
  });

  const before = await broker.invoke({ projectId: 'project-a' }, { action: 'list' });
  enabled = false;
  const after = await broker.invoke({ projectId: 'project-a' }, { action: 'list' });

  assert.deepEqual({ before, after, sessionReads }, {
    before: [{
      sessionId: 'session-a',
      projectId: 'project-a',
      label: 'Боевой код',
      role: 'code',
    }],
    after: { ok: false, error: 'plugin_disabled' },
    sessionReads: 1,
  });
});

test('отказ без пояснения принимается и доезжает до очереди', async (t) => {
  let sshModule;
  try {
    sshModule = await import('../../server/src/modules/ssh/index.ts');
  } catch (error) {
    assert.fail(`live-gated SSH API ещё не реализован: ${error.message}`);
  }
  const answers = [];
  const app = Fastify({ logger: false });
  app.decorateRequest('authKind', null);
  app.addHook('onRequest', async (request) => { request.authKind = 'session'; });
  app.decorate('pluginEnabled', (id) => id === 'ssh');
  const service = {
    async answerApproval(pid, decision) {
      answers.push([pid, decision.allow, decision.comment]);
      return { ok: true };
    },
  };
  await app.register(sshModule.default, { service });
  t.after(() => app.close());

  const silent = await app.inject({
    method: 'POST',
    url: '/api/ssh/approvals/pid-a',
    payload: { allow: false },
  });
  const explained = await app.inject({
    method: 'POST',
    url: '/api/ssh/approvals/pid-b',
    payload: { allow: false, comment: '  не на проде  ' },
  });

  assert.deepEqual({
    silentStatus: silent.statusCode,
    explainedStatus: explained.statusCode,
    answers,
  }, {
    silentStatus: 200,
    explainedStatus: 200,
    answers: [['pid-a', false, ''], ['pid-b', false, 'не на проде']],
  });
});
