import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function loadModule(relative, contract) {
  try {
    return await import(new URL(relative, import.meta.url));
  } catch (error) {
    assert.fail(`${contract}: ${error.message}`);
  }
}

function exportedFunction(module, names, contract) {
  const operation = names.map((name) => module?.[name]).find((value) => typeof value === 'function')
    || (typeof module?.default === 'function' ? module.default : null);
  assert.equal(typeof operation, 'function', contract);
  return operation;
}

test('срез вывода сохраняет начало и хвост и явно сообщает N из M', async () => {
  const module = await loadModule(
    '../../server/src/lib/ssh/output.ts',
    'ограничитель SSH-вывода ещё не реализован',
  );
  const limit = exportedFunction(
    module,
    ['limitSshOutput', 'limitOutput'],
    'модуль SSH-вывода обязан экспортировать ограничитель',
  );
  const input = 'НАЧАЛО-' + 'x'.repeat(80) + '-ФИНАЛ';
  const totalBytes = Buffer.byteLength(input);
  const result = limit(input, 32);

  assert.deepEqual({
    begins: result.text.startsWith('НАЧАЛО-'),
    ends: result.text.endsWith('-ФИНАЛ'),
    shownBytes: result.shownBytes,
    totalBytes: result.totalBytes,
    truncated: result.truncated,
    notice: (result.notice || result.text).includes(`показано 32 из ${totalBytes}, середина удалена`),
  }, {
    begins: true,
    ends: true,
    shownBytes: 32,
    totalBytes,
    truncated: true,
    notice: true,
  });
});

test('срез вывода не ломает UTF-8 и удаляет ANSI-последовательности', async () => {
  const module = await loadModule(
    '../../server/src/lib/ssh/output.ts',
    'очистка SSH-вывода ещё не реализована',
  );
  const limit = exportedFunction(module, ['limitSshOutput', 'limitOutput'], 'нет ограничителя вывода');
  const result = limit('\u001b[31mошибка🙂ошибка🙂ошибка🙂\u001b[0m', 24);

  assert.deepEqual({
    ansi: /\u001b\[/.test(result.text),
    replacement: result.text.includes('\uFFFD'),
  }, {
    ansi: false,
    replacement: false,
  });
});

test('broker возвращает агенту ограниченный вывод, а не исходный поток', async () => {
  const module = await loadModule(
    '../../server/src/lib/ssh/broker.ts',
    'SSH broker ещё не реализован',
  );
  const createBroker = exportedFunction(
    module,
    ['createSshBroker'],
    'broker.js обязан экспортировать фабрику',
  );
  const output = `НАЧАЛО-${'x'.repeat(200_000)}-ФИНАЛ`;
  const session = {
    id: 'session-a',
    connectionId: 'connection-a',
    projectId: 'project-a',
    label: 'Боевой код',
    role: 'code',
    host: 'server.internal',
    port: 22,
    user: 'deploy',
    agentAllowed: true,
    generation: 7,
  };
  const broker = createBroker({
    pluginEnabled: () => true,
    permissionQueue: {
      enqueue: () => ({ result: Promise.resolve({ allow: true }) }),
    },
    sessions: {
      findForAgent: () => session,
      exec: async () => ({ ok: true, output, exitCode: 0 }),
    },
    audit: { append: async () => {} },
    outputLimitBytes: () => 4_096,
  });

  const result = await broker.invoke(
    { projectId: 'project-a', chatKey: 'chat-a' },
    { action: 'exec', label: 'Боевой код', role: 'code', command: 'journalctl' },
  );

  assert.deepEqual({
    outputBytes: Buffer.byteLength(result.output),
    totalBytes: result.totalBytes,
    shownBytes: result.shownBytes,
    truncated: result.truncated,
    notice: result.notice,
    fullOutputReturned: result.output === output,
  }, {
    outputBytes: 4_096,
    totalBytes: Buffer.byteLength(output),
    shownBytes: 4_096,
    truncated: true,
    notice: `показано 4096 из ${Buffer.byteLength(output)}, середина удалена`,
    fullOutputReturned: false,
  });
});

test('журнал пишет ограниченный результат без пароля с приватными правами', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-ssh-audit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const module = await loadModule(
    '../../server/src/lib/ssh/audit.ts',
    'приватный SSH-журнал ещё не реализован',
  );
  const createAudit = exportedFunction(
    module,
    ['createSshAudit', 'createAudit'],
    'модуль SSH-журнала обязан экспортировать фабрику',
  );
  const password = 'SSH_PASSWORD_SENTINEL_91006';
  const audit = await createAudit({ dir: root, now: () => new Date('2026-08-27T10:00:00.000Z') });
  await audit.append({
    projectId: 'project-a',
    connectionId: 'connection-a',
    sessionId: 'session-a',
    label: 'Боевой код',
    role: 'code',
    host: 'server.internal',
    user: 'deploy',
    command: 'systemctl status app',
    decision: 'allow',
    comment: 'проверить состояние',
    result: 'ok',
    exitCode: 0,
    output: { text: 'active', shownBytes: 6, totalBytes: 6, truncated: false },
    password,
  });
  const page = await audit.list({ limit: 20 });
  const files = await import('node:fs/promises').then(({ readdir }) => readdir(root, { recursive: true }));
  const logName = files.find((name) => name.endsWith('.ndjson'));
  const logPath = path.join(root, logName);
  const raw = await readFile(logPath, 'utf8');
  const rootMode = (await stat(root)).mode & 0o777;
  const fileMode = (await stat(logPath)).mode & 0o777;

  assert.deepEqual({
    page: page.items?.[0] || page[0],
    passwordInFile: raw.includes(password),
    rootMode,
    fileMode,
  }, {
    page: {
      projectId: 'project-a',
      connectionId: 'connection-a',
      sessionId: 'session-a',
      label: 'Боевой код',
      role: 'code',
      host: 'server.internal',
      user: 'deploy',
      command: 'systemctl status app',
      decision: 'allow',
      comment: 'проверить состояние',
      result: 'ok',
      exitCode: 0,
      output: { text: 'active', shownBytes: 6, totalBytes: 6, truncated: false },
      at: '2026-08-27T10:00:00.000Z',
    },
    passwordInFile: false,
    rootMode: 0o700,
    fileMode: 0o600,
  });
});

