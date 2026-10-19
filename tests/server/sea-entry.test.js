import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { HELP_TEXT, parseSeaArgs, runSeaCli } from '../../server/src/lib/seaCli.ts';
import { freePort, isolatedEnv } from './helpers/pluginBootFixture.js';

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const SEA_ENTRY = path.join(ROOT, 'server/src/sea.ts');
const APP_JS = path.join(ROOT, 'server/src/app.js');

/**
 * Отдельная временная папка одного сценария; уборка привязана к тесту.
 * Папка данных внутри неё доказывает отсутствие ранних файловых эффектов.
 */
async function scratch(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-sea-entry-'));

  t.after(() => rm(root, {
    recursive: true,
    force: true
  }));

  return root;
}

/**
 * Порты CLI с записью вызовов: тест видит ровно то, что напечатал бы бинарник.
 * Файлы и сервер не затрагиваются.
 */
function ports(log, overrides = {}) {
  return {
    readVersion: () => '9.9.9',
    readLicense: () => 'NODE LICENSE TEXT\n',
    loadServer: async () => {
      log.loads += 1;
    },
    stdout: (text) => {
      log.out += text;
    },
    stderr: (text) => {
      log.err += text;
    },
    nodeVersion: 'v24.21.0',
    platform: 'linux',
    arch: 'x64',
    ...overrides,
  };
}

/**
 * Запускает точку входа отдельным Node с ограниченным сроком.
 * Код null при тайм-ауте считается отказом с накопленным выводом.
 */
async function spawnNode(args, env, timeoutMs = 30_000) {
  const child = spawn(process.execPath, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const timer = setTimeout(() => {
    child.kill('SIGKILL');
  }, timeoutMs);

  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (value) => resolve(value));
    });

    return {
      code,
      stdout,
      stderr
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ждёт готовый сервер по HTTP и падает сразу, если процесс уже завершился.
 * Готовность доказывает ответ сокета, а не строка журнала.
 */
async function waitHttp(child, url, deadlineMs = 90_000) {
  const deadline = Date.now() + deadlineMs;
  let lastError;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`сервер завершился с кодом ${child.exitCode}`);
    }

    try {
      return await fetch(url, { signal: AbortSignal.timeout(500) });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw lastError ?? new Error('сервер не поднялся');
}

test('SEA-ENTRY-01: разбор аргументов отвергает чужие наборы без запуска', () => {
  assert.deepEqual(parseSeaArgs([]), { command: 'run' });
  assert.deepEqual(parseSeaArgs(['--help']), { command: 'help' });
  assert.deepEqual(parseSeaArgs(['--version']), { command: 'version', json: false });
  assert.deepEqual(parseSeaArgs(['--version', '--json']), { command: 'version', json: true });
  assert.deepEqual(parseSeaArgs(['--license']), { command: 'license' });

  for (const args of [['--json'], ['--help', '--version'], ['--version', '--json', '--help'],
    ['--nope'], ['--help', '--help'], ['--version', '--version'], ['run']]) {
    const parsed = parseSeaArgs(args);

    assert.equal(parsed.command, 'error', JSON.stringify(args));
    assert.match(parsed.error, /[А-Яа-я]/, JSON.stringify(args));
  }
});

test('SEA-ENTRY-02: справка, версия и лицензия не создают папку данных', async (t) => {
  const root = await scratch(t);
  const dataHome = path.join(root, 'не созданная папка');

  for (const scenario of [
    { args: ['--help'], check: (out) => assert.match(out, /--version/) },
    { args: ['--version'], check: (out) => {
      assert.match(out, /GrigDesk 9\.9\.9/);
      assert.match(out, /Node v24\.21\.0/);
      assert.match(out, /linux x64/);
    } },
    { args: ['--version', '--json'], check: (out) => {
      assert.deepEqual(JSON.parse(out), {
        version: '9.9.9',
        node: 'v24.21.0',
        platform: 'linux',
        arch: 'x64',
        packagingVersion: 1,
      });
    } },
    { args: ['--license'], check: (out) => assert.equal(out, 'NODE LICENSE TEXT\n') },
  ]) {
    const log = {
      loads: 0,
      out: '',
      err: ''
    };
    const code = await runSeaCli(scenario.args, ports(log));

    assert.equal(code, 0, JSON.stringify(scenario.args));
    assert.equal(log.loads, 0);
    assert.equal(log.err, '');
    scenario.check(log.out);
  }

  assert.equal(existsSync(dataHome), false);
  assert.match(HELP_TEXT, /GrigDesk — сервер GrigDesk/);
});

