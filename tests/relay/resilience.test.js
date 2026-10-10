import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { installCrashHandlers } from '../../relay/src/crash.ts';
import { temporary } from './helpers.js';

test('RL-21: необработанные ошибки дают ограниченный журнал и exit 1', () => {
  const proc = new EventEmitter();
  const logs = [];
  const exits = [];

  installCrashHandlers(proc, {
    log: (value) => logs.push(value),
    exit: (value) => exits.push(value),
  });
  proc.emit('uncaughtException', new Error('secret'));
  proc.emit('unhandledRejection', new Error('secret'));
  assert.deepEqual(logs, ['crash', 'crash']);
  assert.deepEqual(exits, [1, 1]);
});

test('RL-20: вечный цикл дочернего процесса не блокирует внешний watchdog', async (t) => {
  const directory = await temporary(t);
  const childFile = path.join(directory, 'frozen.mjs');
  const pidFile = path.join(directory, 'child.pid');

  await writeFile(
    childFile,
    `import {writeFileSync} from 'node:fs';
    writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    while (true) {}\n`,
  );

  const moduleUrl = new URL('../../relay/src/supervisor.ts', import.meta.url).href;
  const code = `import { supervise } from ${JSON.stringify(moduleUrl)};
    process.exitCode = await supervise({childFile: ${JSON.stringify(childFile)}, watchdogMs: 150});`;
  const started = Date.now();
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'ignore' });

  t.after(() => child.kill('SIGKILL'));

  const exit = await new Promise((resolve) => child.once('exit', resolve));
  const pid = Number(await readFile(pidFile, 'utf8'));

  assert.equal(exit, 1);
  assert.throws(
    () => process.kill(pid, 0),
    (error) => error.code === 'ESRCH',
  );
  assert.equal(Date.now() - started < 3500, true);
});

test('RL-20/RL-22: здоровый heartbeat и штатный SIGTERM завершают supervisor с 0', async (t) => {
  const directory = await temporary(t);
  const childFile = path.join(directory, 'healthy.mjs');

  await writeFile(
    childFile,
    `setInterval(() => process.send({t: 'heartbeat'}), 20);
    process.on('SIGTERM', () => process.exit(0));\n`,
  );

  const moduleUrl = new URL('../../relay/src/supervisor.ts', import.meta.url).href;
  const code = `import { supervise } from ${JSON.stringify(moduleUrl)};
    process.exitCode = await supervise({childFile: ${JSON.stringify(childFile)}, watchdogMs: 200});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'ignore' });

  t.after(() => child.kill('SIGKILL'));
  await new Promise((resolve) => setTimeout(resolve, 450));

  const exited = new Promise((resolve) => child.once('exit', resolve));

  child.kill('SIGTERM');
  assert.equal(await exited, 0);
});
