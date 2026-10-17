import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile }
  from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { windowKeyPath } from '../../shared/desktop/windowKeyPath.ts';
import { registerWindowKeyLifecycle, writeWindowKey } from '../../server/src/lib/windowKey.ts';
import { isolatedEnv, pluginBootFixture } from './helpers/pluginBootFixture.js';

const Fastify = createRequire(new URL('../../server/package.json', import.meta.url))('fastify');

/**
 * onListen асинхронен и не входит в обещание listen, поэтому ждём явное состояние.
 * Срок ограничен, а отсутствие публикации завершается нужным assertion.
 */
async function waitFor(predicate) {
  const deadline = Date.now() + 2000;

  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(predicate(), true, 'Хук onListen не опубликовал ожидаемое состояние');
}

/**
 * Собственный root удаляется после cleanup всех child, зарегистрированных позже.
 * Ни положительный, ни отрицательный контроль не читают рабочий runtime.
 */
async function keyRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-window-key-'));

  t.after(() => rm(root, {
    recursive: true,
    force: true,
  }));

  return root;
}

test('DW-K1: путь явный либо runtime', () => {
  const input = {
    env: {},
    uid: 1234,
    port: 28140,
  };

  assert.equal(windowKeyPath(input), '/run/user/1234/cockpit/window-key-28140');
  assert.equal(windowKeyPath({
    ...input,
    port: 80,
  }), '/run/user/1234/cockpit/window-key-80');
  assert.equal(windowKeyPath({
    ...input,
    uid: 0,
  }), '/run/user/0/cockpit/window-key-28140');
  assert.equal(windowKeyPath({
    ...input,
    port: 65535,
  }), '/run/user/1234/cockpit/window-key-65535');

  const runtime = { XDG_RUNTIME_DIR: '/tmp/own-runtime' };

  assert.equal(windowKeyPath({
    ...input,
    env: runtime,
  }), '/tmp/own-runtime/cockpit/window-key-28140');
  assert.equal(windowKeyPath({
    ...input,
    env: { XDG_RUNTIME_DIR: '/tmp//own/../runtime/' },
  }), '/tmp/runtime/cockpit/window-key-28140');
  assert.equal(windowKeyPath({
    ...input,
    env: { XDG_RUNTIME_DIR: '/' },
  }), '/cockpit/window-key-28140');
  assert.equal(windowKeyPath({
    ...input,
    env: {
      ...runtime,
      COCKPIT_WINDOW_KEY_PATH: '/tmp/own-key',
    },
  }), '/tmp/own-key');

  for (const value of ['', 'relative/key', '/', '/tmp/key/', '/tmp/.', '/tmp/..']) {
    assert.equal(windowKeyPath({
      ...input,
      env: {
        ...runtime,
        COCKPIT_WINDOW_KEY_PATH: value,
      },
    }), null, value);
  }

  for (const value of ['', 'relative/runtime']) {
    assert.equal(windowKeyPath({
      ...input,
      env: { XDG_RUNTIME_DIR: value },
    }), null, value);
  }

  for (const uid of [undefined, -1, 0.5, NaN, Infinity]) {
    assert.equal(windowKeyPath({
      ...input,
      uid,
    }), null);
  }

  for (const port of [0, -1, 1.5, 65536, NaN, Infinity]) {
    assert.equal(windowKeyPath({
      ...input,
      port,
    }), null);
  }
});