test('SEA-ENTRY-03: неверный аргумент — код 2, без загрузки сервера', async () => {
  const log = {
    loads: 0,
    out: '',
    err: ''
  };
  const code = await runSeaCli(['--unknown'], ports(log));

  assert.equal(code, 2);
  assert.equal(log.loads, 0);
  assert.match(log.err, /--unknown/);
  assert.match(log.err, /GrigDesk/);
});

test('SEA-ENTRY-04: режим запуска загружает сервер ровно один раз', async () => {
  const log = {
    loads: 0,
    out: '',
    err: ''
  };
  const code = await runSeaCli([], ports(log));

  assert.equal(code, 0);
  assert.equal(log.loads, 1);
  assert.equal(log.out, '');
  assert.equal(log.err, '');
});

test('SEA-ENTRY-05: help/version/license не читают и не создают D', async (t) => {
  const root = await scratch(t);
  const dataHome = path.join(root, 'отсутствующая папка');
  const env = {
    PATH: '/usr/bin:/bin',
    HOME: root,
    GRIGDESK_HOME: dataHome,
  };

  for (const [args, check] of [
    [['--help'], (stdout) => assert.match(stdout, /GrigDesk/)],
    [['--version', '--json'], (stdout) => assert.equal(JSON.parse(stdout).version, '0.1.0')],
    [['--license'], (stdout) => assert.match(stdout, /Node\.js is licensed/)],
  ]) {
    const result = await spawnNode([SEA_ENTRY, ...args], env);

    assert.equal(result.code, 0, `${args.join(' ')}\n${result.stderr}`);
    assert.equal(result.stderr, '');
    check(result.stdout);
    assert.equal(existsSync(dataHome), false);
  }
});

test('SEA-ENTRY-06: .env прочитан до config, SIGTERM завершает штатно', { timeout: 120_000 },
  async (t) => {
    const root = await scratch(t);
    const port = await freePort();
    const env = isolatedEnv(root, port);

    delete env.GRIGDESK_PORT;
    await writeFile(path.join(root, '.env'), `GRIGDESK_PORT=${port}\n`);

    const child = spawn(process.execPath, [SEA_ENTRY], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      log += chunk;
    });
    child.stderr.on('data', (chunk) => {
      log += chunk;
    });
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    });

    const response = await waitHttp(child, `http://127.0.0.1:${port}/api/health`);

    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, 'unauthorized');

    child.kill('SIGTERM');

    const [code, signal] = await new Promise((resolve) => {
      child.once('exit', (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
    });

    assert.equal(signal, null, log);
    assert.equal(code, 0, log);
  });

test('SEA-ENTRY-07: ошибка data-home сохраняет код 78', { timeout: 30_000 }, async (t) => {
  const root = await scratch(t);
  const result = await spawnNode([SEA_ENTRY], {
    PATH: '/usr/bin:/bin',
    HOME: root,
    GRIGDESK_HOME: 'relative',
  });

  assert.equal(result.code, 78, result.stderr);
  assert.match(result.stderr, /Папка данных/);
});

test('SEA-ENTRY-08: app.js поднимает ровно один сервер и слушает SIGTERM',
  { timeout: 120_000 }, async (t) => {
    const root = await scratch(t);
    const port = await freePort();
    const child = spawn(process.execPath, [APP_JS], {
      env: isolatedEnv(root, port),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      log += chunk;
    });
    child.stderr.on('data', (chunk) => {
      log += chunk;
    });
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    });

    const response = await waitHttp(child, `http://127.0.0.1:${port}/api/health`);

    assert.equal(response.status, 401);
    child.kill('SIGTERM');

    const [code, signal] = await new Promise((resolve) => {
      child.once('exit', (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
    });

    assert.equal(signal, null, log);
    assert.equal(code, 0, log);
  });


test('SEA-ENTRY-09: ошибка старта после живого таймера завершает процесс с кодом 1',
  { timeout: 40_000 }, async (t) => {
    const root = await scratch(t);
    const port = await freePort();
    const blocker = createServer((socket) => socket.end());

    await new Promise((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(port, '127.0.0.1', resolve);
    });
    t.after(() => new Promise((resolve) => blocker.close(resolve)));

    const wrapper = path.join(root, 'wrapper.mjs');
    const app = pathToFileURL(path.join(ROOT, 'server/src/app.ts')).href;

    await writeFile(wrapper, [
      'setInterval(() => {}, 1000);',
      `await import(${JSON.stringify(app)});`,
      '',
    ].join('\n'));

    const result = await spawnNode([wrapper], isolatedEnv(root, port), 20_000);

    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /GrigDesk не запустился/);
  });
