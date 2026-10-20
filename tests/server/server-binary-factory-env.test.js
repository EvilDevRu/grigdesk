// Окружение и секреты отвязанного маршрута в обеих ветках запуска: transient-юнит
// systemd и detached fallback. Ключи синтетические, systemd и движок заменены
// исполняемыми фикстурами, которые по-настоящему запускают команду и снимают её env.
import assert from 'node:assert/strict';
import {
  mkdir, mkdtemp, readFile, rm, stat, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { routeSecrets, spawnRouteEngine } from '../../server/src/lib/factoryRouteCli.ts';
import { nodeExecutable } from '../../server/src/lib/runtimePaths.ts';

const KEYS = {
  DEEPSEEK_API_KEY: 'synthetic-deepseek-route-key',
  ZAI_API_KEY: 'synthetic-zai-route-key',
  ZAI_CODING_API_KEY: 'synthetic-coding-plan-route-key',
};
const HOSTILE_EXTRA = {
  PATH: '/evil/bin',
  FACTORY_HOME: '/evil/engine',
  FACTORY_PROFILES_DIR: '/evil/profiles',
  GRIGDESK_DEEPSEEK_NODE_BIN: '/evil/node',
  GRIGDESK_DEEPSEEK_BIN: '/evil/deepseek',
  GRIGDESK_DEEPSEEK_CACHE_DIR: '/evil/cache',
  GRIGDESK_GLM_API_MODE: 'coding-plan',
  GRIGDESK_PROVIDER_PREFS_PATH: '/evil/prefs.json',
  DEEPSEEK_API_KEY: 'extra-deepseek-key',
  ZAI_API_KEY: 'extra-zai-key',
  ZAI_CODING_API_KEY: 'extra-coding-key',
  FACTORY_STAGE_AUTO_COMPACT: '0',
};

/**
 * Systemd-run как у systemd: `--setenv` и EnvironmentFile собираются в окружение
 * без наследования env вызывающего, затем команда действительно исполняется.
 */
function systemdRunStub(root, { available }) {
  return `#!${process.execPath}
const { appendFileSync, readFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === '--version') process.exit(${available ? 0 : 1});
appendFileSync(${JSON.stringify(path.join(root, 'systemd.argv'))}, JSON.stringify(args) + '\\n');
const env = {};
let command = null;
for (const [index, arg] of args.entries()) {
  if (arg.startsWith('--setenv=')) {
    const pair = arg.slice('--setenv='.length);
    env[pair.slice(0, pair.indexOf('='))] = pair.slice(pair.indexOf('=') + 1);
  } else if (arg.startsWith('--property=EnvironmentFile=')) {
    for (const line of readFileSync(arg.slice('--property=EnvironmentFile='.length), 'utf8').split('\\n')) {
      const match = /^([A-Z_][A-Z0-9_]*)="((?:[^"\\\\]|\\\\.)*)"$/.exec(line);
      if (line && !match) process.exit(65);
      if (match) env[match[1]] = match[2].replace(/\\\\(.)/g, '$1');
    }
  } else if (!arg.startsWith('--')) {
    command = args.slice(index);
    break;
  }
}
const result = spawnSync(command[0], command.slice(1), { env, stdio: 'ignore' });
process.exit(result.status ?? 1);
`;
}

/**
 * Изолированный маршрут: своя папка состояния, свои systemd-run и движок на PATH,
 * синтетические ключи в env сервера. Всё снимается после теста.
 */
async function routeFixture(t, { systemd }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'server-binary-factory-env-'));
  const bin = path.join(root, 'stub-bin');
  const userCli = path.join(root, 'nvm/versions/node/v24.10.0/bin');
  const capture = path.join(root, 'engine-env.json');
  const saved = { ...process.env };

  t.after(async () => {
    for (const name of Object.keys(process.env)) {
      if (!(name in saved)) {
        delete process.env[name];
      }
    }

    Object.assign(process.env, saved);
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(bin, { recursive: true });
  await mkdir(userCli, { recursive: true });
  await writeFile(path.join(bin, 'systemd-run'), systemdRunStub(root, { available: systemd }), {
    mode: 0o755,
  });

  const factoryBin = path.join(root, 'engine/bin/factory');

  await mkdir(path.dirname(factoryBin), { recursive: true });
  await writeFile(factoryBin, `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(capture)},
  JSON.stringify({ argv: process.argv.slice(2), env: process.env }));
`, { mode: 0o755 });
  process.env.PATH = `${bin}:${userCli}:/usr/bin:/bin`;
  Object.assign(process.env, KEYS, { GRIGDESK_GLM_API_MODE: 'api' });

  const config = {
    dataHome: path.join(root, 'data'),
    routesDir: path.join(root, 'routes'),
    stateDir: path.join(root, 'state'),
    factoryControlDir: path.join(root, 'control'),
    factoryBin,
    rootDir: path.join(root, 'install'),
    installationBin: path.join(root, 'install/bin'),
    factoryHome: path.join(root, 'engine'),
    profilesDir: path.join(root, 'data/profiles'),
    factoryConfigRoot: path.join(root, 'config'),
    deepseekBin: path.join(root, 'install/bin/deepseek'),
    deepseekCacheDir: path.join(root, 'data/runtimes/deepseek'),
    prefsPath: path.join(root, 'data/prefs.json'),
  };

  return {
    root,
    config,
    capture,
    userCli,
  };
}

/**
 * Detached-ветка не ждёт процесс до конца: снимок env появляется асинхронно.
 * Ожидание ограничено, отсутствие снимка — отказ теста, а не пропуск проверки.
 */
async function readCapture(file) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch {
      await sleep(50);
    }
  }

  throw new Error(`движок не записал снимок окружения: ${file}`);
}