test('DW-K7: фикстура использует только собственный ключ', { timeout: 60000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-window-key-'));
  const original = process.env.COCKPIT_WINDOW_KEY_PATH;

  process.env.COCKPIT_WINDOW_KEY_PATH = '/untrusted-parent/window-key';
  t.after(() => {
    if (original === undefined) {
      delete process.env.COCKPIT_WINDOW_KEY_PATH;
    } else {
      process.env.COCKPIT_WINDOW_KEY_PATH = original;
    }
  });

  assert.equal(isolatedEnv(root, 28140).COCKPIT_WINDOW_KEY_PATH,
    path.join(root, 'window-auth/window-key'));

  const override = path.join(root, 'own-window-auth/override-key');
  let observed;
  const fixture = await pluginBootFixture(t, {
    root,
    env: { COCKPIT_WINDOW_KEY_PATH: override },
    before: async ({ env }) => {
      observed = env;
      await mkdir(path.join(root, 'own-window-auth'), { mode: 0o700 });
    },
  });

  t.after(() => rm(root, {
    recursive: true,
    force: true,
  }));

  assert.equal(observed.COCKPIT_WINDOW_KEY_PATH, override);
  assert.strictEqual(fixture.env, observed);
  assert.equal(fixture.env.COCKPIT_WINDOW_KEY_PATH, override);
});

test('DW-K7: внешний или относительный override отвергается до spawn', async (t) => {
  for (const value of ['relative/key', '/outside-fixture/key', '']) {
    let beforeCalled = false;

    await assert.rejects(pluginBootFixture(t, {
      env: { COCKPIT_WINDOW_KEY_PATH: value },
      before: async () => {
        beforeCalled = true;
      },
    }), /Путь ключа.*root/u);
    assert.equal(beforeCalled, false);
  }
});

