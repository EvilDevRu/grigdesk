import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { HELP_TEXT } from '../../tracker/src/args.ts';
import { sendChunked, startHttpFixture } from './helpers/httpFixture.mts';
import type { HttpFixture, RecordedRequest } from './helpers/httpFixture.mts';
import { childEnv, runProcess, SOURCE_MAIN, syntheticHome } from './helpers/processFixture.mts';
import type { ProcessResult } from './helpers/processFixture.mts';
import { startProxyFixture } from './helpers/proxyFixture.mts';

const TOKEN = 'tok-cli';
const REPO = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Фейк GrigDesk отвечает телом, в котором виден метод и путь запроса.
 * Так stdout сверяется побайтно с ожидаемым ответом.
 */
function echoBody(request: RecordedRequest): Buffer {
  return Buffer.from(`{"seen":"${request.method} ${request.url}","ok":"тест"}\n`);
}

/**
 * Запускает исходник tracker с явными URL и токеном против фейка.
 * Окружение составляется только из синтетических значений.
 */
async function runSource(
  t: test.TestContext,
  fixture: HttpFixture,
  args: readonly string[],
  input?: Uint8Array | string,
): Promise<ProcessResult> {
  const { home } = await syntheticHome();

  return await runProcess(t, process.execPath, [SOURCE_MAIN, ...args], {
    env: childEnv(home, {
      GRIGDESK_URL: fixture.baseUrl,
      GRIGDESK_TOKEN: TOKEN,
    }),
    input,
  });
}

/**
 * Проверяет успешный процесс: код 0, пустой stderr и точные байты stdout.
 * Сообщение assertion содержит stderr для диагностики.
 */
function assertSuccess(result: ProcessResult, body: Buffer): void {
  assert.equal(result.code, 0, result.stderr.toString());
  assert.equal(result.stderr.length, 0, result.stderr.toString());
  assert.ok(result.stdout.equals(body), result.stdout.toString());
}

test('BI-01: весь CLI-контракт проходит через HTTP', async (t) => {
  const fixture = await startHttpFixture(t, (request, response) => {
    sendChunked(response, 200, echoBody(request));
  });
  const cases: Array<[string[], string, string, string | null]> = [
    [['dashboard'], 'GET', '/api/tracker/dashboard', null],
    [['task', '007'], 'GET', '/api/tracker/task/007', null],
    [['comment', '42', 'два  пробела', '$(id)', '--help'], 'POST', '/api/tracker/task/42/comment',
      JSON.stringify({ text: 'два  пробела $(id) --help' })],
    [['timer', '42', 'start'], 'POST', '/api/tracker/task/42/timer/start', null],
    [['timer', '42', 'pause'], 'POST', '/api/tracker/task/42/timer/pause', null],
    [['timer', '42', 'stop'], 'POST', '/api/tracker/task/42/timer/stop', null],
    [['complete', '42'], 'POST', '/api/tracker/task/42/complete', null],
    [['renew', '42'], 'POST', '/api/tracker/task/42/renew', null],
    [['users'], 'GET', '/api/tracker/users?q=', null],
    [['users', 'Иван Петров'], 'GET',
      `/api/tracker/users?${new URLSearchParams({ q: 'Иван Петров' })}`, null],
  ];

  for (const [args, method, url, body] of cases) {
    const before = fixture.requests.length;
    const result = await runSource(t, fixture, args);
    const request = fixture.requests[before];

    assert.ok(request, args.join(' '));
    assert.equal(fixture.requests.length, before + 1);
    assert.equal(request.method, method);
    assert.equal(request.url, url);
    assert.equal(request.headers['x-grigdesk-token'], TOKEN);
    assert.equal(request.headers['content-type'], body === null ? undefined : 'application/json');
    assert.equal(request.body.toString(), body ?? '');
    assertSuccess(result, echoBody(request));
  }
});

