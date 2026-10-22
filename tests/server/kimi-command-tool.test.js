import assert from 'node:assert/strict';
import test from 'node:test';

import { autoDecision } from '../../server/src/lib/chat/autoApprove.ts';
import { createKimiCommandTool } from '../../server/src/lib/kimi/commandTool.ts';

/**
 * Подменяет только запуск процесса, оставляя настоящую проверку команд.
 * Список вызовов доказывает, что отказ не дошёл до системного эффекта.
 */
function fixture(overrides = {}) {
  const calls = [];
  const tool = createKimiCommandTool({
    cwd: '/fixture',
    env: { FIXTURE: '1' },
    settings: { blockDirectSsh: true, blockDirectDb: true },
    permissionMode: 'yolo',
    commandsAllowed: true,
    nativeGuard: async () => true,
    run: async (...args) => {
      calls.push(args);

      return {
        code: 0,
        stdout: 'ok',
        stderr: '',
        timedOut: false,
        aborted: false,
      };
    },
    ...overrides,
  });

  return { tool, calls };
}

test('запрет SSH и внешней БД сильнее yolo, обычная команда доходит до runner', async () => {
  const { tool, calls } = fixture();

  assert.equal((await tool.invoke('run_command', { command: 'mysql -h db.example.invalid' })).error,
    'direct_command_denied');
  assert.equal((await tool.invoke('run_command', { command: 'ssh example.invalid' })).error,
    'direct_command_denied');
  assert.equal(calls.length, 0);
  assert.equal((await tool.invoke('run_command', { command: 'printf ok' })).ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), ['/bin/bash', ['--noprofile', '--norc', '-c', 'printf ok']]);
  assert.equal(calls[0][2].cwd, '/fixture');
  await tool.close();
});

test('исключение и повреждённый verdict не запускают процесс и не ломают следующий вызов', async () => {
  let broken = true;
  const { tool, calls } = fixture({
    evaluate: () => {
      if (broken) {
        throw new Error('fixture failure');
      }

      return { verdict: 'allow', kind: 'other' };
    },
  });

  assert.equal((await tool.invoke('run_command', { command: 'printf ok' })).error, 'policy_unavailable');
  assert.equal(calls.length, 0);
  broken = false;
  assert.equal((await tool.invoke('run_command', { command: 'printf ok' })).ok, true);
  await tool.close();

  const invalid = fixture({ evaluate: () => ({ verdict: 'unexpected' }) });

  assert.equal((await invalid.tool.invoke('run_command', { command: 'printf ok' })).error,
    'policy_unavailable');
  assert.equal(invalid.calls.length, 0);
  await invalid.tool.close();
});

test('отмена ожидающего разрешения закрывает tool без запуска и без позднего allow', async () => {
  let release;
  let entered;
  const asked = new Promise((resolve) => {
    entered = resolve;
  });
  const { tool, calls } = fixture({
    permissionMode: 'auto',
    authorize: () => {
      entered();

      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const pending = tool.invoke('run_command', { command: 'printf ok' });

  await asked;
  await tool.close();
  assert.equal((await pending).error, 'command_cancelled');
  release({ allow: true });
  await Promise.resolve();
  assert.equal(calls.length, 0);
});

test('профиль и входные поля не позволяют обойти серверные cwd/env/policy', async () => {
  const { tool, calls } = fixture();

  for (const extra of [{ cwd: '/' }, { env: {} }, { allow: true }, { timeout_ms: 0 }]) {
    assert.equal((await tool.invoke('run_command', { command: 'printf ok', ...extra })).error,
      'invalid_command');
  }

  assert.equal(calls.length, 0);
  await tool.close();

  const closed = fixture({ commandsAllowed: false });

  assert.equal((await closed.tool.invoke('run_command', { command: 'printf ok' })).error,
    'user_shell_policy_unsupported');
  assert.equal(closed.calls.length, 0);
  await closed.tool.close();
});

test('неразрешённый хост соблюдает строгий режим разбора', async () => {
  for (const strictUnknownDbClient of [false, true]) {
    const { tool, calls } = fixture({
      settings: { blockDirectDb: true, strictUnknownDbClient },
    });
    const result = await tool.invoke('run_command', { command: 'mysql -h "$DB_HOST"' });

    assert.equal(result.ok, !strictUnknownDbClient);
    assert.equal(calls.length, strictUnknownDbClient ? 0 : 1);
    await tool.close();
  }
});

test('обычный отказ человека и некорректное тело не запускают runner', async () => {
  const { tool, calls } = fixture({
    permissionMode: 'auto',
    authorize: async () => ({ allow: false }),
  });

  assert.equal((await tool.invoke('run_command', { command: 'printf ok' })).error, 'permission_denied');

  for (const input of [null, [], 'printf ok']) {
    assert.equal((await tool.invoke('run_command', input)).error, 'invalid_command');
  }

  assert.equal(calls.length, 0);
  await tool.close();
});

test('авто использует штатный классификатор безопасных и опасных команд', async () => {
  const decisions = [];
  const { tool, calls } = fixture({
    permissionMode: 'auto',
    authorize: async (presentation) => {
      const decision = autoDecision(presentation);

      decisions.push(decision.verdict);

      return { allow: decision.verdict === 'allow' };
    },
  });

  assert.equal((await tool.invoke('run_command', { command: 'printf ok' })).ok, true);
  assert.equal((await tool.invoke('run_command', { command: 'rm -rf fixture' })).error, 'permission_denied');
  assert.deepEqual(decisions, ['allow', 'ask']);
  assert.equal(calls.length, 1);
  await tool.close();
});

test('native запрет после разрешения и недоступность readback не запускают процесс', async () => {
  let reads = 0;
  const { tool, calls } = fixture({
    permissionMode: 'manual',
    authorize: async () => ({ allow: true }),
    nativeGuard: async () => ++reads === 1,
  });

  assert.equal((await tool.invoke('run_command', { command: 'printf ok' })).error,
    'native_shell_policy_denied');
  assert.equal(calls.length, 0);
  await tool.close();

  const broken = fixture({
    nativeGuard: async () => {
      throw new Error('Нет native RPC');
    },
  });

  assert.equal((await broken.tool.invoke('run_command', { command: 'printf ok' })).error,
    'native_shell_policy_unavailable');
  assert.equal(broken.calls.length, 0);
  await broken.tool.close();
});
