import assert from 'node:assert/strict';
import test from 'node:test';

import {
  desktopRuntimePath,
  effectivePort,
  effectiveValue,
  parseRuntimeDescriptor,
  stopGraceMs,
} from '../../shared/desktop/desktopRuntime.ts';
import { buildServerEnv, loadServerRuntime } from '../../desktop/src/runtimeConfig.ts';

const RUNTIME_DESCRIPTOR = {
  version: 1,
  root: '/fixture/project',
  node: '/fixture/node/bin/node',
};
const EXPECTED_SERVER_PATH = '/home/user/.kimi-code/bin:/home/user/.local/bin'
  + ':/fixture/node/bin:/usr/bin';

test('RT-01 путь descriptor: абсолютный XDG_DATA_HOME или домашний каталог', () => {
  const home = '/home/user';

  assert.equal(desktopRuntimePath({
    env: { XDG_DATA_HOME: '/fixture/data' },
    home,
  }), '/fixture/data/grigdesk/desktop/runtime.json');

  for (const env of [{}, { XDG_DATA_HOME: '' }, { XDG_DATA_HOME: 'relative/data' }]) {
    assert.equal(desktopRuntimePath({
      env,
      home,
    }), '/home/user/.local/share/grigdesk/desktop/runtime.json');
  }
});

test('RT-02 разбор descriptor: только известная версия и абсолютные пути', () => {
  const descriptor = {
    version: 1,
    root: '/fixture/project',
    node: '/fixture/node',
  };

  assert.deepEqual(parseRuntimeDescriptor(JSON.stringify(descriptor)), descriptor);

  for (const value of [
    {
      ...descriptor,
      extra: true,
    },
    {
      ...descriptor,
      version: 2,
    },
    {
      ...descriptor,
      root: 'relative/project',
    },
    {
      ...descriptor,
      node: 'relative/node',
    },
    {
      ...descriptor,
      root: '/fixture/\0project',
    },
    {
      ...descriptor,
      node: '/fixture/\0node',
    },
    {
      version: 1,
      root: descriptor.root,
    },
    {
      ...descriptor,
      root: null,
    },
    null,
    [],
  ]) {
    assert.equal(parseRuntimeDescriptor(JSON.stringify(value)), null);
  }

  assert.equal(parseRuntimeDescriptor('не JSON'), null);
});

test('RT-03 окружение важнее файла, включая пустую строку и undefined', () => {
  const file = {
    GRIGDESK_PORT: '9100',
    VALUE: 'из файла',
  };

  assert.equal(effectiveValue({ VALUE: 'из окружения' }, file, 'VALUE'), 'из окружения');
  assert.equal(effectiveValue({ VALUE: '' }, file, 'VALUE'), '');
  assert.equal(effectiveValue({ VALUE: undefined }, file, 'VALUE'), undefined);
  assert.equal(effectiveValue({}, file, 'VALUE'), 'из файла');
  assert.equal(effectiveValue({}, file, 'ABSENT'), undefined);
  assert.equal(effectiveValue(Object.create({ VALUE: 'унаследованное' }), file, 'VALUE'), 'из файла');
  assert.equal(effectivePort({ GRIGDESK_PORT: '9200' }, file), 9200);
  assert.equal(effectivePort({}, file), 9100);
  assert.equal(effectivePort({}, {}), 8140);
  assert.equal(effectivePort({ GRIGDESK_PORT: '' }, file), 8140);
  assert.equal(effectivePort({ GRIGDESK_PORT: 'мусор' }, file), 8140);
});

test('RT-04 срок остановки: минимум и запас для настроенного слива', () => {
  assert.equal(stopGraceMs({}, {}), 45_000);
  assert.equal(stopGraceMs({ GRIGDESK_SHUTDOWN_TIMEOUT_MS: '30000' }, {}), 45_000);
  assert.equal(stopGraceMs({ GRIGDESK_SHUTDOWN_TIMEOUT_MS: '60000' }, {}), 75_000);
  assert.equal(stopGraceMs({ GRIGDESK_SHUTDOWN_TIMEOUT_MS: 'мусор' }, {}), 45_000);
  assert.equal(stopGraceMs({}, { GRIGDESK_SHUTDOWN_TIMEOUT_MS: '60000' }), 75_000);
  assert.equal(stopGraceMs({ GRIGDESK_SHUTDOWN_TIMEOUT_MS: '' }, {
    GRIGDESK_SHUTDOWN_TIMEOUT_MS: '60000',
  }), 45_000);
});

/**
 * Подменяет всё чтение установки, включая descriptor и текст настроек.
 * Записанные обращения доказывают выбор путей без чтения файлов этой машины.
 */