test('BI-02: create сохраняет stdin', async (t) => {
  const fixture = await startHttpFixture(t, (request, response) => {
    if (request.body.toString().startsWith('{not')) {
      response.writeHead(400).end('{"error":"bad json"}');

      return;
    }

    response.end('{"id":1}');
  });
  const large = `{"title":"большой","description":"${'я'.repeat(128 * 1024)}"}\n`;

  assert.ok(Buffer.byteLength(large) >= 256 * 1024);

  for (const input of ['{"title":"Задача 🌍",\n"description":"строка\\nдругая"}\n', '{"title":"t"}\r\n', '',
    large]) {
    const result = await runSource(t, fixture, ['create'], input);
    const request = fixture.requests.at(-1);

    assertSuccess(result, Buffer.from('{"id":1}'));
    assert.ok(request?.body.equals(Buffer.from(input)));
    assert.equal(request?.headers['content-type'], 'application/json');
  }

  const invalid = await runSource(t, fixture, ['create'], '{not json');

  assert.equal(invalid.code, 22);
  assert.equal(invalid.stdout.length, 0);
  assert.equal(invalid.stderr.toString(), 'Запрос к GrigDesk завершился ошибкой HTTP 400.\n');
});

test('BI-03: start сохраняет только результат timer', async (t) => {
  for (const renew of ['200', '400', '502', 'reset']) {
    for (const timer of [200, 502]) {
      const fixture = await startHttpFixture(t, (request, response) => {
        if (request.url.endsWith('/renew')) {
          if (renew === 'reset') {
            response.socket?.destroy();
          } else {
            response.writeHead(Number(renew)).end('{"renew":"тело"}');
          }

          return;
        }

        response.writeHead(timer).end(timer === 200 ? '{"timer":"ok"}' : '{"timer":"bad"}');
      });
      const result = await runSource(t, fixture, ['start', '42']);

      assert.deepEqual(fixture.requests.map((request) => request.url), [
        '/api/tracker/task/42/renew',
        '/api/tracker/task/42/timer/start',
      ]);
      assert.ok(!result.stdout.toString().includes('renew'));
      assert.ok(!result.stderr.toString().includes('renew'));

      if (timer === 200) {
        assertSuccess(result, Buffer.from('{"timer":"ok"}'));
      } else {
        assert.equal(result.code, 22);
        assert.equal(result.stdout.length, 0);
        assert.equal(result.stderr.toString(), 'Запрос к GrigDesk завершился ошибкой HTTP 502.\n');
      }
    }
  }
});

test('BI-04: ошибки HTTP и сети дают пустой stdout', async (t) => {
  for (const status of [401, 403, 502, 302]) {
    const fixture = await startHttpFixture(t, (_request, response) => {
      response.writeHead(status, { Location: 'http://127.0.0.1:1/' }).end('<html>секрет</html>');
    });
    const result = await runSource(t, fixture, ['dashboard']);

    assert.equal(result.code, 22);
    assert.equal(result.stdout.length, 0);
    assert.equal(result.stderr.toString(), `Запрос к GrigDesk завершился ошибкой HTTP ${status}.\n`);
  }

  const before = await startHttpFixture(t, (_request, response) => {
    response.socket?.destroy();
  });
  const after = await startHttpFixture(t, (_request, response) => {
    response.writeHead(200, { 'Content-Length': '100000' });
    response.write('{"partial":');
    setTimeout(() => {
      response.socket?.destroy();
    }, 20);
  });

  for (const fixture of [before, after]) {
    const result = await runSource(t, fixture, ['dashboard']);

    assert.equal(result.code, 22);
    assert.equal(result.stdout.length, 0);
    assert.equal(result.stderr.toString(), 'Не удалось связаться с GrigDesk.\n');
  }
});

