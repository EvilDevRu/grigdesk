import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { normalizeSettings } from '../../desktop/src/settings.ts';
import { Profiles } from '../../desktop/src/profiles.ts';
import { createShellApi } from '../../desktop/src/pipe/shellApi.ts';
import { startPipe } from '../../desktop/src/pipe/pipeServer.ts';
import { sealUiRelease } from '../../desktop/src/uiRelease.ts';

/**
 * Труба настоящая, upstream и ОС заменены портами без подключения к серверу владельца.
 * Секрет фикстуры существует только в собственной временной папке и заголовке запроса.
 */
async function directoryFixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'onboarding-native-'));
  const uiDir = path.join(root, 'ui');
  const settings = normalizeSettings({
    version: 1,
    connection: { kind: 'local', origin: 'http://127.0.0.1:12345' },
  });
  const profiles = new Profiles({
    settings,
    save: async () => {},
    available: async () => true,
  });
  const calls = [];
  const shell = createShellApi({
    profiles,
    pairing: { addByPairing: async () => {
      throw new Error('Не используется');
    } },
    localAvailable: () => true,
    localAddress: () => 'http://127.0.0.1:12345',
    navigate: async () => {},
    ...(options.absent ? {} : {
      selectDirectory: async (...args) => {
        calls.push(args);

        return options.select ? options.select(...args) : path.join(root, 'selected');
      },
    }),
    upstream: (_profile, report) => ({
      request() {},
      upgrade() {},
      state: () => ({}),
      close() {},
      async probe() {
        report({
          status: 'online',
          detail: null,
          serverApi: { major: 0, minor: 1 },
        });
      },
    }),
  });

  await mkdir(uiDir);
  await writeFile(path.join(uiDir, 'index.html'), '<main>Фикстура выбора папки</main>');
  await sealUiRelease(uiDir);
  await shell.connect();

  const pipe = await startPipe({
    port: 0,
    uiDir,
    secret: 'onboarding-native-fixture',
    appApi: { major: 0, minor: 1 },
    upstream: null,
    shell,
  });

  t.after(async () => {
    shell.close();
    await pipe.close();
    await rm(root, { recursive: true, force: true });
  });

  const headers = { cookie: 'grigdesk_pipe=onboarding-native-fixture' };
  const send = (body, extra = {}) => fetch(`${pipe.origin}/__shell/directory/select`, {
    method: 'POST',
    headers: {
      ...headers,
      'content-type': 'application/json',
      ...extra,
    },
    body: JSON.stringify(body),
  });

  return {
    root,
    pipe,
    shell,
    settings,
    profiles,
    calls,
    headers,
    send,
  };
}

/**
 * Ожидание точки входа диалога ограничено и не опирается на скорость планировщика.
 * Освобождение gate всегда остаётся за тестом, в том числе при провале assertion.
 */
async function untilEntered(calls) {
  const deadline = Date.now() + 2000;

  while (calls.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(calls.length, 1, 'native callback должен начать диалог');
}

test('ONB-DIR-01: настоящий адаптер возвращает путь и null при отмене', async () => {
  const url = new URL('../../desktop/src/directorySelection.ts', import.meta.url);

  assert.ok(existsSync(url), 'Нет адаптера системного выбора каталога');

  const { createDirectorySelector } = await import(url.href);
  const calls = [];
  const parent = {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, getURL: () => 'http://127.0.0.1:47100/' },
  };
  let canceled = false;
  const select = createDirectorySelector({
    getWindow: () => parent,
    showOpenDialog: async (window, options) => {
      calls.push({ window, options });

      return { canceled, filePaths: canceled ? [] : ['/fixture/selected'] };
    },
  });

  assert.equal(await select('http://127.0.0.1:47100'), '/fixture/selected');
  canceled = true;
  assert.equal(await select('http://127.0.0.1:47100'), null);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].window, parent);
  assert.deepEqual(calls[0].options.properties, ['openDirectory']);
  assert.equal(calls[0].options.defaultPath, undefined);
});

test('ONB-DIR-02: capability local, remote, старый desktop и неверное тело', async (t) => {
  const f = await directoryFixture(t);
  const state = await fetch(`${f.pipe.origin}/__shell/state`, { headers: f.headers });

  assert.ok((await state.json()).capabilities.includes('selectDirectory'), 'Нет capability выбора папки');

  const selected = await f.send({ profileId: f.settings.selected });

  assert.equal(selected.status, 200);
  assert.equal((await selected.json()).path, path.join(f.root, 'selected'));
  f.calls.length = 0;

  for (const body of [{}, { profileId: 'unknown' }, { profileId: f.settings.selected, path: '/etc' }]) {
    const response = await f.send(body);

    assert.ok([400, 409].includes(response.status), `Отказ тела: ${response.status}`);
  }

  const profile = f.settings.profiles.find((item) => item.id === f.settings.selected);

  profile.kind = 'remote';
  assert.equal((await f.send({ profileId: profile.id })).status, 409);
  assert.equal(f.calls.length, 0);

  const old = await directoryFixture(t, { absent: true });
  const oldState = await fetch(`${old.pipe.origin}/__shell/state`, { headers: old.headers });

  assert.equal((await oldState.json()).capabilities.includes('selectDirectory'), false);
  assert.equal((await old.send({ profileId: old.settings.selected })).status, 404);
  assert.equal(old.calls.length, 0);
});

test('ONB-DIR-03: чужие cookie и Origin отклонены до native, смена машины скрывает путь', async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const f = await directoryFixture(t, { select: async () => {
    await gate;

    return '/fixture/private';
  } });
  const state = await fetch(`${f.pipe.origin}/__shell/state`, { headers: f.headers });

  assert.ok((await state.json()).capabilities.includes('selectDirectory'), 'Нет capability выбора папки');

  const body = { profileId: f.settings.selected };

  assert.equal((await f.send(body, { cookie: 'grigdesk_pipe=foreign' })).status, 403);
  assert.equal((await f.send(body, { origin: 'https://foreign.invalid' })).status, 403);
  assert.equal(f.calls.length, 0);

  const pending = f.send(body);

  try {
    await untilEntered(f.calls);
    f.settings.selected = null;
  } finally {
    release();
  }

  const response = await pending;

  assert.equal(response.status, 409);
  assert.equal((await response.text()).includes('/fixture/private'), false);
});

test('ONB-DIR-03: смена окна или frame origin во время диалога скрывает путь', async () => {
  const url = new URL('../../desktop/src/directorySelection.ts', import.meta.url);

  assert.ok(existsSync(url), 'Нет адаптера системного выбора каталога');

  const { createDirectorySelector } = await import(url.href);

  for (const change of ['origin', 'identity', 'destroyed']) {
    let origin = 'http://127.0.0.1:47100/';
    let destroyed = false;
    let current = {
      isDestroyed: () => destroyed,
      webContents: { isDestroyed: () => destroyed, getURL: () => origin },
    };
    const select = createDirectorySelector({
      getWindow: () => current,
      showOpenDialog: async () => {
        if (change === 'origin') {
          origin = 'https://foreign.invalid/';
        } else if (change === 'identity') {
          current = { ...current };
        } else {
          destroyed = true;
        }

        return { canceled: false, filePaths: ['/fixture/private'] };
      },
    });

    await assert.rejects(() => select('http://127.0.0.1:47100'));
  }
});