test('срез ставит видимую метку разрыва и не склеивает голову с хвостом', async () => {
  const module = await loadModule(
    '../../server/src/lib/ssh/output.ts',
    'ограничитель SSH-вывода ещё не реализован',
  );
  const limit = exportedFunction(
    module,
    ['limitSshOutput', 'limitOutput'],
    'модуль SSH-вывода обязан экспортировать ограничитель',
  );
  const lines = Array.from({ length: 400 }, (_, index) => `line-${index}-${'y'.repeat(40)}`);
  const result = limit(lines.join('\n'), 4_096);
  const [head, tail] = result.text.split('\n… середина удалена …\n');

  assert.deepEqual({
    halves: result.text.split('\n… середина удалена …\n').length,
    withinLimit: result.shownBytes <= 4_096,
    headKeepsStart: head.startsWith('line-0-'),
    tailKeepsEnd: tail.endsWith(`line-399-${'y'.repeat(40)}`),
    truncated: result.truncated,
  }, {
    halves: 2,
    withinLimit: true,
    headKeepsStart: true,
    tailKeepsEnd: true,
    truncated: true,
  });
});

test('на крошечном лимите метка разрыва не съедает сам вывод', async () => {
  const module = await loadModule(
    '../../server/src/lib/ssh/output.ts',
    'ограничитель SSH-вывода ещё не реализован',
  );
  const limit = exportedFunction(module, ['limitSshOutput', 'limitOutput'], 'нет ограничителя вывода');
  const result = limit('НАЧАЛО-' + 'x'.repeat(80) + '-ФИНАЛ', 32);

  assert.deepEqual({
    gap: result.text.includes('середина удалена'),
    shownBytes: result.shownBytes,
    begins: result.text.startsWith('НАЧАЛО-'),
    ends: result.text.endsWith('-ФИНАЛ'),
  }, {
    gap: false,
    shownBytes: 32,
    begins: true,
    ends: true,
  });
});
