import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { spawnPty } from '../../server/src/modules/terminal/index.ts';
import { ptyStartEnvironment } from '../../server/src/lib/providerInstall/userCliEnvironment.ts';

function waitFor(check, message, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const value = check();
      if (value) {
        clearInterval(timer);
        resolve(value);
      } else if (Date.now() - started > timeout) {
        clearInterval(timer);
        reject(new Error(message));
      }
    }, 20);
  });
}

/**
 * Fixture PTY сам собирает вывод, чтобы каждый тест не дублировал обработчики.
 * Процесс завершается только свой: helper убивает всю группу shell-а.
 */
function startPty(t, options) {
  const child = spawnPty(options);
  const state = { output: '' };
  const collect = (data) => {
    state.output += data.toString('utf8');
  };

  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  t.after(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // Процесс уже завершён.
    }
  });

  return { child, state };
}

test('PTY helper меняет реальный stty size и не оставляет фоновый процесс', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-pty-'));

  t.after(() => rm(home, { recursive: true, force: true }));

  const { child, state } = startPty(t, { cols: 80, rows: 24, shell: '/bin/sh', home });

  await waitFor(() => child.pid, 'helper не запустился');
  child.stdin.write("stty -echo; printf '__SIZE1__'; stty size; printf '__END1__\\n'\n");
  await waitFor(() => /__SIZE1__24 80\r?\n__END1__/.test(state.output),
    `неверный начальный размер: ${state.output}`);

  child.stdio[3].write(`${JSON.stringify({ t: 'resize', cols: 123, rows: 47 })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 60));
  child.stdin.write("printf '__SIZE2__'; stty size; printf '__END2__\\n'; "
    + "sleep 30 & printf '__PID__%s__\\n' \"$!\"\n");
  await waitFor(() => /__SIZE2__47 123\r?\n__END2__/.test(state.output),
    `resize не дошёл до PTY: ${state.output}`);

  const pid = await waitFor(() => Number(state.output.match(/__PID__(\d+)__/)?.[1]) || 0,
    'pid фонового процесса не получен');

  const exited = new Promise((resolve) => child.once('exit', resolve));

  child.stdio[3].write(`${JSON.stringify({ t: 'close' })}\n`);
  await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error('helper не завершился')), 3000)),
  ]);
  await waitFor(() => {
    try {
      process.kill(pid, 0);

      return false;
    } catch (error) {
      return error.code === 'ESRCH';
    }
  }, `фоновый процесс ${pid} остался после закрытия PTY`, 2000);
});

test('естественный exit shell тоже завершает его фоновые process groups', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-pty-exit-'));

  t.after(() => rm(home, { recursive: true, force: true }));

  const { child, state } = startPty(t, { cols: 80, rows: 24, shell: '/bin/sh', home });
  const exited = new Promise((resolve) => child.once('exit', resolve));

  child.stdin.write("sleep 30 & printf '__NATURAL_PID__%s__\\n' \"$!\"; exit 7\n");

  const pid = await waitFor(
    () => Number(state.output.match(/__NATURAL_PID__(\d+)__/)?.[1]) || 0,
    `pid фонового процесса не получен: ${state.output}`,
  );

  const code = await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error('helper не завершился')), 3000)),
  ]);

  assert.equal(code, 7);
  await waitFor(() => {
    try {
      process.kill(pid, 0);

      return false;
    } catch (error) {
      return error.code === 'ESRCH';
    }
  }, `фоновый процесс ${pid} остался после exit shell`, 2000);
});

test('PTY получает исходный PATH и не наследует служебные переменные сервера', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-pty-env-'));
  const shell = path.join(home, 'shell');
  const marker = JSON.stringify({
    version: 1,
    path: '/usr/bin:/bin',
    npmPrefixLower: '/home/fixture/.npm-global',
    npmPrefixUpper: null,
  });
  const env = ptyStartEnvironment({
    HOME: home,
    PATH: '/opt/grigdesk/runtime/node/bin:/usr/bin:/bin',
    GRIGDESK_USER_CLI_PARENT_V1: marker,
    npm_config_prefix: '/var/lib/grigdesk/state/npm-global',
    NODE_OPTIONS: '--require /opt/grigdesk/hook.mjs',
    SECRET_CANARY: 'kept',
  });

  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(shell, [
    '#!/bin/sh',
    'printf "__PATH__%s__\\n" "$PATH"',
    'printf "__PREFIX__%s__\\n" "${npm_config_prefix-}"',
    'printf "__NODE_OPTIONS__%s__\\n" "${NODE_OPTIONS-unset}"',
    'printf "__MARKER__%s__\\n" "${GRIGDESK_USER_CLI_PARENT_V1-unset}"',
    'printf "__CANARY__%s__\\n" "${SECRET_CANARY-unset}"',
    '',
  ].join('\n'), { mode: 0o755 });

  const { child, state } = startPty(t, {
    cols: 80,
    rows: 24,
    shell,
    home,
    env,
  });

  await waitFor(() => state.output.includes('__CANARY__kept__'),
    `PTY не получил пользовательскую среду: ${state.output}`);

  assert.match(state.output, /__PATH__\/usr\/bin:\/bin__/u);
  assert.match(state.output, /__PREFIX__\/home\/fixture\/\.npm-global__/u);
  assert.match(state.output, /__NODE_OPTIONS__unset__/u);
  assert.match(state.output, /__MARKER__unset__/u);
  assert.equal(child.pid && child.pid > 0, true);
});

test('login shell нового PTY находит ту же fixture-копию, что обычный терминал', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-pty-home-'));
  const bin = path.join(home, 'bin');

  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, 'fixture-cli'),
    '#!/bin/sh\nprintf "__CLI__fixture-cli__\\n"\n', { mode: 0o755 });
  await writeFile(path.join(home, '.bash_profile'), [
    `export PATH="${bin}:/usr/bin:/bin"`,
    'printf "__FOUND__%s__\\n" "$(command -v fixture-cli)"',
    'printf "__NODE_OPTIONS__%s__\\n" "${NODE_OPTIONS-unset}"',
    'printf "__READY__\\n"',
    '',
  ].join('\n'));

  const env = ptyStartEnvironment({
    HOME: home,
    PATH: '/opt/grigdesk/runtime/node/bin:/usr/bin:/bin',
    NODE_OPTIONS: '--require /opt/grigdesk/hook.mjs',
    GRIGDESK_USER_CLI_PARENT_V1: JSON.stringify({
      version: 1,
      path: '/usr/bin:/bin',
      npmPrefixLower: null,
      npmPrefixUpper: null,
    }),
  });
  const { state } = startPty(t, {
    cols: 80,
    rows: 24,
    shell: '/bin/bash',
    home,
    env,
  });

  await waitFor(() => state.output.includes('__READY__'), `login shell не поднялся: ${state.output}`);

  assert.match(state.output, new RegExp(`__FOUND__${bin}/fixture-cli__`, 'u'));
  assert.match(state.output, /__NODE_OPTIONS__unset__/u);
});