test('DW-K2: ключ имеет формат и приватные права', async (t) => {
  const root = await keyRoot(t);
  const directory = path.join(root, 'private');
  const file = path.join(directory, 'key');
  const key = await writeWindowKey(file);

  assert.match(key, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal((await readFile(file)).length, 43);
  assert.equal(await readFile(file, 'utf8'), key);
  assert.equal((await lstat(file)).mode & 0o7777, 0o600);
  assert.equal((await lstat(directory)).mode & 0o7777, 0o700);
  assert.deepEqual(await readdir(directory), ['key']);
});

test('DW-K3: ротация атомарно заменяет только свой файл', async (t) => {
  const root = await keyRoot(t);
  const file = path.join(root, 'key');

  await writeFile(file, 'A'.repeat(43), { mode: 0o600 });

  const reader = await open(file, 'r');

  try {
    const key = await writeWindowKey(file);

    assert.match(key, /^[A-Za-z0-9_-]{43}$/u);
    assert.notEqual(key, 'A'.repeat(43));
    assert.equal(await reader.readFile('utf8'), 'A'.repeat(43));
    assert.equal(await readFile(file, 'utf8'), key);
    assert.deepEqual(await readdir(root), ['key']);
  } finally {
    await reader.close();
  }
});

test('DW-K4: ссылки и небезопасные каталоги не изменяются', async (t) => {
  const root = await keyRoot(t);
  const outside = path.join(root, 'outside');
  const control = path.join(outside, 'control');

  await mkdir(outside, { mode: 0o700 });
  await writeFile(control, 'контроль', { mode: 0o644 });
  await symlink(control, path.join(root, 'key-link'));
  await symlink(outside, path.join(root, 'directory-link'));

  await assert.rejects(writeWindowKey(path.join(root, 'key-link')));
  await assert.rejects(writeWindowKey(path.join(root, 'directory-link/new-key')));

  const unsafe = path.join(root, 'unsafe');

  await mkdir(unsafe, { mode: 0o750 });
  await chmod(unsafe, 0o750);
  await assert.rejects(writeWindowKey(path.join(unsafe, 'key')));
  assert.equal((await lstat(unsafe)).mode & 0o7777, 0o750);
  assert.deepEqual(await readdir(unsafe), []);

  const unsafeFile = path.join(root, 'unsafe-key');

  await writeFile(unsafeFile, 'не менять', { mode: 0o644 });
  await assert.rejects(writeWindowKey(unsafeFile));
  await assert.rejects(writeWindowKey(outside));
  assert.equal(await readFile(unsafeFile, 'utf8'), 'не менять');
  assert.equal(await readFile(control, 'utf8'), 'контроль');
  assert.equal((await lstat(control)).mode & 0o7777, 0o644);
  assert.deepEqual(await readdir(outside), ['control']);
});

test('DW-K4: предки выше каталога ключа не проверяются', async (t) => {
  const root = await keyRoot(t);
  const ancestor = path.join(root, 'ancestor');

  await mkdir(ancestor, { mode: 0o755 });
  await symlink(ancestor, path.join(root, 'alias'));

  const file = path.join(root, 'alias/private/key');
  const key = await writeWindowKey(file);

  assert.match(key, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(await readFile(file, 'utf8'), key);
  assert.equal((await lstat(ancestor)).mode & 0o7777, 0o755);
});

test('DW-K5: ошибка записи не оставляет мусора', async (t) => {
  const root = await keyRoot(t);
  const file = path.join(root, 'key');

  await writeFile(file, 'A'.repeat(43), { mode: 0o600 });
  t.mock.method(fs, 'rename', async () => {
    throw new Error('детерминированный отказ rename');
  });

  await assert.rejects(writeWindowKey(file), /отказ rename/u);
  assert.equal(await readFile(file, 'utf8'), 'A'.repeat(43));
  assert.deepEqual(await readdir(root), ['key']);
  await assert.rejects(writeWindowKey(path.join(root, 'missing/private/key')));
  assert.deepEqual(await readdir(root), ['key']);
});

test('DW-K6: неудачный bind не ротирует ключ', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-window-listen-'));
  const first = Fastify({ logger: false });
  const second = Fastify({ logger: false });
  const state = {
    origin: '',
    key: null,
  };
  const secondState = {
    origin: '',
    key: null,
  };
  const file = path.join(root, 'key');
  let secondWrites = 0;

  t.after(async () => {
    await second.close();
    await first.close();
    await rm(root, {
      recursive: true,
      force: true,
    });
  });
  registerWindowKeyLifecycle(first, state, file);
  registerWindowKeyLifecycle(second, secondState, file, async (target) => {
    secondWrites += 1;

    return writeWindowKey(target);
  });
  await first.listen({
    port: 0,
    host: '127.0.0.1',
  });
  await waitFor(() => state.key !== null);

  const previous = await readFile(file, 'utf8');
  const port = first.server.address().port;

  await assert.rejects(second.listen({
    port,
    host: '127.0.0.1',
  }), { code: 'EADDRINUSE' });
  assert.equal(secondWrites, 0);
  assert.equal(secondState.key, null);
  assert.equal(await readFile(file, 'utf8'), previous);
  await first.close();
  assert.equal(await readFile(file, 'utf8'), previous);
});

test('DW-K6: ошибка writer не валит сервер, null не вызывает writer', async (t) => {
  for (const file of ['/own-test-key', null]) {
    const app = Fastify({ logger: false });
    const state = {
      origin: '',
      key: null,
    };
    let calls = 0;

    t.after(() => app.close());
    app.get('/probe', async () => ({ ok: true }));
    registerWindowKeyLifecycle(app, state, file, async () => {
      calls += 1;

      throw new Error('отказ собственного writer');
    });
    await app.listen({
      port: 0,
      host: '127.0.0.1',
    });

    if (file !== null) {
      await waitFor(() => calls === 1);
    }

    assert.equal(calls, file === null ? 0 : 1);
    assert.equal(state.key, null);
    assert.equal((await app.inject('/probe')).statusCode, 200);
  }
});

test('DW-K6: deferred writer публикует память только после файла', async (t) => {
  const app = Fastify({ logger: false });
  const state = {
    origin: '',
    key: null,
  };
  let publish;
  let started = false;
  const pending = new Promise((resolve) => {
    publish = resolve;
  });

  t.after(() => app.close());
  registerWindowKeyLifecycle(app, state, '/own-test-key', async () => {
    started = true;

    return pending;
  });
  await app.listen({
    port: 0,
    host: '127.0.0.1',
  });
  await waitFor(() => started);
  assert.equal(state.key, null);
  publish('A'.repeat(43));
  await waitFor(() => state.key !== null);
  assert.equal(state.key, 'A'.repeat(43));
});