test('BI-05: новая папка и отдельный env-файл работают в реальном процессе', async (t) => {
  const fixture = await startHttpFixture(t, (request, response) => {
    response.end(`{"token":"${String(request.headers['x-grigdesk-token'])}"}`);
  });
  const port = new URL(fixture.baseUrl).port;
  const { home, data } = await syntheticHome();

  await mkdir(path.join(data, 'state'), { recursive: true });
  await writeFile(path.join(data, 'state/cli-token'), 'tok-default\r\n');
  await writeFile(path.join(data, '.env'), `GRIGDESK_PORT=${port}\n`);

  const fromLayout = await runProcess(t, process.execPath, [SOURCE_MAIN, 'dashboard'], {
    env: childEnv(home),
  });

  assertSuccess(fromLayout, Buffer.from('{"token":"tok-default"}'));

  const separate = path.join(home, 'отдельный.env');

  await writeFile(path.join(home, 'custom-token'), '\n tok-custom \n');
  await writeFile(separate, [
    `GRIGDESK_PORT="${port}"`,
    `GRIGDESK_CLI_TOKEN_PATH="${path.join(home, 'custom-token')}"`,
    '',
  ].join('\n'));

  const fromFile = await runProcess(t, process.execPath, [SOURCE_MAIN, 'dashboard'], {
    env: childEnv(home, { GRIGDESK_ENV_FILE: separate }),
  });

  assertSuccess(fromFile, Buffer.from('{"token":"tok-custom"}'));

  await writeFile(path.join(home, 'env-token'), 'tok-env-path\n');

  const exported = await runProcess(t, process.execPath, [SOURCE_MAIN, 'dashboard'], {
    env: childEnv(home, {
      GRIGDESK_ENV_FILE: separate,
      GRIGDESK_CLI_TOKEN_PATH: path.join(home, 'env-token'),
      GRIGDESK_URL: fixture.baseUrl,
    }),
  });

  assertSuccess(exported, Buffer.from('{"token":"tok-env-path"}'));
});

test('BI-06: без токена отказ до HTTP', async (t) => {
  const fixture = await startHttpFixture(t, (_request, response) => {
    response.end('{}');
  });
  const { home, data } = await syntheticHome();
  const legacy = path.join(home, 'code/server/.state');

  await mkdir(legacy, { recursive: true });
  await writeFile(path.join(legacy, 'cli-token'), 'tok-old');
  await writeFile(path.join(home, 'code/.env'), `GRIGDESK_PORT=${new URL(fixture.baseUrl).port}\n`);

  const result = await runProcess(t, process.execPath, [SOURCE_MAIN, 'dashboard'], {
    env: childEnv(home, { GRIGDESK_URL: fixture.baseUrl }),
    cwd: path.join(home, 'code'),
  });

  assert.equal(result.code, 1);
  assert.equal(result.stdout.length, 0);
  assert.equal(result.stderr.toString(), `Нет токена: ${path.join(data, 'state/cli-token')}.\n`);
  assert.equal(fixture.requests.length, 0);
});

test('BI-07: явные URL/токен работают при неверной GRIGDESK_HOME', async (t) => {
  const fixture = await startHttpFixture(t, (_request, response) => {
    response.end('{"ok":true}');
  });
  const { home } = await syntheticHome();
  const result = await runProcess(t, process.execPath, [SOURCE_MAIN, 'dashboard'], {
    env: childEnv(home, {
      GRIGDESK_HOME: 'relative/bad',
      GRIGDESK_URL: fixture.baseUrl,
      GRIGDESK_TOKEN: TOKEN,
    }),
    cwd: home,
  });

  assertSuccess(result, Buffer.from('{"ok":true}'));
  await assert.rejects(import('node:fs/promises').then((fs) => fs.stat(path.join(home, 'relative'))));
});

test('BI-08: справка и неверные аргументы работают без настроек', async (t) => {
  const fixture = await startHttpFixture(t, (_request, response) => {
    response.end('{}');
  });
  const env = {
    PATH: '',
    HOME: 'relative',
    GRIGDESK_HOME: 'bad',
    GRIGDESK_URL: fixture.baseUrl,
  };
  const help = await runProcess(t, process.execPath, [SOURCE_MAIN, '--help'], { env });

  assert.equal(help.code, 0);
  assert.equal(help.stdout.toString(), HELP_TEXT);
  assert.equal(help.stderr.length, 0);

  const wrong = await runProcess(t, process.execPath, [SOURCE_MAIN, 'frobnicate'], { env });

  assert.equal(wrong.code, 2);
  assert.equal(wrong.stdout.length, 0);
  assert.ok(wrong.stderr.toString().endsWith(HELP_TEXT));

  const license = await runProcess(t, process.execPath, [SOURCE_MAIN, '--license'], { env });

  assert.equal(license.code, 0);
  assert.equal(license.stdout.toString(),
    'Исходный запуск использует лицензию установленного Node.js. Полная лицензия включена в tracker SEA.\n');

  const version = await runProcess(t, process.execPath, [SOURCE_MAIN, '--version'], { env });

  const expected = `tracker 0.1.0 (Node ${process.version}, ${process.platform} ${process.arch})\n`;

  assert.equal(version.stdout.toString(), expected);
  assert.equal(fixture.requests.length, 0);
});