function runtimeFixture({
  env = {},
  descriptorText = JSON.stringify(RUNTIME_DESCRIPTOR),
  fileText = null,
  missing = [],
  version = '22.22.1',
} = {}) {
  const home = '/home/user';
  const descriptorPath = desktopRuntimePath({
    env,
    home,
  });
  const parsed = parseRuntimeDescriptor(descriptorText || 'null');
  const data = parsed?.home || env.GRIGDESK_HOME || home + '/.grigdesk';
  const texts = new Map([
    [descriptorPath, descriptorText],
    [env.GRIGDESK_ENV_FILE || data + '/.env', fileText],
  ]);
  const reads = [];
  const checked = [];

  return {
    env,
    home,
    reads,
    checked,
    deps: {
      async readText(file) {
        reads.push(file);

        return texts.get(file) ?? null;
      },
      async exists(file, kind) {
        checked.push(`${kind}:${file}`);

        return !missing.includes(`${kind}:${file}`);
      },
      async nodeVersion() {
        return version;
      },
    },
  };
}

test('RT-05 нет descriptor: отказ с подсказкой установить сервер для приложения', async () => {
  const result = await loadServerRuntime(runtimeFixture({ descriptorText: null }));

  assert.deepEqual(result, {
    problem: 'not_installed',
    message: 'Сервер GrigDesk не установлен для приложения: выполните grigdesk-ctl desktop install.',
  });
});

test('RT-06 битый descriptor: invalid с его путём', async () => {
  const fixture = runtimeFixture({ descriptorText: 'битый JSON' });
  const result = await loadServerRuntime(fixture);

  assert.equal(result.problem, 'invalid');
  assert.ok(result.message.includes(desktopRuntimePath(fixture)));
  assert.ok(result.message.includes('grigdesk-ctl desktop install'));
});

test('RT-07 неполная установка: отказ называет недостающий файл или каталог', async () => {
  for (const [kind, relative] of [
    ['file', 'server/src/app.ts'],
    ['dir', 'server/node_modules'],
    ['file', 'deploy/require-vpn.sh'],
  ]) {
    const result = await loadServerRuntime(runtimeFixture({
      missing: [`${kind}:/fixture/project/${relative}`],
    }));

    assert.equal(result.problem, 'root');
    assert.ok(result.message.includes('/fixture/project'));
    assert.ok(result.message.includes(relative));
  }
});

test('RT-08 проверяется index.html выбранного web dist', async () => {
  for (const env of [{}, { GRIGDESK_WEB_DIST: '/fixture/web-dist' }]) {
    const dist = env.GRIGDESK_WEB_DIST || '/fixture/project/web/dist';
    const fixture = runtimeFixture({
      env,
      missing: [`file:${dist}/index.html`],
    });
    const result = await loadServerRuntime(fixture);

    assert.equal(result.problem, 'web');
    assert.ok(result.message.includes(`${dist}/index.html`));
    assert.ok(fixture.checked.includes(`file:${dist}/index.html`));
  }
});

test('RT-09 исполняемый Node проверяется общей проверкой поддерживаемых версий', async () => {
  assert.equal((await loadServerRuntime(runtimeFixture({
    missing: ['exec:/fixture/node/bin/node'],
  }))).problem, 'node');

  for (const version of [null, '20.1.0', '23.1.0', '22.18.0']) {
    assert.equal((await loadServerRuntime(runtimeFixture({ version }))).problem, 'node');
  }

  for (const version of ['22.19.0', '24.1.0']) {
    assert.ok((await loadServerRuntime(runtimeFixture({ version }))).runtime);
  }
});

test('RT-10 окружение важнее файла: порт, origin, файл настроек, журнал и бюджет', async () => {
  const fixture = runtimeFixture({
    env: {
      GRIGDESK_ENV_FILE: '/fixture/custom.env',
      GRIGDESK_PORT: '9400',
      GRIGDESK_LOG: '/fixture/custom.log',
      GRIGDESK_SHUTDOWN_TIMEOUT_MS: '60000',
    },
    fileText: 'GRIGDESK_PORT=9300\nGRIGDESK_LOG=/fixture/file.log\nGRIGDESK_SHUTDOWN_TIMEOUT_MS=30000\n',
  });
  const result = await loadServerRuntime(fixture);

  assert.ok(result.runtime);
  assert.equal(result.runtime.port, 9400);
  assert.equal(result.runtime.origin, 'http://127.0.0.1:9400');
  assert.equal(result.runtime.logPath, '/fixture/custom.log');
  assert.equal(result.runtime.graceMs, 75_000);
  assert.equal(result.runtime.env.GRIGDESK_PORT, '9400');
  assert.ok(fixture.reads.includes('/fixture/custom.env'));
  assert.equal(fixture.reads.includes('/home/user/.grigdesk/.env'), false);

  const fromFile = await loadServerRuntime(runtimeFixture({
    fileText: 'GRIGDESK_PORT=9300\nGRIGDESK_SHUTDOWN_TIMEOUT_MS=60000\n',
  }));

  assert.equal(fromFile.runtime.port, 9300);
  assert.equal(fromFile.runtime.graceMs, 75_000);
  assert.equal(fromFile.runtime.logPath, '/home/user/.grigdesk/state/grigdesk-server.log');
});

