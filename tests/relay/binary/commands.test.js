import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';

import { copyBinary, freePort } from './helpers.js';

const execute = promisify(execFile);
const helpFile = new URL('../../../utilities/relay/internal/cli/help.txt', import.meta.url);
const help = await readFile(helpFile, 'utf8');
const versionPattern = /^grigdesk-relay \d+\.\d+\.\d+ \(Go go[\w.]+, [a-z]+ [a-z0-9]+\)\n$/;
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

  assert.match(version.stdout, versionPattern);
  assert.equal(version.stderr, '');

  for (const flag of ['--help', '-h']) {
    const result = await run([flag]);

    assert.equal(result.stdout, help);
    assert.equal(result.stderr, '');
  }

  const license = await run(['--license']);

  assert.match(license.stdout, /Copyright .* The Go Authors/i);
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
        : 'Неизвестная команда. Справка: grigdesk-relay --help\n');

      return true;
    });
  }
});

test('RS-03: NODE_OPTIONS не действует на готовый файл', async () => {
  const result = await run(['--version'], { NODE_OPTIONS: '--require /nonexistent-grigdesk.js' });

  assert.match(result.stdout, versionPattern);
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