test('BI-09: source не требует curl и jq', async (t) => {
  const fixture = await startHttpFixture(t, (request, response) => {
    response.end(echoBody(request));
  });
  const result = await runProcess(t, process.execPath, [SOURCE_MAIN, 'comment', '7', 'без', 'jq'], {
    env: {
      PATH: '',
      GRIGDESK_URL: fixture.baseUrl,
      GRIGDESK_TOKEN: TOKEN,
    },
  });
  const request = fixture.requests[0];

  assert.ok(request);
  assert.equal(request.body.toString(), JSON.stringify({ text: 'без jq' }));
  assertSuccess(result, echoBody(request));
});

test('BI-10: разные cwd и пробелы в пути исходника сохраняют аргументы', async (t) => {
  const fixture = await startHttpFixture(t, (request, response) => {
    response.end(echoBody(request));
  });
  const copy = await mkdtemp(path.join(os.tmpdir(), 'tracker исходник с пробелами '));

  for (const name of ['tracker/src', 'tracker/package.json', 'shared']) {
    await cp(path.join(REPO, name), path.join(copy, name), { recursive: true });
  }

  for (const cwd of ['/', copy]) {
    const result = await runProcess(t, process.execPath, [path.join(copy, 'tracker/src/main.ts'), 'comment', '9',
      ' ведущий', 'хвост ', ''], {
      env: {
        PATH: '/usr/bin:/bin',
        GRIGDESK_URL: fixture.baseUrl,
        GRIGDESK_TOKEN: TOKEN,
      },
      cwd,
    });
    const request = fixture.requests.at(-1);

    assert.ok(request, result.stderr.toString());
    assert.equal(request.body.toString(), JSON.stringify({ text: ' ведущий хвост  ' }));
    assertSuccess(result, echoBody(request));
  }
});

test('BI-11: прокси из окружения не используется, запрос идёт к GrigDesk напрямую', async (t) => {
  const fixture = await startHttpFixture(t, (request, response) => {
    response.end(echoBody(request));
  });
  const { home } = await syntheticHome();
  const proxy = await startProxyFixture(t);
  const result = await runProcess(t, process.execPath, [SOURCE_MAIN, 'dashboard'], {
    env: childEnv(home, {
      GRIGDESK_URL: fixture.baseUrl,
      GRIGDESK_TOKEN: TOKEN,
      NODE_USE_ENV_PROXY: '1',
      HTTP_PROXY: proxy.baseUrl,
      http_proxy: proxy.baseUrl,
    }),
  });

  assert.deepEqual({ origin: fixture.requests.length, ...proxy.calls }, {
    origin: 1,
    connections: 0,
    requests: 0,
    connects: 0,
  });
  assert.equal(result.code, 0, result.stderr.toString());
  assert.ok(result.stdout.equals(echoBody(fixture.requests[0]!)), result.stdout.toString());
});

test('BI-12: закрытый получатель stdout не роняет команду', async (t) => {
  const fixture = await startHttpFixture(t, (_request, response) => {
    response.end(Buffer.alloc(4 * 1024 * 1024, 0x61));
  });
  const { home } = await syntheticHome();
  const child = spawn(process.execPath, [SOURCE_MAIN, 'dashboard'], {
    env: childEnv(home, {
      GRIGDESK_URL: fixture.baseUrl,
      GRIGDESK_TOKEN: TOKEN,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr: Buffer[] = [];
  const killer = setTimeout(() => child.kill('SIGKILL'), 10_000);

  t.after(() => clearTimeout(killer));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  child.stdout.once('data', () => child.stdout.destroy());

  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });

  assert.equal(code, 0, Buffer.concat(stderr).toString());
  assert.equal(Buffer.concat(stderr).length, 0, Buffer.concat(stderr).toString());
});
