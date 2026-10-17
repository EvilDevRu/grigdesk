import assert from 'node:assert/strict';
import test from 'node:test';

import { runCommand } from '../../server/src/lib/pluginInstall/runCommand.ts';

test('RC1: настоящий child возвращает stdout, код и полный result', async () => {
  const result = await runCommand(process.execPath, ['-e', "process.stdout.write('ok'); process.exit(3)"], {
    env: {},
    timeoutMs: 5000,
  });

  assert.deepEqual(result, {
    code: 3,
    signal: null,
    timedOut: false,
    aborted: false,
    stdout: 'ok',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    workspaceLimitExceeded: false,
  });
});

test('RC2: stderr callback получает весь UTF-8, включая разрезанный символ', async () => {
  const chunks = [];
  const script = `
    process.stderr.write(Buffer.from([0xd1]));
    setTimeout(() => {
      process.stderr.write(Buffer.from([0x8f]));
      process.stderr.write(' второе');
    }, 30);
  `;
  const result = await runCommand(process.execPath, ['-e', script], {
    env: {},
    timeoutMs: 5000,
    onStderr: (chunk) => chunks.push(chunk),
  });

  assert.equal(chunks.join(''), 'я второе');
  assert.equal(result.stderr, chunks.join(''));
});

test('RC3: срок команды завершает удерживаемый child до его собственного выхода', async () => {
  const result = await runCommand(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 300)'], {
    env: {},
    timeoutMs: 50,
  });

  assert.equal(result.timedOut, true);
  assert.notEqual(result.code, 0);
});

test('RC4: abort до запуска и после start, ENOENT дают известный результат', async () => {
  const before = new AbortController();

  before.abort();

  const early = await runCommand(process.execPath, ['-e', "process.stdout.write('запущен')"], {
    env: {},
    timeoutMs: 5000,
    signal: before.signal,
  });

  assert.equal(early.aborted, true);
  assert.equal(early.code, 130);
  assert.equal(early.stdout, '');

  const during = new AbortController();
  const script = "process.stderr.write('start'); setInterval(() => {}, 100)";
  const result = await runCommand(process.execPath, ['-e', script], {
    env: {},
    timeoutMs: 5000,
    signal: during.signal,
    onStderr: () => during.abort(),
  });

  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false);

  const missing = await runCommand('/fixture-command-absent', [], { timeoutMs: 1000, env: {} });

  assert.equal(missing.code, 127);
  assert.ok(missing.stderr.length > 0);
});

test('RC5: вывод ограничен хвостом, callback получает полный stderr', async () => {
  let callbackBytes = 0;
  const script = `
    process.stdout.write('x'.repeat(300 * 1024) + 'END');
    process.stderr.write('y'.repeat(300 * 1024) + 'TAIL');
  `;
  const result = await runCommand(process.execPath, ['-e', script], {
    env: {},
    timeoutMs: 5000,
    onStderr: (chunk) => {
      callbackBytes += Buffer.byteLength(chunk);
    },
  });

  assert.ok(Buffer.byteLength(result.stdout) <= 256 * 1024);
  assert.ok(Buffer.byteLength(result.stderr) <= 256 * 1024);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderrTruncated, true);
  assert.equal(result.stdout.endsWith('END'), true);
  assert.equal(result.stderr.endsWith('TAIL'), true);
  assert.equal(callbackBytes, 300 * 1024 + 4);
});

test('RC12: terminal, abort и deadline на одном барьере дают один outcome и снимают listeners', async (t) => {
  const controller = new AbortController();
  const signal = controller.signal;
  let added = 0;
  let removed = 0;
  let finished = 0;
  let callbacks = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);

  signal.addEventListener = (...args) => {
    added += 1;
    add(...args);
  };
  signal.removeEventListener = (...args) => {
    removed += 1;
    remove(...args);
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => t.mock.timers.reset());

  const result = await runCommand(process.execPath, ['-e', "process.stderr.write('end'); process.exit(0)"], {
    env: {},
    timeoutMs: 5000,
    signal,
    ownership: {
      async started() {},
      async finished() {
        finished += 1;
      },
    },
    onStderr() {
      callbacks += 1;
      controller.abort();
      t.mock.timers.tick(5000);
    },
  });

  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, true);
  assert.equal(finished, 1);
  assert.equal(callbacks, 1);
  assert.equal(added, 1);
  assert.equal(removed, 1);

  t.mock.timers.tick(10000);

  assert.equal(finished, 1);
});

test('RC12-IPC: быстрый native exit не теряет outcome до закрытия IPC', async () => {
  for (let index = 0; index < 100; index += 1) {
    const result = await runCommand('/usr/bin/true', [], { timeoutMs: 5000, env: {} });

    assert.equal(result.code, 0, `быстрое завершение ${index}`);
  }
});
