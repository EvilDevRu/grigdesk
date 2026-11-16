import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const run = promisify(execFile);

test('HTTP-контракт отказа подготовки CLI и защиты переданного запуска', async (t) => {
  // Подмены модулей живут в отдельном процессе с явным флагом Node.
  // Дочерний процесс остаётся в группе сторожа памяти родительского теста.
  const fixture = fileURLToPath(new URL('./fixtures/factory-launch-preparation.mjs', import.meta.url));
  const env = { ...process.env };
  let result;

  // Дочерний harness печатает TAP, а не приватный V8-протокол test worker.
  // Иначе контекст родителя превращает диагностику успешного теста в бинарный поток.
  delete env.NODE_TEST_CONTEXT;

  try {
    result = await run(process.execPath, ['--experimental-test-module-mocks', fixture], {
      env,
      timeout: 90_000,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    assert.fail(`${error.message}\n${error.stdout ?? ''}\n${error.stderr ?? ''}`);
  }

  t.diagnostic(result.stdout);
});
