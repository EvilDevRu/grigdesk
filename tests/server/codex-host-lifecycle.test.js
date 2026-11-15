import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import codex from '../../server/src/lib/executors/codex.ts';
import { hostFixture, until } from '../fixtures/codex-app-server/host-fixture.mjs';
import { hostManager } from '../fixtures/codex-app-server/host-manager.mjs';
import { hostApi } from '../fixtures/codex-app-server/host-api.mjs';

test('Ordinary Codex учитывает scope после exit CLI', async (t) => {
  const f = await hostFixture(t);
  const manager = await hostManager(t, f.root, f.cleanup);
  const input = await f.prepare({ host: false });
  const session = codex.session.open(input);
  const foreign = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);

  f.cleanup(async () => {
    foreign.kill('SIGKILL');
    await manager.heal();
    await session.close();
  });
  await session.send({
    ...input,
    message: 'Первый',
  });
  await session.send({
    ...await f.prepare({ host: false }),
    message: 'Второй',
  });

  const runs = await manager.journal('run');

  assert.equal(runs.length, 1, 'AC9: два send одного ordinary-профиля принадлежат одному scope');
  assert.equal(session.requiresConfirmedClose, true);
  assert.equal(runs[0].args.includes('--property=KillMode=control-group'), true);
  assert.equal(runs[0].args.includes('--property=SendSIGKILL=yes'), true);
  assert.equal(runs[0].args.some((value) => value.startsWith('--property=BindsTo=')), true);
  assert.equal(runs[0].args.some((value) => /sudo/u.test(value)), false);
  process.kill(session.pid, 'SIGTERM');
  await until(() => !session.alive, 'exit собственного CLI');
  await manager.fail();
  await assert.rejects(session.close(), /scope|manager|менеджер|завершен/iu);
  assert.doesNotThrow(() => process.kill(foreign.pid, 0));
  await manager.heal();
  await session.close();
  assert.equal((await manager.journal('run')).length, 1);
  assert.doesNotThrow(() => process.kill(foreign.pid, 0));
});

test('Startup initialize fail оставляет owner для повторного close без позднего turn', async (t) => {
  const f = await hostFixture(t);
  const manager = await hostManager(t, f.root, f.cleanup);
  const input = await f.prepare({ host: false });

  await f.update({ initializeError: true });
  await manager.fail();

  const session = codex.session.open(input);

  f.cleanup(async () => {
    await manager.heal();
    await session.close();
  });
  await assert.rejects(session.send({
    ...input,
    message: 'Не отправлять',
  }), /initialize|инициал/iu);
  assert.equal((await manager.journal('run')).length, 1);
  await assert.rejects(session.close());
  assert.equal((await f.messages()).some((entry) => entry.method === 'turn/start'), false);
  await manager.heal();
  await session.close();
  assert.equal((await manager.journal('run')).length, 1);
});

for (const action of ['close', 'reset', 'delete']) {
  for (const failure of ['error', 'timeout']) {
    test(`Cleanup отказ не сбрасывает и не удаляет чат: ${action}/${failure}`, async (t) => {
      const f = await hostApi(t);
      const chatKey = await f.chat();
      const first = await f.turn(chatKey);

      assert.equal(first.statusCode, 200, first.body);

      const before = await f.history();
      const request = action === 'reset'
        ? {
          method: 'POST',
          url: '/api/chat/session/reset',
          payload: { chatKey },
        }
        : {
          method: 'DELETE',
          url: action === 'close'
            ? `/api/chat/sessions/${chatKey}` : `/api/chat/store/chat/${chatKey}`,
        };

      if (failure === 'timeout') {
        await f.manager.timeout();
      } else {
        await f.manager.fail();
      }

      const rejected = await f.app.inject(request);

      assert.equal(rejected.statusCode, 503, rejected.body);
      assert.equal(rejected.json().error, 'process_cleanup_failed');
      assert.equal((await f.sessions()).sessions.length, 1);
      assert.deepEqual(await f.history(), before);
      await f.manager.heal();

      const retried = await f.app.inject(request);

      assert.equal(retried.statusCode, 200, retried.body);
      assert.equal((await f.sessions()).sessions.length, 0);

      if (action === 'close') {
        assert.deepEqual(await f.history(), before);
      } else if (action === 'reset') {
        assert.equal((await f.history()).sessionId, null);
      } else {
        assert.equal((await f.app.inject(`/api/chat/store/chat/${chatKey}`)).statusCode, 404);
      }
    });
  }
}

