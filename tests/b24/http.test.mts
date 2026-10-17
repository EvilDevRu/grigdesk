import assert from 'node:assert/strict';
import test from 'node:test';

import { B24Error } from '../../b24/src/errors.ts';
import { request } from '../../b24/src/http.ts';
import { sendChunked, startHttpFixture } from './helpers/httpFixture.mts';

const TOKEN = 'secret-token-value';
const TIMEOUT_MESSAGE = 'Cockpit не ответил за 300 с: операция могла выполниться — '
  + 'проверьте результат перед повтором.';

/**
 * Проверяет отказ с кодом 22 и точным русским сообщением.
 * Ни токен, ни тело ответа не попадают в message.
 */
async function rejects22(promise: Promise<unknown>, message: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof B24Error, String(error));
    assert.equal(error.code, 22);
    assert.equal(error.message, message);
    assert.ok(!error.message.includes(TOKEN));

    return true;
  });
}

test('BH-01: успешный ответ сохраняется побайтно', async (t) => {
  const body = Buffer.from('{"title":"Задача 🌍","note":"  пробелы  "}\n');

  for (const status of [200, 201, 299]) {
    const fixture = await startHttpFixture(t, (_request, response) => {
      sendChunked(response, status, body);
    });
    const result = await request({
      baseUrl: fixture.baseUrl,
      token: TOKEN,
    }, {
      method: 'GET',
      path: '/api/b24/dashboard',
    });

    assert.ok(Buffer.from(result).equals(body), String(status));
  }

  const empty = await startHttpFixture(t, (_request, response) => {
    response.writeHead(204).end();
  });
  const result = await request({
    baseUrl: empty.baseUrl,
    token: TOKEN,
  }, {
    method: 'POST',
    path: '/api/b24/task/1/renew',
  });

  assert.equal(result.byteLength, 0);
});

test('BH-02: HTTP-отказ скрывает тело и возвращает 22', async (t) => {
  for (const status of [301, 302, 307, 400, 401, 403, 404, 500, 502]) {
    const fixture = await startHttpFixture(t, (_request, response) => {
      const html = status % 2 === 0;

      response.writeHead(status, {
        'Content-Type': html ? 'text/html' : 'application/json',
        Location: '/elsewhere',
      });
      response.end(html ? '<html>секрет</html>' : '{"error":"секрет"}');
    });

    await rejects22(request({
      baseUrl: fixture.baseUrl,
      token: TOKEN,
    }, {
      method: 'GET',
      path: '/api/b24/dashboard',
    }), `Запрос к Cockpit завершился ошибкой HTTP ${status}.`);
  }
});

test('BH-03: redirect не получает второй запрос и токен', async (t) => {
  const target = await startHttpFixture(t, (_request, response) => {
    response.end('{}');
  });
  const source = await startHttpFixture(t, (_request, response) => {
    response.writeHead(302, { Location: `${target.baseUrl}/api/b24/dashboard` }).end();
  });

  await rejects22(request({
    baseUrl: source.baseUrl,
    token: TOKEN,
  }, {
    method: 'GET',
    path: '/api/b24/dashboard',
  }), 'Запрос к Cockpit завершился ошибкой HTTP 302.');
  assert.equal(source.requests.length, 1);
  assert.equal(target.requests.length, 0);
});

test('BH-04: сетевой обрыв, в том числе после 200, возвращает 22', async (t) => {
  const before = await startHttpFixture(t, (_request, response) => {
    response.socket?.destroy();
  });
  const middle = await startHttpFixture(t, (_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': '100000',
    });
    response.write('{"partial":');
    setTimeout(() => {
      response.socket?.destroy();
    }, 20);
  });
  const network = 'Не удалось связаться с Cockpit.';

  for (const fixture of [before, middle]) {
    await rejects22(request({
      baseUrl: fixture.baseUrl,
      token: TOKEN,
    }, {
      method: 'GET',
      path: '/api/b24/dashboard',
    }), network);
  }

  await rejects22(request({
    baseUrl: 'http://127.0.0.1:1',
    token: TOKEN,
  }, {
    method: 'GET',
    path: '/api/b24/dashboard',
  }), network);
});

