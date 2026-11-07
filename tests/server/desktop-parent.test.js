import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  attachDesktopParent,
  DESKTOP_CHILD_ENV,
  DESKTOP_RESTART_EXIT_CODE,
} from '../../server/src/lib/desktopParent.ts';
import { freePort, isolatedEnv } from './helpers/pluginBootFixture.js';

const APP_PATH = fileURLToPath(new URL('../../server/src/app.ts', import.meta.url));

/**
 * Даёт собственный канал и перехват выхода вместо настоящего процесса.
 * Счётчик unref проверяет, что IPC не удерживает сервер после подключения координатора.
 */
function parentHarness(env, connected = true) {
  const channel = new EventEmitter();
  const exits = [];
  let unrefs = 0;

  channel.connected = connected;
  channel.channel = {
    unref() {
      unrefs += 1;
    },
  };

  const parent = attachDesktopParent({
    env,
    channel,
    exit: (code) => exits.push(code),
  });

  return {
    channel,
    exits,
    parent,
    get unrefs() {
      return unrefs;
    },
  };
}

test('DP-03 без маркера или подключённого канала режим приложения не включается', () => {
  for (const env of [{}, { [DESKTOP_CHILD_ENV]: '0' }, { [DESKTOP_CHILD_ENV]: undefined }]) {
    const fixture = parentHarness(env);

    assert.equal(fixture.parent, null);
    assert.equal(Object.hasOwn(env, DESKTOP_CHILD_ENV), false);
    assert.equal(fixture.unrefs, 0);
    assert.equal(fixture.channel.listenerCount('disconnect'), 0);
  }

  const env = { [DESKTOP_CHILD_ENV]: '1' };

  assert.equal(attachDesktopParent({
    env,
    channel: null,
    exit: () => assert.fail('выход без канала не требуется'),
  }), null);
  assert.equal(Object.hasOwn(env, DESKTOP_CHILD_ENV), false);

  const disconnectedEnv = { [DESKTOP_CHILD_ENV]: '1' };
  const fixture = parentHarness(disconnectedEnv, false);

  assert.equal(fixture.parent, null);
  assert.equal(Object.hasOwn(disconnectedEnv, DESKTOP_CHILD_ENV), false);
});

test('DP-04 маркер и подключённый канал дают режим приложения и отпускают IPC', () => {
  const env = { [DESKTOP_CHILD_ENV]: '1' };
  const fixture = parentHarness(env);

  assert.ok(fixture.parent, 'ожидается режим приложения');
  assert.equal(Object.hasOwn(env, DESKTOP_CHILD_ENV), false);
  assert.equal(fixture.unrefs, 1);
  assert.equal(fixture.channel.listenerCount('disconnect'), 1);
  assert.equal(fixture.parent.connected, true);
  assert.equal(DESKTOP_RESTART_EXIT_CODE, 75);

  fixture.channel.connected = false;
  assert.equal(fixture.parent.connected, false);
});

test('DP-05 разрыв до bindShutdown сразу выходит с кодом 0', () => {
  const fixture = parentHarness({ [DESKTOP_CHILD_ENV]: '1' });

  fixture.channel.connected = false;
  fixture.channel.emit('disconnect');
  fixture.channel.emit('disconnect');

  assert.deepEqual(fixture.exits, [0]);
});

test('DP-06 разрыв после bindShutdown начинает один штатный слив', async () => {
  const fixture = parentHarness({ [DESKTOP_CHILD_ENV]: '1' });
  const reasons = [];

  fixture.parent?.bindShutdown(async (reason) => {
    reasons.push(reason);
  });
  fixture.channel.connected = false;
  fixture.channel.emit('disconnect');
  fixture.channel.emit('disconnect');
  await Promise.resolve();

  assert.deepEqual(reasons, ['приложение GrigDesk закрылось']);
  assert.deepEqual(fixture.exits, []);
});

/**
 * Поднимает настоящий сервер с IPC и всеми изменяемыми путями в своём каталоге.
 * До рестарта проверяется desktop mode, чтобы старый код не вызвал реальный deploy/restart.sh.
 */
async function bootDesktopServer(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-desktop-parent-'));
  const port = await freePort();
  const mobilePort = await freePort();
  const env = {
    ...isolatedEnv(root, port, mobilePort),
    GRIGDESK_DESKTOP_CHILD: '1',
  };
  const child = spawn(process.execPath, [APP_PATH], {
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const exited = once(child, 'exit');
  const origin = `http://127.0.0.1:${port}`;
  let log = '';

  child.stdout.on('data', (chunk) => {
    log += chunk;
  });
  child.stderr.on('data', (chunk) => {
    log += chunk;
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }

    await rm(root, { recursive: true, force: true });
  });

  const deadline = Date.now() + 30_000;
  let ready = false;

  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const response = await fetch(`${origin}/api/auth/state`, {
        signal: AbortSignal.timeout(1000),
      });

      ready = response.status === 200;
      await response.body?.cancel();

      if (ready) {
        break;
      }
    } catch {}

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.equal(ready, true, `сервер фикстуры должен стать готов: ${log}`);

  return {
    child,
    exited,
    env,
    origin,
  };
}

/**
 * Ограничивает ожидание exit, не дожидаясь закрытия унаследованных stdio.
 * Таймер снимается и при нормальном выходе, и при отказе проверки.
 */
async function desktopExitWithin(fixture, timeoutMs) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });

  try {
    return await Promise.race([fixture.exited, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

test('DP-12 настоящий app.ts с IPC сливается при disconnect (нестабильный)', {
  timeout: 120_000,
}, async (t) => {
  const fixture = await bootDesktopServer(t);

  fixture.child.disconnect();

  assert.deepEqual(await desktopExitWithin(fixture, 45_000), [0, null]);
});

test('DP-13 настоящий app.ts отвечает desktop и выходит с кодом 75 (нестабильный)', {
  timeout: 120_000,
}, async (t) => {
  const fixture = await bootDesktopServer(t);
  const token = (await readFile(fixture.env.GRIGDESK_CLI_TOKEN_PATH, 'utf8')).trim();
  const headers = { 'x-grigdesk-token': token };
  const state = await fetch(`${fixture.origin}/api/system/server`, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });

  assert.equal((await state.json()).mode, 'desktop', 'перед POST требуется режим приложения');

  const response = await fetch(`${fixture.origin}/api/system/restart`, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(10_000),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    mode: 'desktop',
  });
  assert.deepEqual(await desktopExitWithin(fixture, 45_000), [75, null]);
});