/**
 * Общие требования обеих веток: host-owned пути, режим GLM и ключи режима API,
 * без ключа Coding Plan и без подмены через extraEnv.
 */
function assertHostEnvironment(env, { config, userCli }) {
  const entries = env.PATH.split(':');

  assert.equal(entries[0], config.installationBin);
  assert.ok(entries.includes(userCli), 'пользовательский каталог CLI (nvm) доходит до движка');
  assert.ok(!entries.includes('/evil/bin'));
  assert.equal(env.FACTORY_HOME, config.factoryHome);
  assert.equal(env.FACTORY_PROFILES_DIR, config.profilesDir);
  assert.equal(env.FACTORY_CONFIG_ROOT, config.factoryConfigRoot);
  assert.equal(env.GRIGDESK_HOME, config.dataHome);
  assert.equal(env.GRIGDESK_DEEPSEEK_NODE_BIN, nodeExecutable());
  assert.equal(env.GRIGDESK_DEEPSEEK_BIN, config.deepseekBin);
  assert.equal(env.GRIGDESK_DEEPSEEK_CACHE_DIR, config.deepseekCacheDir);
  assert.equal(env.GRIGDESK_PROVIDER_PREFS_PATH, config.prefsPath);
  assert.equal(env.GRIGDESK_GLM_API_MODE, 'api');
  assert.equal(env.DEEPSEEK_API_KEY, KEYS.DEEPSEEK_API_KEY);
  assert.equal(env.ZAI_API_KEY, KEYS.ZAI_API_KEY);
  assert.equal(env.ZAI_CODING_API_KEY, undefined);
  assert.equal(env.FACTORY_STAGE_AUTO_COMPACT, '0');
}

