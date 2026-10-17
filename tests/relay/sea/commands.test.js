import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';

import { HELP_TEXT, versionLine } from '../../../relay/src/cli.ts';
import { copyBinary, freePort } from './helpers.js';

const execute = promisify(execFile);
const manifest = JSON.parse(await readFile(new URL('../../../relay/package.json', import.meta.url)));
let binary;
let removeBinary;

after(() => removeBinary?.());

before(async () => {
  binary = await copyBinary({ after: (cleanup) => {
    removeBinary = cleanup;
  } });
});

const run = (args, env = {}) => execute(binary, args, {
  cwd: path.dirname(binary),
  env: {
    PATH: '',
    ...env,
  },
  timeout: 5000,
  maxBuffer: 1024 * 1024,
});

test('RS-01: версия, справка и лицензия без окружения', async () => {
  const version = await run(['--version']);

  assert.equal(version.stdout, `${versionLine(manifest.version, 'v24.21.0', 'linux', 'x64')}\n`);
  assert.equal(version.stderr, '');

  for (const flag of ['--help', '-h']) {
    const result = await run([flag]);

    assert.equal(result.stdout, HELP_TEXT);
    assert.equal(result.stderr, '');
  }

  const license = await run(['--license']);

  assert.ok(license.stdout.startsWith('Node.js is licensed for use as follows:'));
  assert.ok(license.stdout.length > 100000);
  assert.equal(license.stderr, '');
});

test('RS-01/закрытый канал: лицензия не падает с EPIPE', { timeout: 5000 }, async (t) => {
  const child = spawn(binary, ['--license'], {
    cwd: path.dirname(binary),
    env: { PATH: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';

  t.after(() => child.kill('SIGKILL'));
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  child.stdout.once('data', () => child.stdout.destroy());

  const code = await new Promise((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });

  assert.equal(code, 0);
  assert.equal(stderr, '');
});

test('RS-02: отказы с кодом 2 без эха аргумента', async () => {
  for (const args of [['--nope'], ['--version', '--help'], ['--worker']]) {
    await assert.rejects(() => run(args), (error) => {
      assert.equal(error.code, 2);
      assert.equal(`${error.stdout}${error.stderr}`.includes('--nope'), false);
      assert.equal(error.stdout, '');
      assert.equal(error.stderr, args[0] === '--worker'
        ? 'Внутренний режим запускает сам посредник.\n'
        : 'Неизвестная команда. Справка: cockpit-relay --help\n');

      return true;
    });
  }
});

test('RS-03: NODE_OPTIONS не действует на готовый файл', async () => {
  const result = await run(['--version'], { NODE_OPTIONS: '--require /nonexistent-cockpit.js' });

  assert.equal(result.stdout, `${versionLine(manifest.version, 'v24.21.0', 'linux', 'x64')}\n`);
  assert.equal(result.stderr, '');
});

test('RS-04: healthcheck отказывает на закрытом и неверном порту', async () => {
  for (const port of [String(await freePort()), 'abc']) {
    const started = Date.now();

    await assert.rejects(() => run(['--healthcheck'], { RELAY_PORT: port }), (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, '');
      assert.equal(error.stderr, '');

      return true;
    });
    assert.ok(Date.now() - started < 5000);
  }
});
