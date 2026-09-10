import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import chatModule from '../../server/src/modules/chat/index.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

async function permissionQueue(options = {}) {
  let module;
  try {
    module = await import('../../server/src/lib/chat/permissionQueue.ts');
  } catch (error) {
    assert.fail(`единая очередь подтверждений ещё не выделена: ${error.message}`);
  }
  const create = module.createPermissionQueue || module.default;
  assert.equal(typeof create, 'function', 'permission-queue.js обязан экспортировать фабрику');
  return create(options);
}

function sshRequest() {
  return {
    origin: 'ssh',
    chatKey: 'chat-a',
    presentation: {
      server: { label: 'Боевой код', host: 'server.internal', port: 22 },
      user: 'deploy',
      isRoot: false,
      usesSudo: true,
      command: 'sudo systemctl restart app',
    },
  };
}

test('ответ через generic origin не снимает SSH-подтверждение', async () => {
  const queue = await permissionQueue({ timeoutMs: 24 * 60 * 60 * 1000 });
  const pending = queue.enqueue(sshRequest());
  const answer = await queue.answer(pending.pid, 'chat', { allow: true });

  assert.deepEqual({ answer, waiting: queue.waiting().map((item) => item.pid) }, {
    answer: { ok: false, error: 'origin_mismatch' },
    waiting: [pending.pid],
  });
});

test('отказ по SSH возвращает агенту пояснение человека', async () => {
  const queue = await permissionQueue({ timeoutMs: 24 * 60 * 60 * 1000 });
  const pending = queue.enqueue(sshRequest());
  await queue.answer(pending.pid, 'ssh', { allow: false, comment: 'сейчас идёт выкладка' });

  assert.deepEqual(await pending.result, {
    allow: false,
    comment: 'сейчас идёт выкладка',
  });
});

test('два окна могут принять только одно решение по SSH-команде', async () => {
  const queue = await permissionQueue({ timeoutMs: 24 * 60 * 60 * 1000 });
  const pending = queue.enqueue(sshRequest());
  const [first, second] = await Promise.all([
    queue.answer(pending.pid, 'ssh', { allow: true }),
    queue.answer(pending.pid, 'ssh', { allow: false, comment: 'нет' }),
  ]);

  assert.deepEqual({
    accepted: [first, second].filter((result) => result.ok).length,
    resolved: [first, second].filter((result) => result.error === 'already_resolved').length,
  }, {
    accepted: 1,
    resolved: 1,
  });
});

test('SSH-подтверждение живёт до общего технического потолка в 24 часа', async () => {
  let expire;
  const queue = await permissionQueue({
    timeoutMs: 24 * 60 * 60 * 1000,
    setTimer(callback, delay) {
      expire = { callback, delay };
      return 1;
    },
    clearTimer() {},
  });
  const pending = queue.enqueue(sshRequest());
  expire.callback();

  assert.deepEqual({ delay: expire.delay, result: await pending.result }, {
    delay: 24 * 60 * 60 * 1000,
    result: { allow: false, error: 'approval_expired' },
  });
});

test('chat/index в auto-режиме не применяет autoDecision и remember к SSH', async (t) => {
  let brokerModule;
  try {
    brokerModule = await import('../../server/src/lib/ssh/broker.ts');
  } catch (error) {
    assert.fail(`SSH broker ещё не реализован: ${error.message}`);
  }
  const createBroker = brokerModule.createSshBroker || brokerModule.default;
  assert.equal(typeof createBroker, 'function', 'broker.js обязан экспортировать фабрику');
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-ssh-chat-auto-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profilesDir = path.join(root, 'profiles');
  const source = path.join(root, 'source');
  const worktree = path.join(root, 'worktree');
  await mkdir(path.join(profilesDir, 'project-a'), { recursive: true });
  await mkdir(source, { recursive: true });
  await mkdir(worktree, { recursive: true });
  await writeFile(path.join(profilesDir, 'project-a', 'graph.json'), JSON.stringify({ nodes: {} }));

  const queue = await permissionQueue({ timeoutMs: 24 * 60 * 60 * 1000 });
  const session = {
    id: 'session-a',
    projectId: 'project-a',
    label: 'Боевой код',
    role: 'code',
    agentAllowed: true,
    generation: 7,
  };
  const broker = createBroker({
    pluginEnabled: () => true,
    permissionQueue: queue,
    sessions: {
      listForAgent: () => [session],
      findForAgent: () => session,
      exec: async () => ({ ok: true, output: 'uid=1000' }),
    },
  });
  const app = Fastify({ logger: false });
  app.decorate('sse', { broadcast() {} });
  app.decorate('pluginEnabled', (id) => id === 'ssh');
  app.decorate('sshBroker', broker);
  await app.register(chatModule, {
    config: {
      chatsDir: path.join(root, 'chats'),
      chatStoreLegacyPath: path.join(root, 'legacy.json'),
      chatBindingsDir: path.join(root, 'bindings'),
      rootDir: root,
      factoryHome: root,
      profilesDir,
      agentsDir: path.join(root, 'agents'),
      port: 18140,
    },
    permissionQueue: queue,
    sshBroker: broker,
    factoryState: {
      async readEnv() {
        return {
          WORKSPACE_MODE: 'isolated',
          REPO_COUNT: '1',
          REPO_0_NAME: 'main',
          REPO_0_SOURCE: source,
          REPO_0_WT: worktree,
          REPO_0_BRANCH: 'task-44',
        };
      },
      async readTrustedAttempt() {
        return { profile: 'project-a' };
      },
    },
    prefs: {
      read() {
        return { trustedDirectories: [], providerSettings: {}, chatAutoCompactWindow: 0 };
      },
    },
    modelsRegistry: async () => ({ fake: [{ id: 'fake-1', efforts: [] }] }),
    executorResolver: async () => ({
      id: 'fake',
      async run(options) {
        const result = await options.workTools.invoke('supervised_ssh', {
          action: 'exec', label: 'Боевой код', role: 'code', command: 'id',
        });
        return { reply: JSON.stringify(result), steps: [], sessionId: 'fake-session' };
      },
    }),
  });
  t.after(() => app.close());

  const turn = app.inject({
    method: 'POST',
    url: '/api/tasks/44/chat',
    payload: {
      message: 'execute id',
      modelRef: { provider: 'fake', model: 'fake-1' },
      mode: 'auto',
      permissionMode: 'bypassPermissions',
    },
  });
  let item;
  for (let attempt = 0; attempt < 100 && !item; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    item = queue.waiting().find((entry) => entry.origin === 'ssh');
  }
  const snapshot = item && {
    origin: item.origin,
    canRemember: item.canRemember,
    command: item.presentation?.command,
  };
  if (item) {
    await queue.answer(item.pid, 'ssh', { allow: false, comment: 'нет' });
  }
  await turn;

  assert.deepEqual(snapshot, {
    origin: 'ssh',
    canRemember: false,
    command: 'id',
  });
});