test('SB13: transient-юнит получает host env, режим GLM и ключи только файлом 0600', async (t) => {
  const f = await routeFixture(t, { systemd: true });
  const result = await spawnRouteEngine(f.config, {
    task: 77,
    args: ['route', 'start', '77'],
    extraEnv: HOSTILE_EXTRA,
  });

  assert.equal(result.ok, true, result.message);

  const { env } = await readCapture(f.capture);
  const argv = await readFile(path.join(f.root, 'systemd.argv'), 'utf8');
  const secrets = path.join(f.config.stateDir, 'route-secrets.env');

  assertHostEnvironment(env, f);

  for (const value of [...Object.values(KEYS), 'extra-deepseek-key', 'extra-zai-key', 'extra-coding-key']) {
    assert.equal(argv.includes(value), false, `ключ в argv systemd-run: ${value}`);
  }

  assert.match(argv, /--property=EnvironmentFile=/u);
  assert.equal((await stat(secrets)).mode & 0o777, 0o600);

  const names = (await readFile(secrets, 'utf8')).trim().split('\n').map((line) => line.split('=')[0]);

  assert.deepEqual(names.sort(), ['DEEPSEEK_API_KEY', 'ZAI_API_KEY']);
});

test('SB13: повтор без ключей не оставляет прежний файл секретов и не передаёт ключи', async (t) => {
  const f = await routeFixture(t, { systemd: true });

  assert.equal((await spawnRouteEngine(f.config, { task: 78, args: ['route', 'start', '78'] })).ok, true);
  await rm(f.capture, { force: true });

  for (const name of Object.keys(KEYS)) {
    delete process.env[name];
  }

  const repeated = await spawnRouteEngine(f.config, { task: 78, args: ['route', 'start', '78'] });
  const { env } = await readCapture(f.capture);
  const lastArgv = (await readFile(path.join(f.root, 'systemd.argv'), 'utf8')).trim().split('\n').at(-1);

  assert.equal(repeated.ok, true, repeated.message);
  await assert.rejects(() => stat(path.join(f.config.stateDir, 'route-secrets.env')), { code: 'ENOENT' });
  assert.equal(lastArgv.includes('EnvironmentFile'), false);
  assert.equal(env.DEEPSEEK_API_KEY, undefined);
  assert.equal(env.ZAI_API_KEY, undefined);
});

test('SB13: перевод строки или NUL в ключе отвергается до записи и запуска', async (t) => {
  const f = await routeFixture(t, { systemd: true });
  const secrets = path.join(f.config.stateDir, 'route-secrets.env');

  await mkdir(f.config.stateDir, { recursive: true });
  await writeFile(secrets, 'PREVIOUS="kept"\n', { mode: 0o600 });

  for (const hostile of ['first\nINJECTED=1', 'first\rsecond']) {
    process.env.ZAI_API_KEY = hostile;

    const result = await spawnRouteEngine(f.config, { task: 79, args: ['route', 'start', '79'] });

    assert.equal(result.ok, false);
    assert.match(result.message || '', /ZAI_API_KEY/u);
    assert.equal(await readFile(secrets, 'utf8'), 'PREVIOUS="kept"\n');
    await assert.rejects(() => stat(path.join(f.root, 'systemd.argv')), { code: 'ENOENT' });
  }

  assert.throws(() => routeSecrets({ DEEPSEEK_API_KEY: 'a\0b' }), { code: 'route_secret_invalid' });

  const allowed = routeSecrets({
    DEEPSEEK_API_KEY: 'a',
    ZAI_CODING_API_KEY: 'b',
    OTHER: 'c',
  });

  assert.deepEqual(allowed, { DEEPSEEK_API_KEY: 'a' });
});

test('SB13: detached fallback получает тот же разрешённый набор без ключа Coding Plan', async (t) => {
  const f = await routeFixture(t, { systemd: false });
  const result = await spawnRouteEngine(f.config, {
    task: 80,
    args: ['route', 'start', '80'],
    extraEnv: HOSTILE_EXTRA,
  });

  assert.equal(result.ok, true, result.message);
  assert.equal(result.unit, null);

  const { env } = await readCapture(f.capture);

  assertHostEnvironment(env, f);
  await assert.rejects(() => stat(path.join(f.root, 'systemd.argv')), { code: 'ENOENT' });
});
