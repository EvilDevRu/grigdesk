import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  artifactsPath, DATA_LAYOUT, dataHome, dataHomeExplicit, dataPath, envFilePath,
} from '../../shared/runtime/dataHome.ts';
import type { DataHomeEnv } from '../../shared/runtime/dataHome.ts';
import { isolatedEnv } from './helpers/pluginBootFixture.js';
import { LEGACY } from '../../shared/runtime/legacyBrand.ts';

const runtimeHelper = fileURLToPath(new URL('../../deploy/lib/runtime-env.sh', import.meta.url));
const home = '/home/user';
const pathError = /GRIGDESK_HOME должен быть абсолютным путём/;

test('GT-01: сторож снимает все старые переменные окружения', () => {
  const key = `${LEGACY.envPrefix}ENV_FILE`;
  const result = spawnSync('bash', [runner, '-e',
    `process.stdout.write(String(process.env[${JSON.stringify(key)}] ?? ''))`], {
    env: {
      PATH: process.env.PATH,
      HOME: os.tmpdir(),
      [key]: '/should/not/leak',
    },
    encoding: 'utf8',
    timeout: 10000,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('GT-02: сторож не создаёт отсутствующую настоящую папку ради артефактов', (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'grigdesk-empty-home-'));

  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const result = spawnSync('bash', [runner, '-e', `
    const fs = require('node:fs');
    const path = require('node:path');
    const directory = process.env.GRIGDESK_ARTIFACTS_DIR
      || path.join(process.env.GRIGDESK_HOME, 'artifacts');
    fs.mkdirSync(directory, { recursive: true });
  `], {
    env: {
      PATH: process.env.PATH,
      HOME: directory,
    },
    encoding: 'utf8',
    timeout: 10000,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(path.join(directory, '.grigdesk')), false);
});

test('GT-03: сборщик тестового runtime требует явные артефакты при пустом HOME', (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'grigdesk-runtime-home-'));
  const helper = fileURLToPath(new URL('../helpers/deepseekRuntimeArtifact.mts', import.meta.url));

  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [helper], {
    env: {
      PATH: process.env.PATH,
      HOME: directory,
    },
    encoding: 'utf8',
    timeout: 20000,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /GRIGDESK_ARTIFACTS_DIR/);
  assert.equal(existsSync(path.join(directory, '.grigdesk')), false);
});

test('GT-04: движок снимает старые ключи до запуска воркеров', () => {
  const source = readFileSync(new URL('../engine/run-offline.sh', import.meta.url), 'utf8');

  assert.match(source, /compgen -e/);
  assert.match(source, /legacyBrand\.ts/);
  assert.match(source, /unset "\$key"/);
});

const expectedLayout = {
  env: '.env',
  state: 'state',
  log: 'state/grigdesk-server.log',
  cliToken: 'state/cli-token',
  lock: 'state/server.lock',
  pluginData: 'state/plugins',
  uiReleases: 'state/ui-releases',
  deepseekRuntime: 'runtimes/deepseek',
  mobileApk: 'state/mobile-apk',
  mediaVenv: 'state/media-venv',
  mediaHf: 'state/hf',
  mobile: 'mobile',
  chats: 'chats',
  telegram: 'telegram',
  github: 'github',
  studio3d: '3d',
  agents: 'agents',
  plugins: 'plugins',
  profiles: 'profiles',
  artifacts: 'artifacts',
  moveJournal: '.move-journal.json',
  moveLock: '.move-lock',
};

/**
 * Bash получает только окружение проверки и абсолютное имя интерпретатора.
 * Пустой PATH доказывает отсутствие скрытой зависимости от внешних команд.
 */
function bashPath(fn: string, env: DataHomeEnv) {
  return spawnSync('/bin/bash', ['-c', 'set -euo pipefail; source "$1"; "$2"',
    'data-home-test', runtimeHelper, fn], {
    encoding: 'utf8',
    env: {
      HOME: home,
      PATH: '',
      ...env,
    },
  });
}

test('DH-01: папка по умолчанию', () => {
  assert.equal(dataHome({ env: {}, home }), '/home/user/.grigdesk');
});

test('DH-02: конечные слэши удаляются', () => {
  assert.equal(dataHome({ env: { GRIGDESK_HOME: '/data/grigdesk///' }, home }), '/data/grigdesk');
});

test('DH-03: каноническое умолчание остаётся неявным у детей', () => {
  for (const value of ['', '/home/user/.grigdesk', '/home/user/.grigdesk/']) {
    assert.equal(dataHomeExplicit({ env: { GRIGDESK_HOME: value }, home }), false, value);
  }

  assert.equal(dataHomeExplicit({ env: { GRIGDESK_HOME: '/data/x' }, home }), true);
});

test('DH-04: неверные пути отвергаются', () => {
  for (const value of ['relative', '~/x', '/', '/a b', '/данные', '/a/../b', '/a/./b', '/a%b', '/a\0b']) {
    assert.throws(() => dataHome({ env: { GRIGDESK_HOME: value }, home }), pathError, value);
  }
});

test('DH-05: домашний каталог проверяется, ошибка предлагает GRIGDESK_HOME', () => {
  for (const value of ['', 'relative', '/home/u ser']) {
    assert.throws(() => dataHome({ env: {}, home: value }), pathError, value);
  }

  assert.throws(() => dataHome({ env: {}, home: '/home/u ser' }), /задайте GRIGDESK_HOME/);
});

test('DH-06: отдельный файл настроек вычисляется без папки', () => {
  assert.equal(envFilePath({ env: { GRIGDESK_HOME: 'bad', GRIGDESK_ENV_FILE: '/settings/env' }, home }),
    '/settings/env');
  assert.equal(envFilePath({ env: { GRIGDESK_HOME: '/data/c' }, home }), '/data/c/.env');
  assert.equal(envFilePath({ env: {}, home }), '/home/user/.grigdesk/.env');
});

test('DH-07: раскладка содержит ровно 21 относительный путь', () => {
  assert.deepEqual(DATA_LAYOUT, expectedLayout);

  for (const value of Object.values(DATA_LAYOUT)) {
    assert.ok(!value.startsWith('/') && !value.endsWith('/') && !value.includes('..'), value);
  }
});

test('DH-08a: папка артефактов вычисляется без дерева кода', () => {
  assert.equal(artifactsPath({ env: {}, home }), '/home/user/.grigdesk/artifacts');
  assert.equal(artifactsPath({ env: { GRIGDESK_HOME: '/data/c' }, home }), '/data/c/artifacts');
  assert.equal(artifactsPath({ env: { GRIGDESK_HOME: 'bad', GRIGDESK_ARTIFACTS_DIR: '/scratch/a' }, home }),
    '/scratch/a');
});

test('DH-08: пути каждого элемента раскладки', () => {
  for (const key of Object.keys(expectedLayout) as Array<keyof typeof expectedLayout>) {
    assert.equal(dataPath('/data/c', key), `/data/c/${expectedLayout[key]}`);
  }
});

/**
 * Одинаковые входы проходят две независимые реализации контракта.
 * Сравниваются код отказа и результат, без привязки к локали системных утилит.
 */
function checkBashParity(): void {
  for (const value of [undefined, '', '/data/c', '/data/c///', 'relative', '~/x', '/', '/a b']) {
    const env = { GRIGDESK_HOME: value };

    for (const [name, resolve] of [
      ['grigdesk_data_home', dataHome],
      ['grigdesk_env_file', envFilePath],
    ] as const) {
      let expected: string;

      try {
        expected = resolve({ env, home });
      } catch {
        assert.equal(bashPath(name, env).status, 1, `${name}: ${value}`);
        continue;
      }

      const result = bashPath(name, env);

      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), expected);
    }
  }

  assert.equal(bashPath('grigdesk_env_file', {
    GRIGDESK_HOME: 'bad', GRIGDESK_ENV_FILE: '/settings/env',
  }).stdout.trim(), '/settings/env');
  assert.equal(bashPath('grigdesk_data_home', { HOME: undefined }).status, 1);
}