test('RT-11 окружение очищается от AppImage, Electron, systemd и признаков исполнителя', () => {
  const removed = [
    'APPDIR',
    'APPIMAGE',
    'ARGV0',
    'OWD',
    'APPIMAGE_EXTRACT_AND_RUN',
    'CHROME_DESKTOP',
    'FC_FONTATIONS',
    'ELECTRON_RUN_AS_NODE',
    'ELECTRON_EXTRA_FLAG',
    'INVOCATION_ID',
    'JOURNAL_STREAM',
    'SYSTEMD_EXEC_PID',
    'MANAGERPID',
    'NOTIFY_SOCKET',
    'LISTEN_PID',
    'LISTEN_FDS',
    'LISTEN_FDNAMES',
    'CLAUDECODE',
    'GRIGDESK_DESKTOP_DATA_DIR',
  ];
  const parent = {
    ...Object.fromEntries(removed.map((key) => [key, 'след упаковки'])),
    APPDIR: '/tmp/.mount_x',
    PATH: '/tmp/.mount_x:/tmp/.mount_x/usr/sbin:/usr/bin',
    LD_LIBRARY_PATH: '/tmp/.mount_x/usr/lib',
    XDG_DATA_DIRS: '/tmp/.mount_x/share:/usr/share:/tmp/.mount_x-other/share',
    GSETTINGS_SCHEMA_DIR: '/tmp/.mount_x/schemas',
    XDG_CURRENT_DESKTOP: 'из упаковки',
    ORIGINAL_XDG_CURRENT_DESKTOP: 'рабочий стол',
    PRESERVED: 'значение',
  };
  const before = { ...parent };
  const result = buildServerEnv({
    parent,
    dotenv: {},
    node: RUNTIME_DESCRIPTOR.node,
    home: '/home/user',
  });

  for (const key of removed) {
    assert.equal(Object.hasOwn(result, key), false, key);
  }

  assert.equal(result.PATH, EXPECTED_SERVER_PATH);
  assert.equal(Object.hasOwn(result, 'LD_LIBRARY_PATH'), false);
  assert.equal(Object.hasOwn(result, 'GSETTINGS_SCHEMA_DIR'), false);
  assert.equal(result.XDG_DATA_DIRS, '/usr/share:/tmp/.mount_x-other/share');
  assert.equal(result.XDG_CURRENT_DESKTOP, 'рабочий стол');
  assert.equal(Object.hasOwn(result, 'ORIGINAL_XDG_CURRENT_DESKTOP'), false);
  assert.equal(result.PRESERVED, 'значение');
  assert.deepEqual(parent, before);
});

test('RT-14 без APPDIR в окружении каталог пакета берётся из appDir', () => {
  const result = buildServerEnv({
    parent: {
      PATH: '/opt/squashfs-root:/opt/squashfs-root/usr/sbin:/usr/bin',
      LD_LIBRARY_PATH: '/opt/squashfs-root/usr/lib:/usr/lib/extra',
      XDG_DATA_DIRS: '/opt/squashfs-root/usr/share/:/usr/share',
      GSETTINGS_SCHEMA_DIR: '/opt/squashfs-root/usr/share/glib-2.0/schemas',
    },
    dotenv: {},
    node: RUNTIME_DESCRIPTOR.node,
    home: '/home/user',
    appDir: '/opt/squashfs-root',
  });

  assert.equal(result.PATH, EXPECTED_SERVER_PATH);
  assert.equal(result.LD_LIBRARY_PATH, '/usr/lib/extra');
  assert.equal(result.XDG_DATA_DIRS, '/usr/share');
  assert.equal(Object.hasOwn(result, 'GSETTINGS_SCHEMA_DIR'), false);

  const both = buildServerEnv({
    parent: {
      APPDIR: '/tmp/.mount_x',
      PATH: '/tmp/.mount_x:/opt/squashfs-root/usr/sbin:/usr/bin',
    },
    dotenv: {},
    node: RUNTIME_DESCRIPTOR.node,
    home: '/home/user',
    appDir: '/opt/squashfs-root',
  });

  assert.equal(both.PATH, EXPECTED_SERVER_PATH);
});

