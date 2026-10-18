import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { isNodeVersionSupported } from '../../server/src/lib/nodeVersion.ts';
import { LEGACY, LEGACY_DATA_PATHS } from '../../shared/runtime/legacyBrand.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const helper = path.join(root, 'deploy', 'lib', 'runtime-env.sh');
const probe = String.raw`
set -euo pipefail
source "$1"
grigdesk_load_runtime_env "$2"
printf '%s\n' "$GRIGDESK_EFFECTIVE_PORT"
`;

const pathProbe = String.raw`
set -euo pipefail
source "$1"
HOME="$2"
PATH="/usr/bin:/bin"
grigdesk_add_cli_paths
grigdesk_add_cli_paths
printf '%s\n' "$PATH"
`;

test('GE-07: запускалки отвергают старые ключи корней с кодом 78', (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'grigdesk-old-env-'));

  t.after(() => rmSync(home, { recursive: true, force: true }));

  for (const suffix of ['HOME', 'ENV_FILE']) {
    for (const command of ['grigdesk_load_runtime_env', 'grigdesk_require_migrated']) {
      const result = spawnSync('bash', ['-c', 'source "$1"; "$2" "$3"',
        '_', helper, command, home], {
        env: {
          PATH: process.env.PATH,
          HOME: home,
          [`${LEGACY.envPrefix}${suffix}`]: '/forbidden',
        },
        encoding: 'utf8',
      });

      assert.equal(result.status, 78, result.stderr);
      assert.match(result.stderr, new RegExp(`GRIGDESK_${suffix}`));
      assert.equal(existsSync(path.join(home, '.grigdesk')), false);
    }
  }
});

test('GB-07: bash сохраняет отказы матрицы папки данных', (t) => {
  for (const layout of ['old', 'both', 'internal']) {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'grigdesk-home-matrix-'));
    const home = path.join(directory, 'home');
    const code = path.join(directory, 'code');

    t.after(() => rmSync(directory, { recursive: true, force: true }));
    mkdirSync(home);
    mkdirSync(code);

    if (layout !== 'internal') {
      mkdirSync(path.join(home, LEGACY.dataHomeDir));
    }

    if (layout !== 'old') {
      mkdirSync(path.join(home, '.grigdesk'));
    }

    if (layout === 'internal') {
      const file = path.join(home, '.grigdesk', LEGACY_DATA_PATHS[1][0]);

      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, '{}');
    }

    const result = spawnSync('bash', ['-c', 'source "$1"; grigdesk_require_migrated "$2"',
      '_', helper, code], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
      },
      encoding: 'utf8',
    });

    assert.equal(result.status, 78, `${layout}: ${result.stderr}`);
    assert.match(result.stderr, /mv -T|две папки данных|brandMove.mts --apply/);
  }
});

test('общий preflight соблюдает Node compatibility встроенного DeepSeek', () => {
  const versionProbe = String.raw`
source "$1"
node() {
  printf '%s\n' "$DSH_TEST_NODE_VERSION"
}
grigdesk_require_node
`;

  for (const version of ['20.19.0', '22.18.0', '23.0.0']) {
    assert.equal(isNodeVersionSupported(version), false, version);
    assert.throws(() => execFileSync('bash', ['-c', versionProbe, 'node-version-test', helper], {
      env: { ...process.env, DSH_TEST_NODE_VERSION: version },
      stdio: 'pipe',
    }));
  }

  for (const version of ['22.19.0', '22.22.1', '24.0.0', '26.1.0']) {
    assert.equal(isNodeVersionSupported(version), true, version);
    execFileSync('bash', ['-c', versionProbe, 'node-version-test', helper], {
      env: { ...process.env, DSH_TEST_NODE_VERSION: version },
      stdio: 'pipe',
    });
  }
});

/**
 * Проба читает только env временного корня и переданные значения порта.
 * Настройки живого GrigDesk и старые effective-переменные не наследуются.
 */
function ports(dir, extraEnv = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: dir,
    ...extraEnv,
  };

  if (env.GRIGDESK_PORT === null) {
    delete env.GRIGDESK_PORT;
  }

  return execFileSync('bash', ['-c', probe, 'runtime-env-test', helper, dir], {
    encoding: 'utf8',
    env,
  }).trim();
}

test('runtime env читает нестандартный порт из файла папки данных без исполнения shell-кода', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'grigdesk-runtime-env-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const marker = path.join(dir, 'must-not-exist');

  mkdirSync(path.join(dir, '.grigdesk'), { recursive: true });
  writeFileSync(path.join(dir, '.grigdesk/.env'), [
    'GRIGDESK_PORT=18140',
    `UNRELATED=$(touch ${marker})`,
  ].join('\n'));

  assert.equal(ports(dir), '18140');
  assert.equal(existsSync(marker), false);
});

test('экспортированный порт имеет приоритет над файлом папки данных', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'grigdesk-runtime-env-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.grigdesk'), { recursive: true });
  writeFileSync(path.join(dir, '.grigdesk/.env'), 'GRIGDESK_PORT=18140\n');

  assert.equal(ports(dir, {
    GRIGDESK_PORT: '28140',
  }), '28140');
});