test('Смена профиля не открывает новый CLI до успешного повторного cleanup', async (t) => {
  const f = await hostApi(t);
  const chatKey = await f.chat();

  assert.equal((await f.turn(chatKey)).statusCode, 200);
  assert.equal((await f.toggle(true)).statusCode, 200);
  await f.manager.fail();

  const refused = await f.turn(chatKey);

  assert.equal(refused.statusCode, 503, refused.body);
  assert.equal((await f.manager.journal('run')).length, 1);
  assert.equal((await f.sessions()).sessions.length, 1);
  await f.manager.heal();
  assert.equal((await f.app.inject({
    method: 'DELETE',
    url: `/api/chat/sessions/${chatKey}`,
  })).statusCode,
    200);
  assert.equal((await f.turn(chatKey)).statusCode, 200);

  const last = (await f.messages()).filter((entry) => entry.method === 'turn/start').at(-1);

  assert.equal(last.params.sandboxPolicy.type, 'dangerFullAccess');
  assert.equal((await f.manager.journal('run')).length, 2);
});

test('Toggle не прерывает A; B после confirmed close, оба направления и прежний thread', async (t) => {
  const f = await hostApi(t);
  const chatKey = await f.chat();

  for (const host of [true, false]) {
    await f.update({ hold: true });

    const count = (await f.messages()).filter((entry) => entry.method === 'turn/start').length;
    const active = f.turn(chatKey);

    await until(async () => (await f.messages()).filter((entry) =>
      entry.method === 'turn/start').length > count, 'удержанный ход A');

    try {
      const before = await f.messages();
      const ownerCount = (await f.manager.journal('run')).length;
      const switched = await f.toggle(host);

      assert.equal(switched.statusCode, 200, switched.body);
      assert.equal((await f.manager.journal('run')).length, ownerCount);
      assert.equal((await f.manager.journal('stop')).length, host ? 0 : 1);
      assert.equal((await f.messages()).filter((entry) => entry.method === 'turn/interrupt').length, 0);
      assert.deepEqual((await f.messages()).filter((entry) => entry.method === 'turn/start'),
        before.filter((entry) => entry.method === 'turn/start'));
    } finally {
      await f.update({ hold: false });
      await active;
    }

    const next = await f.turn(chatKey);

    assert.equal(next.statusCode, 200, next.body);

    const turns = (await f.messages()).filter((entry) => entry.method === 'turn/start');
    const last = turns.at(-1).params;

    assert.equal(last.sandboxPolicy.type, host ? 'dangerFullAccess' : 'workspaceWrite');
    assert.equal(last.approvalPolicy, host ? 'never' : 'on-request');
    assert.equal(last.approvalsReviewer, host ? 'user' : 'auto_review');
    assert.equal(last.threadId, 'fixture-thread');
    assert.equal((await f.history()).messages.some((item) => item.text === 'Сохранённая переписка'), true);
  }

  const threads = (await f.messages()).filter((entry) => entry.method === 'thread/resume');

  assert.ok(threads.length >= 2);
  assert.ok(threads.every((entry) => entry.params.threadId === 'fixture-thread'));
  assert.equal((await f.manager.journal('run')).length, 3);
});

test('Current права не подменяются next setting в active, SSE и stats', async (t) => {
  const f = await hostApi(t, { host: true });
  const chatKey = await f.chat();

  await f.update({ hold: true });

  const active = f.turn(chatKey);

  await until(async () => (await f.messages()).some((entry) => entry.method === 'turn/start'), 'Host turn');

  try {
    const state = (await f.app.inject('/api/chat/active')).json().active;
    const running = state.find((entry) => entry.chatKey === chatKey);
    const expected = {
      id: 'host',
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      confirmed: true,
    };

    assert.deepEqual(running?.snapshot?.permissionProfile, expected);
    assert.deepEqual((await f.sessions()).sessions[0].permissionProfile, expected);
    assert.equal(f.events.some((entry) => entry.data?.snapshot?.permissionProfile?.confirmed === true), true);
    assert.equal((await f.toggle(false)).statusCode, 200);

    const providers = (await f.app.inject('/api/providers')).json().providers;
    const registry = providers.find((item) => item.id === 'codex');
    const activeRuns = (await f.app.inject('/api/chat/active')).json().active;
    const after = activeRuns.find((item) => item.chatKey === chatKey);

    assert.equal(registry.fixedPermissionProfile, undefined);
    assert.deepEqual(after.snapshot.permissionProfile, expected);
  } finally {
    await f.update({ hold: false });
    await active;
  }
});