test('BH-05: JSON-заголовок ставится только по RequestSpec.json', async (t) => {
  const fixture = await startHttpFixture(t, (_request, response) => {
    response.end('{}');
  });
  const connection = {
    baseUrl: fixture.baseUrl,
    token: TOKEN,
  };

  await request(connection, {
    method: 'GET',
    path: '/api/b24/dashboard',
  });
  await request(connection, {
    method: 'POST',
    path: '/api/b24/task/1/renew',
  });
  await request(connection, {
    method: 'POST',
    path: '/api/b24/task/1/comment',
    body: '{"text":"т"}',
    json: true,
  });
  await request(connection, {
    method: 'POST',
    path: '/api/b24/tasks',
    body: new Uint8Array(Buffer.from('{"title":"т"}\n')),
    json: true,
  });

  const [get, post, comment, create] = fixture.requests;

  assert.ok(get && post && comment && create);
  assert.equal(get.headers['content-type'], undefined);
  assert.equal(post.headers['content-type'], undefined);
  assert.equal(post.body.length, 0);
  assert.equal(comment.headers['content-type'], 'application/json');
  assert.equal(create.headers['content-type'], 'application/json');
  assert.equal(comment.headers['content-length'], String(Buffer.byteLength('{"text":"т"}')));
  assert.equal(create.headers['content-length'], String(Buffer.byteLength('{"title":"т"}\n')));
  assert.equal(create.body.toString(), '{"title":"т"}\n');

  for (const recorded of fixture.requests) {
    assert.equal(recorded.headers['x-cockpit-token'], TOKEN);
  }
});

test('BH-02a: HTTP-отказ называет причину из поля message сервера', async (t) => {
  const long = 'я'.repeat(600);
  const cases: Array<[unknown, string, string]> = [
    [
      { error: 'b24_not_configured', message: 'B24 не настроен: заполните логин/пароль в Настройках.' },
      'application/json; charset=utf-8',
      'Запрос к Cockpit завершился ошибкой HTTP 400: B24 не настроен: заполните логин/пароль в Настройках.',
    ],
    [
      { message: 'строка1\nстрока2\u001b[31m' },
      'application/json',
      'Запрос к Cockpit завершился ошибкой HTTP 400: строка1 строка2 [31m.',
    ],
    [
      { message: long },
      'application/json',
      `Запрос к Cockpit завершился ошибкой HTTP 400: ${'я'.repeat(500)}…`,
    ],
    [{ message: 42 }, 'application/json', 'Запрос к Cockpit завершился ошибкой HTTP 400.'],
    [{ message: 'не JSON-тип' }, 'text/plain', 'Запрос к Cockpit завершился ошибкой HTTP 400.'],
    [
      { message: 'слишком большое тело', pad: 'x'.repeat(70 * 1024) },
      'application/json',
      'Запрос к Cockpit завершился ошибкой HTTP 400.',
    ],
  ];

  for (const [body, type, expected] of cases) {
    const fixture = await startHttpFixture(t, (_request, response) => {
      response.writeHead(400, { 'Content-Type': type });
      response.end(JSON.stringify(body));
    });

    await rejects22(request({
      baseUrl: fixture.baseUrl,
      token: TOKEN,
    }, {
      method: 'GET',
      path: '/api/b24/dashboard',
    }), expected);
  }
});

test('BH-02a: повреждённый JSON не становится причиной HTTP-отказа', async (t) => {
  const fixture = await startHttpFixture(t, (_request, response) => {
    response.writeHead(502, { 'Content-Type': 'application/json' });
    response.end('{"message":');
  });

  await rejects22(request({
    baseUrl: fixture.baseUrl,
    token: TOKEN,
  }, {
    method: 'GET',
    path: '/api/b24/dashboard',
  }), 'Запрос к Cockpit завершился ошибкой HTTP 502.');
});

const unsafeReasons = [
  ['маскирует каждое вхождение токена', `токен ${TOKEN}; снова ${TOKEN}`, 'токен ***; снова ***'],
  ['очищает C1 вместе с C0 и DEL', 'до\u0000\u001f\u007f\u0080\u009b31m\u009fпосле',
    'до     31m после'],
  ['маскирует токен до обрезки на 500 знаках', `${'я'.repeat(498)}${TOKEN} хвост`, `${'я'.repeat(498)}**…`],
] as const;

for (const [label, message, expected] of unsafeReasons) {
  test(`BH-02a: причина ${label}`, async (t) => {
    const fixture = await startHttpFixture(t, (_request, response) => {
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ message }));
    });
    const end = expected.endsWith('…') ? '' : '.';

    await rejects22(request({
      baseUrl: fixture.baseUrl,
      token: TOKEN,
    }, {
      method: 'GET',
      path: '/api/b24/dashboard',
    }), `Запрос к Cockpit завершился ошибкой HTTP 400: ${expected}${end}`);
  });
}

for (const status of [undefined, 200, 502]) {
  const label = status === undefined ? 'без заголовков' : `в теле ${status}`;

  test(`BH-06: простой ${label} предупреждает о возможном выполнении`, { timeout: 3000 }, async (t) => {
    const fixture = await startHttpFixture(t, (_request, response) => {
      if (status !== undefined) {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.write('{"partial":');
      }
    });

    await rejects22(request({
      baseUrl: fixture.baseUrl,
      token: TOKEN,
    }, {
      method: 'POST',
      path: '/api/b24/tasks',
      body: '{}',
      json: true,
    }, { timeoutMs: 100 }), TIMEOUT_MESSAGE);
    assert.equal(fixture.requests.length, 1);
  });
}