test('RT-12 PATH повторяет юнит без дублей, NODE_ENV сохраняется, маркер устанавливается', () => {
  const result = buildServerEnv({
    parent: {
      PATH: '/usr/bin:/fixture/node/bin:/home/user/.local/bin:/usr/bin',
      NODE_ENV: 'production',
      GRIGDESK_DESKTOP_CHILD: 'старый маркер',
    },
    dotenv: {},
    node: RUNTIME_DESCRIPTOR.node,
    home: '/home/user',
  });

  assert.equal(result.PATH, EXPECTED_SERVER_PATH);
  assert.equal(result.NODE_ENV, 'production');
  assert.equal(result.GRIGDESK_DESKTOP_CHILD, '1');
  assert.equal(Object.hasOwn(buildServerEnv({
    parent: {},
    dotenv: {},
    node: RUNTIME_DESCRIPTOR.node,
    home: '/home/user',
  }), 'NODE_ENV'), false);
});

test('RT-13 файл дополняет окружение, включая пустые строки, undefined отбрасываются', () => {
  const parent = {
    OVERRIDE: '',
    ABSENT_VALUE: undefined,
  };
  const dotenv = {
    OVERRIDE: 'из файла',
    ABSENT_VALUE: 'из файла',
    FILE_ONLY: 'из файла',
  };
  const result = buildServerEnv({
    parent,
    dotenv,
    node: RUNTIME_DESCRIPTOR.node,
    home: '/home/user',
  });

  assert.equal(result.OVERRIDE, '');
  assert.equal(Object.hasOwn(result, 'ABSENT_VALUE'), false);
  assert.equal(result.FILE_ONLY, 'из файла');
  assert.equal(result.GRIGDESK_DESKTOP_CHILD, '1');
  assert.equal(dotenv.OVERRIDE, 'из файла');
});

test('упакованный интерфейс не зависит от рабочего web/dist', async () => {
  const fixture = runtimeFixture({ missing: ['file:/fixture/project/web/dist/index.html'] });
  const result = await loadServerRuntime({ ...fixture, bundledUi: true });

  assert.ok(result.runtime);
  assert.equal(fixture.checked.includes('file:/fixture/project/web/dist/index.html'), false);
});


test('RC-DH-1 версия 1 выбирает умолчание без навязывания GRIGDESK_HOME ребёнку', async () => {
  const f = runtimeFixture();
  const { runtime } = await loadServerRuntime(f);

  assert.ok(runtime);
  assert.ok(f.reads.includes('/home/user/.grigdesk/.env'));
  assert.equal(runtime.logPath, '/home/user/.grigdesk/state/grigdesk-server.log');
  assert.equal(runtime.uiReleasesDir, '/home/user/.grigdesk/state/ui-releases');
  assert.equal(Object.hasOwn(runtime.env, 'GRIGDESK_HOME'), false);
});

test('RC-DH-2 версия 2 сильнее окружения окна', async () => {
  const f = runtimeFixture({
    descriptorText: JSON.stringify({ 
      ...RUNTIME_DESCRIPTOR, 
      version: 2, 
      home: '/data/descriptor' 
    }),
    env: { GRIGDESK_HOME: '/data/window' },
  });
  const { runtime } = await loadServerRuntime(f);

  assert.ok(runtime);
  assert.ok(f.reads.includes('/data/descriptor/.env'));
  assert.equal(runtime.env.GRIGDESK_HOME, '/data/descriptor');
});

test('RC-DH-3 явные пути из файла и окружения сильнее умолчаний', async () => {
  for (const env of [{}, { 
    GRIGDESK_ENV_FILE: '/custom/env', 
    GRIGDESK_LOG: '/custom/log',
    GRIGDESK_UI_RELEASES_DIR: '/custom/ui' 
  }]) {
    const { runtime } = await loadServerRuntime(runtimeFixture({
      env,
      fileText: 'GRIGDESK_LOG=/file/log\nGRIGDESK_UI_RELEASES_DIR=/file/ui',
    }));

    assert.equal(runtime.logPath, env.GRIGDESK_LOG || '/file/log');
    assert.equal(runtime.uiReleasesDir, env.GRIGDESK_UI_RELEASES_DIR || '/file/ui');
  }
});

test('RC-DH-4 настройки не переназначают папку и файл окружения', async () => {
  for (const key of ['GRIGDESK_HOME', 'GRIGDESK_ENV_FILE']) {
    const result = await loadServerRuntime(runtimeFixture({ fileText: `${key}=/other` }));

    assert.equal(result.problem, 'invalid');
    assert.match(result.message, new RegExp(key));
  }
});