test('Per-turn Host удерживает owner при cleanup error и допускает повтор', async (t) => {
  const f = await hostApi(t, { liveEnabled: false });
  const chatKey = await f.chat();

  await f.manager.fail();
  await f.turn(chatKey);

  const sessions = await f.sessions();

  assert.equal(sessions.sessions.length, 1, 'AC10: разовый owner не забывается после отказа cleanup');
  assert.ok(sessions.sessions[0].cleanupError);
  assert.equal((await f.manager.journal('run')).length, 1);
  await f.turn(chatKey);
  assert.equal((await f.manager.journal('run')).length, 1, 'До close новый процесс не запускается');
  await f.manager.heal();
  assert.equal((await f.app.inject({
    method: 'DELETE',
    url: `/api/chat/sessions/${chatKey}`,
  })).statusCode, 200);
  assert.equal((await f.sessions()).sessions.length, 0);
  assert.equal((await f.turn(chatKey)).statusCode, 200);
  assert.equal((await f.sessions()).sessions.length, 0, 'Здоровый разовый процесс между ходами не живёт');
});

test('Send/resume/reopen сохраняют переписку, модель, effort и sessionId', async (t) => {
  const f = await hostApi(t, { host: true });
  const chatKey = await f.chat();

  assert.equal((await f.turn(chatKey)).statusCode, 200);
  assert.equal((await f.turn(chatKey)).statusCode, 200);
  assert.equal((await f.manager.journal('run')).length, 1);

  const before = await f.history();
  const beforeMessages = await f.messages();

  await f.app.close();

  const reopened = await hostApi(t, { fixture: f });
  const saved = await reopened.history();

  assert.equal(reopened.prefs.read().providerSettings.codex.allowHostAccess, true);
  assert.deepEqual(saved.messages, before.messages);
  assert.equal(saved.sessionId, before.sessionId);
  assert.equal((await reopened.turn(chatKey)).statusCode, 200);

  const messages = await f.messages();
  const reopenedMessages = messages.slice(beforeMessages.length);
  const opened = reopenedMessages.find((entry) => ['thread/start', 'thread/resume'].includes(entry.method));
  const resumed = reopenedMessages.find((entry) => Array.isArray(entry.resumedMessages));
  const last = messages.filter((entry) => entry.method === 'turn/start').at(-1).params;

  assert.equal(opened.method, 'thread/resume', 'Reopen возобновляет прежний rollout');
  assert.equal(opened.params.threadId, before.sessionId);
  assert.equal(resumed.resumedMessages.filter((entry) => entry.role === 'assistant').length, 2);
  assert.equal(last.model, 'fixture-model');
  assert.equal(last.effort, 'high');
  assert.equal(last.sandboxPolicy.type, 'dangerFullAccess');
});

test('Stop отличается от close; busy reset/delete защищены, completed effect сохраняется', async (t) => {
  const f = await hostApi(t);
  const chatKey = await f.chat();
  const marker = path.join(f.cwd, 'completed');

  await writeFile(marker, 'внешнее действие уже выполнено');
  await f.update({ hold: true });

  const active = f.turn(chatKey);

  await until(async () => (await f.messages()).some((entry) => entry.method === 'turn/start'), 'долгий ход');

  try {
    const reset = await f.app.inject({
      method: 'POST',
      url: '/api/chat/session/reset',
      payload: { chatKey },
    });
    const removed = await f.app.inject({
      method: 'DELETE',
      url: `/api/chat/store/chat/${chatKey}`,
    });

    assert.equal(reset.statusCode, 409);
    assert.equal(removed.statusCode, 409);

    const stopped = await f.app.inject({
      method: 'POST',
      url: '/api/chat/stop',
      payload: { chatKey },
    });

    assert.equal(stopped.statusCode, 200, stopped.body);
    await active;
    assert.equal((await f.manager.journal('stop')).length, 0, 'Stop прерывает ход, не закрывает scope');
    assert.equal((await f.sessions()).sessions.length, 1);
    await f.update({ hold: false });
    assert.equal((await f.turn(chatKey)).statusCode, 200);
    assert.equal((await f.manager.journal('run')).length, 1);
    assert.equal((await f.app.inject({
      method: 'DELETE',
      url: `/api/chat/sessions/${chatKey}`,
    })).statusCode, 200);
    assert.equal((await f.manager.journal('stop')).length, 1);
    assert.equal(await readFile(marker, 'utf8'), 'внешнее действие уже выполнено');
  } finally {
    await f.update({ hold: false });
    await active;
  }
});
