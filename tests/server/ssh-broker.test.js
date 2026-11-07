import assert from 'node:assert/strict';
import test from 'node:test';

import { createPermissionQueue } from '../../server/src/lib/chat/permissionQueue.ts';
import { createSshBroker } from '../../server/src/lib/ssh/broker.ts';

/**
 * Оба проекта имеют одинаковые метку и роль: выбор по имени неоднозначен.
 * Очередь настоящая, а транспорт записывает команды без доступа к сети.
 */
function fixture(t) {
  const sessions = ['a', 'b'].map((key) => ({
    id: `session-${key}`,
    connectionId: `connection-${key}`,
    projectId: `project-${key}`,
    label: 'production',
    role: 'site',
    host: `${key}.example`,
    port: 22,
    user: 'deploy',
    agentAllowed: true,
    generation: 1,
  }));
  const queue = createPermissionQueue();
  const executions = [];
  const audit = [];
  let enabled = true;
  const broker = createSshBroker({
    pluginEnabled: () => enabled,
    permissionQueue: queue,
    sessions: {
      list: () => sessions,
      listForAgent: () => sessions,
      async exec(id, command) {
        executions.push({ id, command });

        return {
          ok: true,
          output: 'done',
          exitCode: 0,
        };
      },
    },
    audit: { append: async (entry) => audit.push(entry) },
  });

  t.after(() => queue.cancelWhere(() => true, { allow: false }));

  return {
    broker,
    sessions,
    queue,
    executions,
    audit,
    disable() {
      enabled = false;
    },
  };
}

test('SSH без проекта перечисляет разрешённые сессии всех проектов без адресов', async (t) => {
  const f = fixture(t);

  f.sessions.push({
    ...f.sessions[0],
    id: 'hidden',
    agentAllowed: false,
  });

  assert.deepEqual(await f.broker.invoke({}, { action: 'list' }), [
    {
      sessionId: 'session-a',
      projectId: 'project-a',
      label: 'production',
      role: 'site',
    },
    {
      sessionId: 'session-b',
      projectId: 'project-b',
      label: 'production',
      role: 'site',
    },
  ]);
  assert.equal(f.queue.waiting().length, 0);
});

test('одинаковые метки требуют ID, а выбранный ID ждёт подтверждения каждого exec', async (t) => {
  const f = fixture(t);
  const scope = { chatKey: 'chat-without-project' };
  const byName = {
    action: 'exec',
    label: 'production',
    role: 'site',
    command: 'id',
  };

  assert.deepEqual(await f.broker.invoke(scope, byName), { ok: false, error: 'ambiguous_session' });
  assert.equal(f.queue.waiting().length, 0);
  assert.equal(f.executions.length, 0);

  const command = {
    action: 'exec',
    sessionId: 'session-b',
    command: 'id',
  };
  const first = f.broker.invoke(scope, command);
  const pending = f.queue.waiting()[0];

  assert.equal(pending.sessionId, 'session-b');
  assert.equal(pending.chatKey, 'chat-without-project');
  assert.equal(pending.canRemember, false);
  assert.equal(pending.presentation.server.host, 'b.example');
  assert.deepEqual(pending.presentation.tab, { projectId: 'project-b', label: 'production · site' });
  assert.equal(f.executions.length, 0);
  await f.queue.answer(pending.pid, 'ssh', { allow: true });
  assert.equal((await first).ok, true);
  assert.deepEqual(f.executions, [{ id: 'session-b', command: 'id' }]);
  assert.equal(f.audit[0].projectId, 'project-b');

  const second = f.broker.invoke(scope, command);
  const next = f.queue.waiting()[0];

  assert.notEqual(next.pid, pending.pid);
  await f.queue.answer(next.pid, 'ssh', { allow: false, comment: 'Не повторять' });
  assert.deepEqual(await second, {
    ok: false,
    error: 'denied',
    comment: 'Не повторять',
  });
  assert.equal(f.executions.length, 1);
  assert.equal(f.audit[1].projectId, 'project-b');
});

test('подтверждение называет вкладку с учётом сессий без допуска агента', async (t) => {
  const f = fixture(t);

  f.sessions.splice(1, 0, {
    ...f.sessions[1],
    id: 'human-only',
    agentAllowed: false,
  });

  const command = 'cd /srv/app && npm test; printf done';
  const run = f.broker.invoke({}, {
    action: 'exec',
    sessionId: 'session-b',
    command,
  });
  const pending = f.queue.waiting()[0];

  assert.deepEqual(pending.presentation.tab, { projectId: 'project-b', label: 'production · site · 2' });
  assert.equal(pending.presentation.command, command);
  await f.queue.answer(pending.pid, 'ssh', { allow: true });
  assert.equal((await run).ok, true);
  assert.deepEqual(f.executions, [{ id: 'session-b', command }]);
});

test('старый селектор работает при одном совпадении и не переходит на новую похожую сессию', async (t) => {
  const f = fixture(t);

  f.sessions.pop();

  const run = f.broker.invoke({}, {
    action: 'exec',
    label: 'production',
    role: 'site',
    command: 'id',
  });
  const pending = f.queue.waiting()[0];

  f.sessions.push({ ...f.sessions[0], id: 'new-session' });
  await f.queue.answer(pending.pid, 'ssh', { allow: true });
  assert.equal((await run).ok, true);
  assert.deepEqual(f.executions, [{ id: 'session-a', command: 'id' }]);
});

test('несовпадающие ID и метка, закрытая сессия и отсутствие допуска не создают ожиданий', async (t) => {
  const f = fixture(t);
  const command = {
    action: 'exec',
    sessionId: 'session-a',
    command: 'id',
  };

  assert.deepEqual(await f.broker.invoke({}, { ...command, label: 'другое имя' }), {
    ok: false, error: 'not_available',
  });
  f.sessions[0].agentAllowed = false;
  assert.deepEqual(await f.broker.invoke({}, command), { ok: false, error: 'not_available' });
  f.sessions.shift();
  assert.deepEqual(await f.broker.invoke({}, command), { ok: false, error: 'not_available' });
  assert.equal(f.queue.waiting().length, 0);
  assert.equal(f.executions.length, 0);
});

for (const change of ['revoked', 'closed', 'replaced', 'generation', 'disabled']) {
  test(`изменение ${change} во время подтверждения не исполняет команду`, async (t) => {
    const f = fixture(t);
    const run = f.broker.invoke({}, {
      action: 'exec',
      sessionId: 'session-a',
      command: 'id',
    });
    const pending = f.queue.waiting()[0];

    if (change === 'revoked') {
      f.sessions[0].agentAllowed = false;
    } else if (change === 'closed') {
      f.sessions.shift();
    } else if (change === 'replaced') {
      f.sessions[0] = { ...f.sessions[0], id: 'replacement' };
    } else if (change === 'generation') {
      f.sessions[0] = { ...f.sessions[0], generation: 2 };
    } else {
      f.disable();
    }

    await f.queue.answer(pending.pid, 'ssh', { allow: true });
    assert.deepEqual(await run, {
      ok: false, error: change === 'disabled' ? 'plugin_disabled' : 'session_lost',
    });
    assert.equal(f.executions.length, 0);
  });
}
