import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { HELP_TEXT } from '../../../b24/src/args.ts';
import { sendChunked, startHttpFixture } from '../helpers/httpFixture.mts';
import type { RecordedRequest } from '../helpers/httpFixture.mts';
import { childEnv, runProcess, syntheticHome } from '../helpers/processFixture.mts';
import { startProxyFixture } from '../helpers/proxyFixture.mts';
import { prepareCandidate, runBuild } from '../helpers/seaFixture.mts';
import type { SeaCandidate } from '../helpers/seaFixture.mts';

const TOKEN = 'tok-sea';
let candidate: SeaCandidate | undefined;
let explicitHash = '';

/**
 * SHA256 файла целиком: кандидат не должен меняться тестовым прогоном.
 * Файл около 120 МиБ, поэтому хэш считается один раз до и один раз после.
 */
async function hashOf(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

/**
 * Путь проверяемого файла после before; отсутствие — ошибка, а не skip.
 * Сообщение указывает на отказ подготовки кандидата.
 */
function binary(): string {
  if (!candidate) {
    throw new Error('Кандидат b24 не подготовлен');
  }

  return candidate.binary;
}

/**
 * Тело ответа фейка, по которому видно метод и путь запроса.
 * Позволяет сверить stdout побайтно.
 */
function echoBody(request: RecordedRequest): Buffer {
  return Buffer.from(`{"seen":"${request.method} ${request.url}","sea":"да"}\n`);
}

before(async () => {
  candidate = await prepareCandidate();

  if (candidate.explicit) {
    explicitHash = await hashOf(candidate.binary);
  }
}, { timeout: 15 * 60 * 1000 });

after(async () => {
  if (candidate?.explicit) {
    assert.equal(await hashOf(candidate.binary), explicitHash, 'тестовый прогон изменил кандидата');
  }

  await candidate?.cleanup();
});

test('BS-01: кандидат является самостоятельным ELF с правами 0755', async () => {
  const handle = await open(binary(), 'r');
  const magic = Buffer.alloc(4);

  try {
    await handle.read(magic, 0, 4, 0);
  } finally {
    await handle.close();
  }

  assert.deepEqual([...magic], [0x7f, 0x45, 0x4c, 0x46]);
  assert.equal((await stat(binary())).mode & 0o777, 0o755);
});

test('BS-02: копия без исходников и пустой PATH исполняет локальные команды', async (t) => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'b24 копия '));
  const directory = path.join(scratch, 'папка с пробелами');
  const copy = path.join(directory, 'b24');

  // Копия весит около 120 МиБ: убираем её после теста, чтобы прогоны не копили мусор.
  t.after(async () => {
    await rm(scratch, {
      recursive: true,
      force: true,
    });
  });
  await mkdir(directory, { recursive: true });
  await copyFile(binary(), copy);
  await chmod(copy, 0o755);

  const env = { PATH: '' };
  const help = await runProcess(t, copy, ['--help'], { env });
  const version = await runProcess(t, copy, ['--version'], { env });
  const license = await runProcess(t, copy, ['--license'], { env });

  assert.equal(help.code, 0);
  assert.equal(help.stdout.toString(), HELP_TEXT);
  assert.equal(version.code, 0);
  assert.equal(version.stdout.toString(), 'b24 0.1.0 (Node v24.21.0, linux x64)\n');
  assert.equal(license.code, 0);
  assert.match(license.stdout.toString(), /Node\.js is licensed for use as follows/);

  for (const result of [help, version, license]) {
    assert.equal(result.stderr.length, 0, result.stderr.toString());
  }
});

test('BS-03: NODE_OPTIONS не исполняет посторонний код', async (t) => {
  const result = await runProcess(t, binary(), ['--version'], {
    env: {
      PATH: '',
      NODE_OPTIONS: '--require /nonexistent-b24.js',
    },
  });

  assert.equal(result.code, 0, result.stderr.toString());
  assert.equal(result.stdout.toString(), 'b24 0.1.0 (Node v24.21.0, linux x64)\n');
  assert.equal(result.stderr.length, 0);
});

test('BS-04: SEA выполняет dashboard/comment/create/start через loopback', async (t) => {
  const fixture = await startHttpFixture(t, (request, response) => {
    if (request.url.endsWith('/renew')) {
      response.writeHead(502).end('{"renew":"тело"}');

      return;
    }

    sendChunked(response, 200, echoBody(request));
  });
  const { home } = await syntheticHome();
  const env = childEnv(home, {
    PATH: '',
    GRIGDESK_URL: fixture.baseUrl,
    GRIGDESK_TOKEN: TOKEN,
  });
  const input = '{"title":"Задача 🌍"}\r\n';
  const cases: Array<[string[], string, string, string | null, string | undefined]> = [
    [['dashboard'], 'GET', '/api/tracker/dashboard', null, undefined],
    [['comment', '5', 'два  слова', '$(id)'], 'POST', '/api/tracker/task/5/comment',
      JSON.stringify({ text: 'два  слова $(id)' }), undefined],
    [['create'], 'POST', '/api/tracker/tasks', input, input],
    [['start', '5'], 'POST', '/api/tracker/task/5/timer/start', null, undefined],
  ];

  for (const [args, method, url, body, stdin] of cases) {
    const result = await runProcess(t, binary(), args, {
      env,
      input: stdin,
    });
    const request = fixture.requests.at(-1);

    assert.ok(request);
    assert.equal(request.method, method);
    assert.equal(request.url, url);
    assert.equal(request.headers['x-grigdesk-token'], TOKEN);
    assert.equal(request.headers['content-type'], body === null ? undefined : 'application/json');
    assert.equal(request.body.toString(), body ?? '');
    assert.equal(result.code, 0, result.stderr.toString());
    assert.equal(result.stderr.length, 0);
    assert.ok(result.stdout.equals(echoBody(request)));
  }

  assert.deepEqual(fixture.requests.slice(-2).map((request) => request.url), [
    '/api/tracker/task/5/renew',
    '/api/tracker/task/5/timer/start',
  ]);
});

