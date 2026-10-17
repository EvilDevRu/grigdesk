import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { watchdogFromEnv } from '../../relay/src/supervision.ts';
import { temporary } from './helpers.js';

const moduleUrl = new URL('../../relay/src/supervision.ts', import.meta.url).href;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Обвязка изолирует обработчики сигналов сторожа от test runner.
 * Уборка посылает сигнал только своему родителю и PID из своей фикстуры.
 */
async function fixture(t, source, { watchdogMs = 300, command = process.execPath, args = [] } = {}) {
  const directory = path.join(await temporary(t), 'папка с пробелами');

  await mkdir(directory);

  const childFile = path.join(directory, 'child.mjs');
  const pidFile = path.join(directory, 'child.pid');
  const resultFile = path.join(directory, 'result.json');

  await writeFile(childFile, `import { writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    const resultFile = ${JSON.stringify(resultFile)};
    ${source}`);

  const nodeLink = path.join(directory, 'node link');

  await symlink(process.execPath, nodeLink);

  const actualCommand = command === 'link' ? nodeLink : command;
  const code = `import { superviseProcess } from ${JSON.stringify(moduleUrl)};
    process.exitCode = await superviseProcess({
      command: ${JSON.stringify(actualCommand)},
      args: ${JSON.stringify([childFile, ...args])},
      watchdogMs: ${String(watchdogMs)},
    });`;
  const parent = spawn(process.execPath, ['--input-type=module', '-e', code], {
    env: { PATH: process.env.PATH },
    stdio: 'ignore',
  });
  const exited = once(parent, 'exit').then(([code]) => code);

  t.after(async () => {
    parent.kill('SIGKILL');

    try {
      process.kill(Number(await readFile(pidFile, 'utf8')), 'SIGKILL');
    } catch (error) {
      assert.ok(['ESRCH', 'ENOENT'].includes(error.code));
    }
  });

  return {
    parent,
    exited,
    pidFile,
    resultFile,
  };
}

/**
 * Проверяет, что собственный дочерний PID уже исчез после завершения сторожа.
 * Сторож обязан дождаться exit, поэтому дополнительного ожидания здесь нет.
 */
async function assertGone(pidFile) {
  const pid = Number(await readFile(pidFile, 'utf8'));

  assert.throws(() => process.kill(pid, 0), (error) => error.code === 'ESRCH');
}

const healthy = `setInterval(() => process.send({ t: 'heartbeat' }), 50);
  process.on('SIGTERM', () => process.exit(0));`;

test('RL-32: запуск без shell с точными аргументами', async (t) => {
  const args = ['--a b', 'в"кавычках', '$HOME'];
  const box = await fixture(t, 'writeFileSync(resultFile, JSON.stringify(process.argv.slice(2)));', {
    command: 'link',
    args,
  });

  assert.equal(await box.exited, 1);
  assert.deepEqual(JSON.parse(await readFile(box.resultFile, 'utf8')), args);
});

test('RL-33: heartbeat держит ребёнка, SIGTERM даёт 0', async (t) => {
  const box = await fixture(t, healthy);

  await pause(1000);
  assert.equal(box.parent.exitCode, null);

  const pid = Number(await readFile(box.pidFile, 'utf8'));

  assert.doesNotThrow(() => process.kill(pid, 0));
  box.parent.kill('SIGTERM');
  assert.equal(await box.exited, 0);
  await assertGone(box.pidFile);
});

test('RL-34: пропавший heartbeat останавливает ребёнка', async (t) => {
  const box = await fixture(t, `let count = 0;
    setInterval(() => {
      if (count++ < 3) process.send({ t: 'heartbeat' });
    }, 50);
    process.on('SIGTERM', () => process.exit(0));`);
  const started = Date.now();

  assert.equal(await box.exited, 1);
  assert.ok(Date.now() - started < 4000);
  await assertGone(box.pidFile);
});

test('RL-35: неожиданный выход с 0 или 3 требует перезапуска', async (t) => {
  for (const code of [0, 3]) {
    const box = await fixture(t, `process.send({ t: 'heartbeat' }); process.exit(${code});`);

    assert.equal(await box.exited, 1);
    await assertGone(box.pidFile);
  }
});

test('RL-36: нет исполняемого файла — код 1 без висящих таймеров', async (t) => {
  const started = Date.now();
  const box = await fixture(t, healthy, { command: '/несуществующий/relay' });

  assert.equal(await box.exited, 1);
  assert.ok(Date.now() - started < 3000);
});

test('RL-37: неверный watchdog не запускает ребёнка', async (t) => {
  assert.equal(watchdogFromEnv({}), 10000);
  assert.equal(watchdogFromEnv({ RELAY_WATCHDOG_MS: '300' }), 300);

  for (const watchdogMs of [0, -1, 60001, 1.5, NaN]) {
    const box = await fixture(t, healthy, { watchdogMs });

    assert.equal(await box.exited, 2);
    await assert.rejects(() => readFile(box.pidFile), { code: 'ENOENT' });
  }
});