test('штатные launcher-ы добавляют CLI установки и пользовательские bin в PATH один раз', (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'grigdesk-kimi-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const value = execFileSync('bash', ['-c', pathProbe, 'runtime-env-test', helper, home], {
    encoding: 'utf8',
  }).trim();

  assert.equal(value, `${root}/bin:${home}/.local/bin:${home}/.kimi-code/bin:/usr/bin:/bin`);
});

test('существующий bin текущей установки сохраняет приоритет над старыми CLI-ссылками', (t) => {
  // Собранный bin/b24 этого checkout не обязателен: проверяем PATH на временном корне кода.
  const code = mkdtempSync(path.join(os.tmpdir(), 'grigdesk-cli-priority-'));

  t.after(() => rmSync(code, { recursive: true, force: true }));
  mkdirSync(path.join(code, 'bin'));
  writeFileSync(path.join(code, 'bin/b24'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  const value = execFileSync('bash', ['-c', String.raw`
set -euo pipefail
source "$1"
HOME="$2/home"
PATH="$2/bin:/usr/bin:/bin:$2/bin"
grigdesk_add_cli_paths "$2"
command -v b24
printf '%s\n' "$PATH"
`, 'runtime-env-priority-test', helper, code], { encoding: 'utf8' }).trim().split('\n');

  assert.equal(value[0], path.join(code, 'bin/b24'));
  assert.equal(value[1].split(':')[0], path.join(code, 'bin'));
  assert.equal(value[1].split(':').filter((entry) => entry === path.join(code, 'bin')).length, 1);
});

test('старый TLS-порт не участвует в расчёте effective-порта', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'grigdesk-runtime-env-'));

  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.grigdesk'), { recursive: true });
  writeFileSync(path.join(dir, '.grigdesk/.env'), 'GRIGDESK_TLS_PORT=9443\n');

  const output = execFileSync('bash', ['-c', probe, 'runtime-env-test', helper, dir], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir },
  }).trim();

  assert.equal(output, '8140');
});


test('RE-DH-1/2 явная папка и файл настроек имеют приоритет', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'grigdesk-env-priority-'));
  const data = path.join(dir, 'data');

  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(data);
  writeFileSync(path.join(data, '.env'), 'GRIGDESK_PORT=18444');
  writeFileSync(path.join(dir, 'custom.env'), 'GRIGDESK_PORT=18445');
  assert.equal(ports(dir, { GRIGDESK_HOME: data }), '18444');
  assert.equal(ports(dir, {
    GRIGDESK_HOME: data, GRIGDESK_ENV_FILE: path.join(dir, 'custom.env'),
  }), '18445');
});

test('RE-DH-3 зарезервированные ключи отвергаются', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'grigdesk-env-reserved-'));

  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.grigdesk'));

  for (const key of ['GRIGDESK_HOME', 'GRIGDESK_ENV_FILE']) {
    writeFileSync(path.join(dir, '.grigdesk/.env'), `${key}=`);
    assert.throws(() => ports(dir), /запрещён/);
  }
});

test('RE-DH-4 проверка запускалки не создаёт данных и отказывает старой раскладке', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'grigdesk-require-move-'));
  const code = path.join(dir, 'code');
  const home = path.join(dir, 'home');

  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(code);
  mkdirSync(home);

  const run = () => spawnSync('bash', ['-c',
    'source "$1"; grigdesk_require_migrated "$2"', '_', helper, code], {
    env: { 
      PATH: process.env.PATH, 
      HOME: home, 
      NODE_ENV: 'test' 
    }, encoding: 'utf8',
  });

  assert.equal(run().status, 0);
  assert.equal(existsSync(path.join(home, '.grigdesk')), false);
  writeFileSync(path.join(code, '.env'), 'FAKE=1');

  const result = run();

  assert.equal(result.status, 78);
  assert.match(result.stderr, /вручную/);
  assert.equal(existsSync(path.join(home, '.grigdesk')), false);
});

test('RE-DH-5 остановка ждёт PID и завершает только свой зависший процесс', async (t) => {
  for (const ignores of [false, true]) {
    const child = spawn(process.execPath, ['-e', `
      process.on('SIGTERM', () => { ${ignores ? '' : 'setTimeout(() => process.exit(0), 1000);'} });
      setInterval(() => {}, 1000);
      process.stdout.write('ready');
    `], { env: { PATH: '/usr/bin:/bin', NODE_ENV: 'test' } });
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));

    t.after(() => {
       if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    } 
    });
    await new Promise((resolve) => child.stdout.once('data', resolve));

    const before = Date.now();
    const stop = spawn('bash', ['-c', 'source "$1"; grigdesk_stop_pids "$2" "$3"',
      '_', helper, ignores ? '1' : '5', String(child.pid)], { env: { PATH: '/usr/bin:/bin' } });
    const code = await new Promise((resolve) => stop.once('exit', resolve));
    const result = await exited;

    assert.equal(code, 0);
    assert.equal(result.signal, ignores ? 'SIGKILL' : null);

    if (!ignores) {
      assert.ok(Date.now() - before >= 900);
    }
  }
});