test('DH-09: bash совпадает с TS под set -euo pipefail', checkBashParity);
test('DH-10: вычисление в bash работает с пустым PATH', checkBashParity);

const runner = fileURLToPath(new URL('../run-node-tests-safe.sh', import.meta.url));

test('DH-11: сторож выделяет и удаляет свою временную папку', () => {
  const result = spawnSync('/bin/bash', [runner, '-e',
    "process.stdout.write(process.env.GRIGDESK_HOME ?? '')"], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: os.tmpdir(),
      TMPDIR: os.tmpdir(),
      GRIGDESK_HOME: '/should/not/leak',
    },
    timeout: 10_000,
  });
  const directory = result.stdout.trim();

  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(directory, '/should/not/leak');
  assert.ok(directory.startsWith(os.tmpdir() + '/'), directory);
  assert.equal(existsSync(directory), false);
});

test('DH-11a: сторож передаёт артефакты только существующей папки данных', (t) => {
  const existing = mkdtempSync(path.join(os.tmpdir(), 'grigdesk-existing-data-'));

  t.after(() => rmSync(existing, { recursive: true, force: true }));

  const run = (env: Record<string, string>) => spawnSync('/bin/bash', [runner, '-e',
    "process.stdout.write(process.env.GRIGDESK_ARTIFACTS_DIR ?? '-')"], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: os.tmpdir(),
      ...env,
    },
    timeout: 10_000,
  });

  assert.equal(run({ GRIGDESK_HOME: '/data/real' }).stdout, '-');
  assert.equal(run({ GRIGDESK_HOME: existing }).stdout, `${existing}/artifacts`);
  assert.equal(
    run({ GRIGDESK_HOME: '/data/real', GRIGDESK_ARTIFACTS_DIR: '/scratch/a' }).stdout, '/scratch/a',
  );
  assert.equal(run({ GRIGDESK_HOME: 'bad path' }).stdout, '-');
});

