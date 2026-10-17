import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { desktopLaunchOptions } from './e2e/launch.mjs';

const root = '/tmp/desktop-helper-unit';
const dataDir = path.join(root, 'profile');
const keyFile = path.join(root, 'window-auth/key');

test('DW-H1: добавленный env виден в итоговых options, изоляция сохранена', () => {
  const options = desktopLaunchOptions({
    root,
    dataDir,
    env: {
      COCKPIT_WINDOW_KEY_PATH: keyFile,
      COCKPIT_DESKTOP_DATA_DIR: '/tmp/wrong-profile',
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
  assert.equal(options.env.COCKPIT_DESKTOP_DATA_DIR, dataDir);
  assert.equal(options.env.COCKPIT_WINDOW_KEY_PATH, keyFile);
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
    args: ['/tmp/desktop-program', '--cockpit-url=http://127.0.0.1:43210'],
    env: {
      COCKPIT_WINDOW_KEY_PATH: keyFile,
    },
  });
  const second = desktopLaunchOptions({
    root,
    dataDir,
    executablePath: first.executablePath,
    args: first.args,
    env: first.env,
  });

  assert.equal(first.env.COCKPIT_WINDOW_KEY_PATH, keyFile);
  assert.equal(second.env.COCKPIT_WINDOW_KEY_PATH, keyFile);
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
      COCKPIT_WINDOW_KEY_PATH: keyFile,
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
        COCKPIT_WINDOW_KEY_PATH: '/tmp/outside-key',
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
      COCKPIT_WINDOW_KEY_PATH: keyFile,
      COCKPIT_PORT: '43210',
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
    'COCKPIT_WINDOW_KEY_PATH',
    'COCKPIT_PORT',
    'COCKPIT_DESKTOP_DATA_DIR',
    'DESKTOP_TEST_VALUE',
  ]);

  for (const name of Object.keys(options.env)) {
    assert.ok(allowed.has(name), `лишняя переменная ${name}`);
  }

  for (const name of ['INVOCATION_ID', 'NODE_ENV', 'CLAUDECODE', 'FACTORY_HOME', 'OPENAI_API_KEY']) {
    assert.equal(Object.hasOwn(options.env, name), false, name);
  }

  assert.equal(options.env.COCKPIT_PORT, '43210');
  assert.equal(options.env.COCKPIT_WINDOW_KEY_PATH, keyFile);
  assert.equal(options.env.COCKPIT_DESKTOP_DATA_DIR, dataDir);
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
      COCKPIT_WINDOW_KEY_PATH: keyFile,
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
