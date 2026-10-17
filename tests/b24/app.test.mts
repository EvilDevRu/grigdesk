import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runB24 } from '../../b24/src/app.ts';
import type { AppIO, RuntimeInfo } from '../../b24/src/app.ts';
import { HELP_TEXT } from '../../b24/src/args.ts';

const RUNTIME: RuntimeInfo = {
  version: '0.1.0',
  license: () => 'LICENSE TEXT\n',
};

interface Harness extends AppIO {
  stdout: Array<string | Uint8Array>;
  stderr: string[];
  calls: string[];
}

/**
 * Собирает app с подменами, которые по умолчанию бросают при любом вызове I/O.
 * Записи stdout/stderr копятся в буферах, вызовы — в журнале.
 */
function harness(overrides: Partial<AppIO> = {}): Harness {
  const box: Harness = {
    stdout: [],
    stderr: [],
    calls: [],
    env: { HOME: '/home/user' },
    getHome() {
      box.calls.push('getHome');

      throw new Error('getHome запрещён');
    },
    async readText(file) {
      box.calls.push(`readText ${file}`);

      throw new Error('readText запрещён');
    },
    async request() {
      box.calls.push('request');

      throw new Error('request запрещён');
    },
    async readStdin() {
      box.calls.push('readStdin');

      throw new Error('readStdin запрещён');
    },
    async writeStdout(value) {
      box.stdout.push(value);
    },
    async writeStderr(value) {
      box.stderr.push(value);
    },
    ...overrides,
  };

  return box;
}

test('BP-01: импорт библиотечных модулей не имеет эффектов', async () => {
  const modules = ['args', 'config', 'http', 'commands', 'app', 'errors'].map((name) => (
    new URL(`../../b24/src/${name}.ts`, import.meta.url).href
  ));
  const script = [
    "globalThis.fetch = () => { process.stderr.write('fetch вызван'); throw new Error('fetch'); };",
    ...modules.map((href) => `await import(${JSON.stringify(href)});`),
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: '/',
    env: {
      PATH: '/usr/bin:/bin',
      HOME: '/nonexistent-home',
      COCKPIT_HOME: 'relative-invalid',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';

  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });

  const code = await new Promise<number | null>((resolve) => {
    child.once('close', resolve);
  });

  assert.equal(code, 0, output);
  assert.equal(output, '');
  assert.ok(fileURLToPath(modules[0] ?? '').endsWith('args.ts'));
});

test('BP-02: локальные команды и неверный argv не читают настройки', async () => {
  const help = harness();

  assert.equal(await runB24(['--help'], RUNTIME, help), 0);
  assert.deepEqual(help.stdout, [HELP_TEXT]);
  assert.deepEqual(help.stderr, []);

  const version = harness();
  const expected = `b24 0.1.0 (Node ${process.version}, ${process.platform} ${process.arch})\n`;

  assert.equal(await runB24(['--version'], RUNTIME, version), 0);
  assert.deepEqual(version.stdout, [expected]);

  const license = harness();

  assert.equal(await runB24(['--license'], RUNTIME, license), 0);
  assert.deepEqual(license.stdout, ['LICENSE TEXT\n']);

  for (const argv of [[], ['frobnicate'], ['task'], ['dashboard', 'extra'], ['--help', 'extra']]) {
    const box = harness();

    assert.equal(await runB24(argv, RUNTIME, box), 2, argv.join(' '));
    assert.deepEqual(box.stdout, []);
    assert.equal(box.stderr.length, 1);
    assert.match(box.stderr[0] ?? '', /[А-Яа-я]/);
    assert.ok(box.stderr[0]?.endsWith(HELP_TEXT), argv.join(' '));
  }

  for (const box of [help, version, license]) {
    assert.deepEqual(box.calls, []);
  }

  for (const command of ['dashboard', 'task', 'comment', 'timer', 'start', 'complete', 'renew', 'create',
    'users']) {
    assert.ok(HELP_TEXT.includes(command), command);
  }
});

test('BP-03: ошибки конфигурации и stdin не открывают HTTP', async () => {
  const missingToken = harness({
    readText: async () => null,
  });

  assert.equal(await runB24(['dashboard'], RUNTIME, missingToken), 1);
  assert.deepEqual(missingToken.stdout, []);
  assert.deepEqual(missingToken.stderr, ['Нет токена: /home/user/.cockpit/state/cli-token.\n']);
  assert.ok(!missingToken.calls.includes('request'));

  const badStdin = harness({
    env: {
      COCKPIT_URL: 'http://127.0.0.1:9',
      COCKPIT_TOKEN: 'tok',
    },
  });

  assert.equal(await runB24(['create'], RUNTIME, badStdin), 1);
  assert.deepEqual(badStdin.stderr, ['Не удалось прочитать JSON из stdin.\n']);
  assert.deepEqual(badStdin.calls, ['readStdin']);

  const badAddress = harness({
    env: {
      COCKPIT_URL: 'ftp://host',
      COCKPIT_TOKEN: 'tok',
    },
  });

  assert.equal(await runB24(['dashboard'], RUNTIME, badAddress), 1);
  assert.deepEqual(badAddress.stderr, [
    'Некорректный адрес Cockpit: нужен HTTP(S) URL без учётных данных и query.\n',
  ]);
  assert.deepEqual(badAddress.calls, []);
});

test('BP-04: отказ записи не оставляет необработанного исключения', async () => {
  const env = {
    COCKPIT_URL: 'http://127.0.0.1:9',
    COCKPIT_TOKEN: 'tok',
  };
  const epipe = harness({
    env,
    request: async () => new Uint8Array(Buffer.from('{}')),
    writeStdout: async () => {
      throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    },
  });

  assert.equal(await runB24(['dashboard'], RUNTIME, epipe), 0);
  assert.deepEqual(epipe.stderr, []);

  const broken = harness({
    env,
    request: async () => new Uint8Array(Buffer.from('{}')),
    writeStdout: async () => {
      throw Object.assign(new Error('write EIO'), { code: 'EIO' });
    },
  });

  assert.equal(await runB24(['dashboard'], RUNTIME, broken), 1);
  assert.deepEqual(broken.stderr, ['Не удалось записать ответ.\n']);

  const silent = harness({
    env,
    request: async () => {
      throw new Error('внутренний сбой со стеком');
    },
    writeStderr: async () => {
      throw new Error('stderr закрыт');
    },
  });

  assert.equal(await runB24(['dashboard'], RUNTIME, silent), 1);

  const unknown = harness({
    env,
    request: async () => {
      throw new Error('internal stack');
    },
  });

  assert.equal(await runB24(['dashboard'], RUNTIME, unknown), 1);
  assert.deepEqual(unknown.stderr, ['Не удалось выполнить команду b24.\n']);
});