test('DH-12: сбой mktemp останавливает запуск Node', (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'grigdesk-dh-marker-'));
  const marker = path.join(directory, 'started');

  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const result = spawnSync('/bin/bash', [runner, '-e',
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: directory,
      TMPDIR: path.join(directory, 'absent'),
    },
    timeout: 10_000,
  });

  assert.equal(result.status, 2, result.stderr);
  assert.equal(existsSync(marker), false);
});

test('DH-13: общая фикстура задаёт папку данных', () => {
  const root = path.join(os.tmpdir(), 'grigdesk-fixture-contract');

  assert.equal(isolatedEnv(root, 12345).GRIGDESK_HOME, root);
});

test('DH-14: копия boot-фикстуры изолирует папку данных и версии интерфейса', () => {
  const source = readFileSync(new URL('./app-boot-smoke.test.js', import.meta.url), 'utf8');
  const builder = source.slice(source.indexOf('function isolatedEnv('), source.indexOf('async function'));

  assert.match(builder, /GRIGDESK_HOME:\s*root/);
  assert.match(builder, /GRIGDESK_UI_RELEASES_DIR:\s*path\.join\(root,/);
});

test('DH-15 release service требует явный statePath до любых действий', async () => {
  const { GrigDeskReleaseService } = await import('../../server/src/lib/grigDeskRelease.ts');
  const rootDir = fileURLToPath(new URL('../../', import.meta.url));

  assert.throws(() => new GrigDeskReleaseService({ rootDir } as never), /statePath/);
});

test('DH-16 дочерние процессы получают общую папку данных', async () => {
  const { config } = await import('../../server/src/config.ts');
  const { routeLaunchEnv } = await import('../../server/src/lib/factoryRouteCli.ts');
  const { buildHarnessChildEnv } = await import('../../server/src/lib/deepseek/env.ts');

  assert.equal(routeLaunchEnv(config).GRIGDESK_HOME, config.dataHome);
  assert.equal(buildHarnessChildEnv({
    source: { GRIGDESK_HOME: '/tmp/data' },
    dshHome: '/tmp/dsh',
    credential: { name: 'KEY', value: 'fake' },
  }).GRIGDESK_HOME, '/tmp/data');

  for (const relative of ['runnerControl.ts', 'factoryDebug.ts', 'sandboxSlots.ts',
    'factoryLaunch.ts', 'showcase/seed.ts']) {
    const source = new URL('../../server/src/lib/' + relative, import.meta.url);

    assert.match(readFileSync(source, 'utf8'), /GRIGDESK_HOME/);
  }
});


test('DH-18…21 описание установки различает версии 1 и 2', async () => {
  const { parseRuntimeDescriptor } = await import('../../shared/desktop/desktopRuntime.ts');
  const old = {
    version: 1,
    root: '/code',
    node: '/node'
  };
  const next = {
    ...old,
    version: 2,
    home: '/data/grigdesk'
  };

  assert.deepEqual(parseRuntimeDescriptor(JSON.stringify(next)), next);
  assert.deepEqual(parseRuntimeDescriptor(JSON.stringify(old)), old);

  for (const value of [{ ...old, version: 2 }, { ...next, home: 'relative' },
    { ...next, version: 1 }, { ...next, version: 3 }]) {
    assert.equal(parseRuntimeDescriptor(JSON.stringify(value)), null);
  }
});
