import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const wrapper = path.resolve(import.meta.dirname, 'isolated-session.sh');

/**
 * Проверка ждёт exit оболочки и сверяет только пути и PID, выданные данным запуском.
 * Содержимое пользовательской связки ключей и чужие каталоги не читаются.
 */
async function runSession(args, env, cancel = false) {
  const child = spawn('bash', [wrapper, ...args], { env: { ...process.env, ...env } });
  let output = '';

  child.stdout.on('data', (part) => {
    output += part;

    if (cancel && output.includes('COMMAND_READY')) {
      child.kill('SIGTERM');
    }
  });
  child.stderr.on('data', (part) => {
    output += part;
  });

  const code = await new Promise((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });

  for (const name of ['SESSION_HOME', 'SESSION_RUNTIME']) {
    const value = output.match(new RegExp(name + '=(.*)'))?.[1];

    if (value) {
      await assert.rejects(stat(value), /ENOENT/);
    }
  }

  for (const match of output.matchAll(/(?:SESSION|KEYRING)_PID=(\d+)/g)) {
    assert.throws(() => process.kill(Number(match[1]), 0), /ESRCH/);
  }

  return { code, output };
}

async function run(args, env, cancel = false) {
  return (await runSession(args, env, cancel)).code;
}

/**
 * Ждёт исчезновения процесса по PID не дольше срока: медленный хвост после уборки
 * должен успеть проявиться, прежде чем тест проверит каталоги сессии.
 */
async function waitGone(pid, limitMs) {
  const deadline = Date.now() + limitMs;

  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test('Изоляция: argv с пробелами, коды выхода, отсутствие аргументов и TERM', async () => {
  assert.equal(await run([]), 2);
  assert.equal(await run(['bash', '-c', 'test "$1" = "два слова"', 'проверка', 'два слова']), 0);
  assert.equal(await run(['bash', '-c', 'exit 7']), 7);
  assert.equal(await run(['bash', '-c', 'echo COMMAND_READY; sleep 30'], {}, true), 143);
});

test('Изоляция: общий кэш браузеров Playwright виден из временного HOME', async () => {
  const cacheRoot = process.env.XDG_CACHE_HOME || path.join(process.env.HOME, '.cache');
  const shared = path.join(cacheRoot, 'ms-playwright');
  const check = ['bash', '-c', 'test "$PLAYWRIGHT_BROWSERS_PATH" = "$1"', 'проверка'];

  // Без явной переменной путь берётся из настоящего HOME, а не из временного каталога сессии.
  assert.equal(await run([...check, shared], { PLAYWRIGHT_BROWSERS_PATH: undefined }), 0);
  // Явно заданный путь передаётся внутрь без изменений.
  assert.equal(await run([...check, '/opt/браузеры'], { PLAYWRIGHT_BROWSERS_PATH: '/opt/браузеры' }), 0);
});

test('Изоляция: недоступный keyring не запускает дочернюю команду', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'desktop-isolation-stub-'));
  const marker = path.join(directory, 'unexpected');

  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'gnome-keyring-daemon'), '#!/bin/bash\nexit 1\n', { mode: 0o700 });

  const code = await run(['bash', '-c', 'touch "$1"', 'проверка', marker], {
    PATH: directory + ':' + process.env.PATH,
  });

  assert.notEqual(code, 0);
  await assert.rejects(stat(marker), /ENOENT/);
});

test('Изоляция: служба сессии, медленно выходящая после TERM, дожидается уборки', async (t) => {
  // Так ведут себя службы, которые D-Bus сессии запускает по запросу (portal с FUSE-точкой):
  // они в группе сессии, но не дети оболочки и после TERM ещё пишут в runtime-каталог.
  const late = [
    '(trap \'sleep 1; mkdir -p "$XDG_RUNTIME_DIR/late"; exit 0\' TERM;',
    'echo LATE_PID=$BASHPID; while :; do sleep 0.1; done) & sleep 0.3',
  ].join(' ');
  const { code, output } = await runSession(['bash', '-c', late]);
  const latePid = Number(output.match(/LATE_PID=(\d+)/)?.[1]);
  const runtime = output.match(/SESSION_RUNTIME=(.*)/)?.[1];

  t.after(async () => {
    try {
      process.kill(latePid, 'SIGKILL');
    } catch {
      // Процесс уже завершён: уборка обёртки сработала.
    }

    if (runtime) {
      await rm(runtime, { recursive: true, force: true });
    }
  });

  assert.equal(code, 0);
  assert(latePid > 0 && runtime, output);
  assert.throws(() => process.kill(latePid, 0), /ESRCH/);

  await waitGone(latePid, 3000);
  await assert.rejects(stat(runtime), /ENOENT/);
});