test('BS-05: SEA читает новые настройки и отказывает без токена', async (t) => {
  const fixture = await startHttpFixture(t, (request, response) => {
    response.end(`{"token":"${String(request.headers['x-grigdesk-token'])}"}`);
  });
  const { home, data } = await syntheticHome();
  const envFile = path.join(home, 'custom.env');

  await mkdir(path.join(data, 'state'), { recursive: true });
  await writeFile(path.join(home, 'token-file'), 'tok-custom\n');
  await writeFile(envFile, [
    `GRIGDESK_PORT=${new URL(fixture.baseUrl).port}`,
    `GRIGDESK_CLI_TOKEN_PATH=${path.join(home, 'token-file')}`,
    '',
  ].join('\n'));

  const ok = await runProcess(t, binary(), ['dashboard'], {
    env: childEnv(home, {
      PATH: '',
      GRIGDESK_ENV_FILE: envFile,
    }),
  });

  assert.equal(ok.code, 0, ok.stderr.toString());
  assert.equal(ok.stdout.toString(), '{"token":"tok-custom"}');

  await mkdir(path.join(home, 'code/server/.state'), { recursive: true });
  await writeFile(path.join(home, 'code/server/.state/cli-token'), 'tok-old');

  const missing = await runProcess(t, binary(), ['dashboard'], {
    env: childEnv(home, {
      PATH: '',
      GRIGDESK_URL: fixture.baseUrl,
    }),
    cwd: path.join(home, 'code'),
  });

  assert.equal(missing.code, 1);
  assert.equal(missing.stdout.length, 0);
  assert.equal(missing.stderr.toString(), `Нет токена: ${path.join(data, 'state/cli-token')}.\n`);
  assert.equal(fixture.requests.length, 1);
});

test('BS-06: SEA сохраняет ошибки source-контракта', async (t) => {
  const unknown = await runProcess(t, binary(), ['frobnicate'], { env: { PATH: '' } });

  assert.equal(unknown.code, 2);
  assert.equal(unknown.stdout.length, 0);
  assert.ok(unknown.stderr.toString().endsWith(HELP_TEXT));

  for (const status of [401, 502]) {
    const fixture = await startHttpFixture(t, (_request, response) => {
      response.writeHead(status).end('{"renew":"секрет"}');
    });
    const result = await runProcess(t, binary(), ['start', '1'], {
      env: {
        PATH: '',
        GRIGDESK_URL: fixture.baseUrl,
        GRIGDESK_TOKEN: TOKEN,
      },
    });

    assert.equal(result.code, 22);
    assert.equal(result.stdout.length, 0);
    assert.equal(result.stderr.toString(), `Запрос к GrigDesk завершился ошибкой HTTP ${status}.\n`);
  }

  const cut = await startHttpFixture(t, (_request, response) => {
    response.writeHead(200, { 'Content-Length': '100000' });
    response.write('{"partial":');
    setTimeout(() => {
      response.socket?.destroy();
    }, 20);
  });
  const broken = await runProcess(t, binary(), ['dashboard'], {
    env: {
      PATH: '',
      GRIGDESK_URL: cut.baseUrl,
      GRIGDESK_TOKEN: TOKEN,
    },
  });

  assert.equal(broken.code, 22);
  assert.equal(broken.stdout.length, 0);
  assert.equal(broken.stderr.toString(), 'Не удалось связаться с GrigDesk.\n');

  const { home } = await syntheticHome();
  const noToken = await runProcess(t, binary(), ['dashboard'], { env: childEnv(home, { PATH: '' }) });

  assert.equal(noToken.code, 1);
  assert.equal(noToken.stdout.length, 0);
});

test('BS-07: неудачная сборка не заменяет прежний результат', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'b24-sea-marker-'));
  const target = path.join(directory, 'b24');

  await writeFile(target, 'маркер прежней сборки');

  const badArgs = await runBuild(['--out-dir', directory, '--unknown']);

  assert.equal(badArgs.code, 2);
  assert.equal(await readFile(target, 'utf8'), 'маркер прежней сборки');

  // Родитель кэша — обычный файл: ENOTDIR наступает сразу. Каталог в /proc не годится:
  // рекурсивный mkdir Node на нём зацикливается и сборка висит до тайм-аута.
  const blocker = path.join(directory, 'не каталог');

  await writeFile(blocker, '');

  const badCache = await runBuild(['--out-dir', directory, '--cache-dir', path.join(blocker, 'cache')]);

  assert.equal(badCache.code, 1);
  assert.match(badCache.stderr, /^Сборка b24 не удалась: /);
  assert.equal(await readFile(target, 'utf8'), 'маркер прежней сборки');
});

test('BS-08: SEA игнорирует прокси даже с NODE_USE_ENV_PROXY=1', async (t) => {
  const fixture = await startHttpFixture(t, (request, response) => {
    response.end(echoBody(request));
  });
  const proxy = await startProxyFixture(t);
  const { home } = await syntheticHome();
  const result = await runProcess(t, binary(), ['dashboard'], {
    env: childEnv(home, {
      PATH: '',
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
