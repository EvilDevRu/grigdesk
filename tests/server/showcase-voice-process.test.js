// Одноразовый голосовой процесс обязан замечать уже выставленную отмену,
// дожидаться фактического выхода после kill и ограничивать захваченный вывод.
// Подмена — крошечный node-процесс: ни модели, ни GPU эти проверки не трогают.
import assert from 'node:assert/strict';
import test from 'node:test';

import { runWithStdin } from '../../server/src/lib/showcase/voice/process.ts';

test('заранее отменённый запуск завершается сразу, а не ждёт timeout', async () => {
  const controller = new AbortController();

  controller.abort();

  const started = Date.now();

  await assert.rejects(
    () => runWithStdin(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { input: 'ignored', timeoutMs: 5000, signal: controller.signal },
    ),
    (error) => error.code === 'voice_failed' && /отменён/.test(error.message),
  );
  assert.ok(Date.now() - started < 1000, 'готовая отмена замечена до долгой работы');
});

test('stdout и stderr сохраняются только ограниченным хвостом', async () => {
  const result = await runWithStdin(
    process.execPath,
    [
      '-e',
      [
        "process.stdin.resume();",
        "process.stdin.on('end', () => {",
        "  process.stdout.write('o'.repeat(1024 * 1024 + 257));",
        "  process.stderr.write('e'.repeat(1024 * 1024 + 257));",
        '});',
      ].join('\n'),
    ],
    { input: 'go', timeoutMs: 5000 },
  );

  assert.equal(result.stdout.length, 1024 * 1024);
  assert.equal(result.stderr.length, 1024 * 1024);
  assert.match(result.stdout, /^o+$/);
  assert.match(result.stderr, /^e+$/);
});
