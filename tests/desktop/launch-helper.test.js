import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createClientRuntime } from '../../desktop/src/clientRuntime.ts';
import { originFromArgs } from '../../desktop/src/connection.ts';
import { normalizeSettings } from '../../desktop/src/settings.ts';
import { desktopLaunchOptions } from './e2e/launch.mjs';

const root = '/tmp/desktop-helper-unit';
const dataDir = path.join(root, 'profile');
const keyFile = path.join(root, 'window-auth/key');

test('DW-H1: добавленный env виден в итоговых options, изоляция сохранена', () => {
  const options = desktopLaunchOptions({
    root,
    dataDir,
    env: {
      GRIGDESK_WINDOW_KEY_PATH: keyFile,
      GRIGDESK_DESKTOP_DATA_DIR: '/tmp/wrong-profile',
      DESKTOP_TEST_VALUE: 'значение фикстуры',
      HOME: '/tmp/wrong-home',
      XDG_DATA_HOME: '/tmp/wrong-data',
      XDG_CONFIG_HOME: '/tmp/wrong-config',
      XDG_CACHE_HOME: '/tmp/wrong-cache',
      XDG_RUNTIME_DIR: '/tmp/wrong-runtime',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/wrong-bus',
      ELECTRON_RUN_AS_NODE: '1',
      NODE_OPTIONS: '--require=/tmp/wrong-hook.cjs',
    },
  });

  assert.equal(options.env.DESKTOP_TEST_VALUE, 'значение фикстуры');
  assert.equal(options.env.GRIGDESK_DESKTOP_DATA_DIR, dataDir);
  assert.equal(options.env.GRIGDESK_WINDOW_KEY_PATH, keyFile);
  assert.equal(options.chromiumSandbox, true);
  assert.equal(Object.hasOwn(options.env, 'NODE_OPTIONS'), false);
  assert.equal(Object.hasOwn(options.env, 'ELECTRON_RUN_AS_NODE'), false);

  for (const name of ['HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
    'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) {
    assert.equal(options.env[name], process.env[name], name);
  }
});

test('DW-H2: второй запуск получает тот же профиль и путь ключа без служебных Node flags', () => {
  const first = desktopLaunchOptions({
    root,
    dataDir,
    args: ['/tmp/desktop-program', '--grigdesk-url=http://127.0.0.1:43210'],
    env: {
      GRIGDESK_WINDOW_KEY_PATH: keyFile,
    },
  });
  const second = desktopLaunchOptions({
    root,
    dataDir,
    executablePath: first.executablePath,
    args: first.args,
    env: first.env,
  });

  assert.equal(first.env.GRIGDESK_WINDOW_KEY_PATH, keyFile);
  assert.equal(second.env.GRIGDESK_WINDOW_KEY_PATH, keyFile);
  assert.deepEqual(second.env, first.env);
  assert.equal(second.executablePath, first.executablePath);
  assert.deepEqual(second.args, first.args);
  assert.equal(second.args.some((value) => /inspect|remote-debugging|no-sandbox/u.test(value)), false);
  assert.equal(Object.hasOwn(second.env, 'NODE_OPTIONS'), false);
  assert.equal(Object.hasOwn(second.env, 'ELECTRON_RUN_AS_NODE'), false);
});

test('DW-H1/пути: профиль и ключ обязательны и остаются внутри абсолютного root', () => {
  const valid = {
    root,
    dataDir,
    env: {
      GRIGDESK_WINDOW_KEY_PATH: keyFile,
    },
  };
  const badInputs = [
    {
      ...valid,
      root: 'relative',
    },
    {
      ...valid,
      dataDir: undefined,
    },
    {
      ...valid,
      dataDir: '/tmp/outside-profile',
    },
    {
      ...valid,
      env: {},
    },
    {
      ...valid,
      env: {
        GRIGDESK_WINDOW_KEY_PATH: '/tmp/outside-key',
      },
    },
  ];

  for (const input of badInputs) {
    assert.throws(() => desktopLaunchOptions(input), /абсолют|внутри|ключ/u);
  }
});

test('DW-H3: isolateEnv берёт системное окружение сессии и только явные добавления', () => {
  const options = desktopLaunchOptions({
    root,
    dataDir,
    isolateEnv: true,
    env: {
      GRIGDESK_WINDOW_KEY_PATH: keyFile,
      GRIGDESK_PORT: '43210',
      DESKTOP_TEST_VALUE: 'значение фикстуры',
    },
  });
  const allowed = new Set([
    'DISPLAY',
    'XAUTHORITY',
    'DBUS_SESSION_BUS_ADDRESS',
    'HOME',
    'XDG_RUNTIME_DIR',
    'XDG_DATA_HOME',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'GSETTINGS_BACKEND',
    'NO_AT_BRIDGE',
    'PLAYWRIGHT_BROWSERS_PATH',
    'LANG',
    'PATH',
    'GRIGDESK_WINDOW_KEY_PATH',
    'GRIGDESK_PORT',
    'GRIGDESK_DESKTOP_DATA_DIR',
    'DESKTOP_TEST_VALUE',
  ]);

  for (const name of Object.keys(options.env)) {
    assert.ok(allowed.has(name), `лишняя переменная ${name}`);
  }

  for (const name of ['INVOCATION_ID', 'NODE_ENV', 'CLAUDECODE', 'FACTORY_HOME', 'OPENAI_API_KEY']) {
    assert.equal(Object.hasOwn(options.env, name), false, name);
  }

  assert.equal(options.env.GRIGDESK_PORT, '43210');
  assert.equal(options.env.GRIGDESK_WINDOW_KEY_PATH, keyFile);
  assert.equal(options.env.GRIGDESK_DESKTOP_DATA_DIR, dataDir);
  assert.equal(options.env.DESKTOP_TEST_VALUE, 'значение фикстуры');
  assert.equal(options.env.PATH, `${path.dirname(process.execPath)}:/usr/bin:/bin`);

  for (const name of ['HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'LANG']) {
    assert.equal(options.env[name], process.env[name], name);
  }
});

test('DW-H4: isolateEnv не даёт добавлениям подменить HOME, XDG_* и DBUS_*', () => {
  const options = desktopLaunchOptions({
    root,
    dataDir,
    isolateEnv: true,
    env: {
      GRIGDESK_WINDOW_KEY_PATH: keyFile,
      HOME: '/tmp/wrong-home',
      XDG_DATA_HOME: '/tmp/wrong-data',
      XDG_RUNTIME_DIR: '/tmp/wrong-runtime',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/wrong-bus',
      ELECTRON_RUN_AS_NODE: '1',
      NODE_OPTIONS: '--require=/tmp/wrong-hook.cjs',
    },
  });

  for (const name of ['HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) {
    assert.equal(options.env[name], process.env[name], name);
  }

  assert.equal(Object.hasOwn(options.env, 'ELECTRON_RUN_AS_NODE'), false);
  assert.equal(Object.hasOwn(options.env, 'NODE_OPTIONS'), false);
});

test('SEA-GUI-FIXTURE: argv свежего SEA-окна выбирает местный профиль и включает supervisor', async (t) => {
  const { seaDesktopArguments } = await import('./e2e/serverSeaFixture.mts');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-sea-desktop-argv-'));
  const server = createServer((_request, response) => response.writeHead(503).end());

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const port = server.address().port;
  const address = `http://127.0.0.1:${port}`;
  const settings = normalizeSettings(null);
  const prepared = [];
  const client = createClientRuntime({
    settings,
    save: async () => {},
    uiDir: temporary,
    secret: 'synthetic-sea-desktop-secret',
    identity: { load: async () => assert.fail('местный профиль не читает ключ устройства') },
    identityDirectory: temporary,
    localAvailable: () => true,
    localAddress: () => address,
    windowKey: async () => '',
    prepareLocal: (profile) => prepared.push(profile.address),
    onOrigin: () => {},
    navigate: async () => {},
  });

  t.after(async () => {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  });

  // Это тот же разбор argv и явный выбор, что main.ts выполняет перед client.start.
  // Свежий профиль без аргумента остаётся на экране машин и не запускает supervisor.
  const argument = originFromArgs(seaDesktopArguments('/fixture/desktop', port));

  if (argument && 'origin' in argument) {
    const profile = await client.profiles.add({
      name: 'Этот компьютер',
      kind: 'local',
      address: argument.origin,
      fp: null,
    });

    await client.profiles.select(profile.id);
  }

  await client.start();

  const state = client.shell.state();

  assert.equal(state.profile?.kind, 'local');
  assert.equal(state.profile?.address, address);
  assert.deepEqual(prepared, [address]);
});
