import assert from 'node:assert/strict';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

import codex from '../../server/src/lib/executors/codex.ts';
import { createWorkTools } from '../../server/src/lib/executors/index.ts';
import { createPermissionQueue } from '../../server/src/lib/chat/permissionQueue.ts';
import { createDbBroker } from '../../server/src/lib/db/broker.ts';
import { hostFixture, until } from '../fixtures/codex-app-server/host-fixture.mjs';

const scopedUrl = new URL('../fixtures/codex-app-server/scoped-workspace-0.165.mts', import.meta.url);
const requireServer = createRequire(new URL('../../server/package.json', import.meta.url));
const { parse } = requireServer('smol-toml');

test('Host setting не повышает служебный workspaceAccess', async (t) => {
  const f = await hostFixture(t);
  const trace = path.join(f.root, 'scoped.jsonl');
  const bin = path.join(f.root, 'scoped-cli');

  await writeFile(bin, [
    `#!${process.execPath}`,
    `import { runScopedWorkspaceFixture } from ${JSON.stringify(scopedUrl.href)};`,
    'runScopedWorkspaceFixture();',
    '',
  ].join('\n'));
  await chmod(bin, 0o755);

  const options = {
    config: { codexBin: bin },
    env: {
      ...process.env,
      GRIGDESK_CODEX_PROFILE_TRACE: trace,
    },
    cwd: f.cwd,
    model: 'fixture-model',
    permissionMode: 'auto',
    providerSettings: { allowHostAccess: true },
    tokenInfoReader: async () => null,
    workspaceAccess: {
      readableRoots: [f.cwd],
      writableRoots: [f.cwd],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
      allowExternalMcp: false,
    },
  };
  const first = await codex.run({
    ...options,
    message: 'Служебный первый ход',
  });
  const second = await codex.run({
    ...options,
    sessionId: first.sessionId,
    message: 'Продолжить',
  });
  const messages = (await readFile(trace, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  const starts = messages.filter((entry) => ['thread/start', 'thread/resume'].includes(entry.method));
  const turns = messages.filter((entry) => entry.method === 'turn/start');

  assert.equal(first.reply, 'Оценка готова.');
  assert.equal(second.reply, 'Оценка готова.');
  assert.equal(starts.length, 2);
  assert.equal(turns.length, 2);
  assert.equal(starts[1].method, 'thread/resume');

  for (const launch of messages.filter((entry) => Array.isArray(entry.argv))) {
    const config = {};

    for (let index = 0; index < launch.argv.length; index += 1) {
      if (launch.argv[index] === '-c') {
        Object.assign(config, parse(launch.argv[++index]));
      }
    }

    assert.deepEqual(config.permissions[config.default_permissions].filesystem, {
      ':root': 'deny',
      ':minimal': 'read',
      [bin]: 'read',
      [f.cwd]: 'write',
    });
    assert.deepEqual(config.permissions[config.default_permissions].network, { enabled: false });
    assert.deepEqual(config.mcp_servers, {});
    assert.equal(config.features.hooks, false);
  }

  for (const entry of [...starts, ...turns]) {
    assert.equal(entry.params.approvalPolicy, 'never');
    assert.equal(entry.params.approvalsReviewer, 'user');
    assert.match(entry.params.permissions, /^grigdesk-triage-/u);
    assert.equal(entry.params.sandboxPolicy, undefined);
    assert.equal(entry.params.sandbox, undefined);
  }

  // Фикстура проверяет полный именованный профиль и MCP на thread и turn;
  // ответ возможен только при закрытой сети, tmp и точных readable/writable roots.
  assert.equal(messages.some((entry) => entry.method === 'mcpServerStatus/list'), true);
});

test('Bare run и model-only не наследуют Host', async (t) => {
  const f = await hostFixture(t);
  const input = {
    config: f.config,
    cwd: f.cwd,
    permissionMode: 'auto',
    providerSettings: {
      allowHostAccess: true,
      blockDirectSsh: false,
    },
    tokenInfoReader: async () => null,
    message: 'Это не обычный чат',
  };
  const bare = await codex.run(input);
  const untrusted = await codex.runUntrusted(input);
  const messages = await f.messages();
  const starts = messages.filter((entry) => entry.method === 'thread/start');
  const turns = messages.filter((entry) => entry.method === 'turn/start');

  assert.equal(bare.reply, 'Готово');
  assert.equal(untrusted.reply, 'Готово');
  assert.equal(starts.length, 2);
  assert.equal(starts[0].params.sandbox, 'workspace-write');
  assert.equal(starts[0].params.approvalPolicy, 'on-request');
  assert.equal(starts[0].params.approvalsReviewer, 'auto_review');
  assert.equal(turns[0].params.sandboxPolicy.type, 'workspaceWrite');
  assert.equal(starts[1].params.sandbox, 'read-only');
  assert.equal(starts[1].params.ephemeral, true);
  assert.deepEqual(starts[1].params.environments, []);
  assert.deepEqual(starts[1].params.dynamicTools, []);
  assert.deepEqual(turns[1].params.environments, []);
  assert.equal(messages.some((entry) => entry.method === 'thread/resume'), false);
});

for (const allowHostAccess of [false, true]) {
  test(`Host setting не обходит обязательный broker: ${allowHostAccess}`, async (t) => {
    const queue = createPermissionQueue({ timeoutMs: 5000 });
    let executions = 0;
    const session = {
      id: 'write-session',
      projectId: 'fixture-project',
      label: 'Тестовая база',
      role: 'write',
      engine: 'mysql',
      prod: true,
      agentAllowed: true,
      generation: 1,
      readOnlyActive: false,
      handle: {},
    };
    const broker = createDbBroker({
      pluginEnabled: () => true,
      permissionQueue: queue,
      sessions: {
        findForAgent: () => session,
        find: () => session,
        current: () => session,
      },
      engines: {
        get: () => ({
          analyze: async () => ({
            queryClass: 'write',
            single: true,
            tables: ['orders'],
            forbidden: [],
            tableFunctions: [],
          }),
          estimate: async () => ({
            rows: 1,
            bytes: 64,
            timeoutMs: 100,
          }),
          execute: async () => {
            executions += 1;

            return [];
          },
        })
      },
      settings: () => ({
        autoRead: true,
        autoReadProd: true,
        maxRows: 1000,
        timeoutMs: 1000,
      }),
    });
    const tools = createWorkTools({
      projectId: session.projectId,
      chatKey: 'host-chat',
      permissionMode: 'bypassPermissions',
      providerSettings: { allowHostAccess },
      pluginEnabled: () => true,
      dbInvoke: (scope, input) => broker.invoke(scope, input),
    });
    const pending = tools.invoke('supervised_db', {
      action: 'query',
      label: session.label,
      role: session.role,
      text: 'UPDATE orders SET status = ? WHERE id = ?',
      params: ['paid', 1],
    });

    t.after(async () => {
      for (const item of queue.waiting()) {
        await queue.answer(item.pid, 'db', { allow: false });
      }

      await pending;
    });
    await until(() => queue.waiting().some((item) => item.origin === 'db'), 'обязательное решение DB');

    const card = queue.waiting().find((item) => item.origin === 'db');

    assert.equal(executions, 0);
    assert.equal(card.canRemember, false);
    await queue.answer(card.pid, 'db', { allow: false });
    await pending;
    assert.equal(executions, 0, 'Отказ человека не исполняет запись даже при Host');
  });
}
