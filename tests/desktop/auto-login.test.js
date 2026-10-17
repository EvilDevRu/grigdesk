import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import { chmod, link, mkdir, mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ensureSession,
  sessionCookieActive,
  readWindowKey,
  sessionFromSetCookie,
} from '../../desktop/src/autoLogin.ts';

const key = 'A'.repeat(43);
const setCookie = 'cockpit_sid=session_value; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600';
const origin = 'http://127.0.0.1:28140';

/**
 * Подмена Cookies повторяет реальные get/set без загрузки модуля Electron.
 * Записанные детали позволяют независимо проверить host-only и срок сессии.
 */
function cookieJar(existing = []) {
  const sets = [];

  return {
    sets,
    get: async (filter) => {
      assert.deepEqual(filter, {
        url: origin + '/',
        name: 'cockpit_sid',
      });

      return existing;
    },
    set: async (details) => {
      sets.push(details);
    },
  };
}

function response(status = 200, headers = [setCookie]) {
  return {
    status,
    headers: { getSetCookie: () => headers },
    json: async () => ({ authenticated: true }),
  };
}

/**
 * Файловый await допускает несколько оборотов event loop до вызова fetch.
 * Каркас без fetch получает assertion, а не бесконечное ожидание тестовой фикстуры.
 */
async function observe(predicate) {
  const deadline = Date.now() + 1000;

  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(predicate(), true, 'Не выполнен ожидаемый эффект');
}

/**
 * Все файловые проверки живут в одном личном временном root.
 * Cleanup не касается ни рабочего runtime, ни профиля настоящего окна.
 */
async function keyFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-auto-login-'));
  const file = path.join(root, 'key');

  t.after(() => rm(root, {
    recursive: true,
    force: true,
  }));
  await writeFile(file, key, { mode: 0o600 });

  return {
    root,
    file,
  };
}

test('DW-27: ключ читается из приватного дескриптора', async (t) => {
  const { root, file } = await keyFixture(t);

  assert.equal(await readWindowKey(file), key);
  await writeFile(file, '\n  ' + key + '\n');
  assert.equal(await readWindowKey(file), key);

  for (const value of ['A'.repeat(42), 'A'.repeat(44), '!'.repeat(43), 'A'.repeat(129)]) {
    await writeFile(file, value);
    assert.equal(await readWindowKey(file), null);
  }

  await writeFile(file, key);
  await chmod(file, 0o644);
  assert.equal(await readWindowKey(file), null);
  await chmod(file, 0o600);
  await symlink(file, path.join(root, 'key-link'));
  assert.equal(await readWindowKey(path.join(root, 'key-link')), null);
  await symlink(root, path.join(root, 'directory-link'));
  assert.equal(await readWindowKey(path.join(root, 'directory-link/key')), null);
  await mkdir(path.join(root, 'directory'), { mode: 0o700 });
  assert.equal(await readWindowKey(path.join(root, 'directory')), null);
  assert.equal(await readWindowKey(path.join(root, 'absent')), null);
  assert.equal(await readWindowKey(null), null);
  await link(file, path.join(root, 'hard-link'));
  assert.equal(await readWindowKey(file), null);
  await rm(path.join(root, 'hard-link'));
  await chmod(root, 0o750);
  assert.equal(await readWindowKey(file), null);
  await chmod(root, 0o700);
});

test('DW-27: рост файла ограничен 129 байтами и fd закрывается', async (t) => {
  const { file } = await keyFixture(t);
  const handle = await open(file, 'r');
  const originalStat = handle.stat.bind(handle);
  const originalRead = handle.read.bind(handle);
  let opened = false;
  let readLimit;

  t.after(async () => {
    if (handle.fd !== -1) {
      await handle.close();
    }
  });

  t.mock.method(fs, 'open', async (target, flags) => {
    opened = true;
    assert.equal(target, file);
    assert.equal(flags, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

    return handle;
  });
  t.mock.method(handle, 'stat', async () => {
    const beforeGrowth = await originalStat();

    await writeFile(file, 'A'.repeat(1024));

    return beforeGrowth;
  });
  t.mock.method(handle, 'read', async (buffer, offset, length, position) => {
    readLimit = buffer.length;
    assert.ok(offset + length <= 129);

    return originalRead(buffer, offset, length, position);
  });

  assert.equal(await readWindowKey(file), null);
  assert.equal(opened, true);
  assert.equal(readLimit, 129);
  assert.equal(handle.fd, -1);
});

test('DW-27: FIFO не блокирует открытие', { timeout: 2000 }, async (t) => {
  const { root } = await keyFixture(t);
  const fifo = path.join(root, 'fifo');

  try {
    execFileSync('mkfifo', [fifo], { timeout: 1000 });
  } catch (error) {
    if (error.code === 'ENOENT') {
      t.skip('mkfifo недоступен');

      return;
    }

    throw error;
  }

  assert.equal(await readWindowKey(fifo), null);
});

test('DW-28: разбирается только полная сессионная cookie', () => {
  assert.deepEqual(sessionFromSetCookie([setCookie]), {
    value: 'session_value',
    maxAgeSec: 3600,
  });
  assert.deepEqual(sessionFromSetCookie([
    'other=value; Secure',
    setCookie + '; Expires=Wed, 21 Oct 2037 07:28:00 GMT',
  ]), {
    value: 'session_value',
    maxAgeSec: 3600,
  });

  const invalid = [
    [],
    ['other=value; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600'],
    [setCookie.replace('session_value', '')],
    [setCookie.replace('session_value', 'unsafe=value')],
    [setCookie.replace('; Max-Age=3600', '')],
    [setCookie.replace('3600', '0')],
    [setCookie.replace('3600', '-1')],
    [setCookie.replace('3600', '1.5')],
    [setCookie.replace('3600', 'Infinity')],
    [setCookie.replace('3600', '9007199254740992')],
    [setCookie.replace('; Path=/', '')],
    [setCookie.replace('Path=/', 'Path=/api')],
    [setCookie.replace('; HttpOnly', '')],
    [setCookie.replace('SameSite=Lax', 'SameSite=None')],
    [setCookie + '; Domain=127.0.0.1'],
    [setCookie + '; Secure'],
    [setCookie, setCookie],
    [setCookie, setCookie.replace('session_value', 'different')],
    [setCookie + '; Max-Age=1'],
  ];

  for (const headers of invalid) {
    assert.equal(sessionFromSetCookie(headers), null, String(headers));
  }
});

test('DW-29: действующая cookie не обменивается', async (t) => {
  const { file } = await keyFixture(t);
  const cookies = cookieJar([{
    name: 'cockpit_sid',
    value: 'existing_sid',
  }]);
  const calls = [];
  const result = await ensureSession({
    origin,
    keyFile: file,
    cookies,
    fetchImpl: async (url, options) => {
      calls.push(url);
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error');
      assert.equal(new Headers(options.headers).get('cookie'), 'cockpit_sid=existing_sid');
      assert.equal(new Headers(options.headers).has('x-cockpit-window-key'), false);

      return response();
    },
  });

  assert.equal(result, 'session');
  assert.deepEqual(calls, [origin + '/api/auth/state']);
  assert.deepEqual(cookies.sets, []);
});

test('DW-30: ключ обменивается до загрузки веба', async (t) => {
  const { file } = await keyFixture(t);
  const cookies = cookieJar();
  let calls = 0;
  const result = await ensureSession({
    origin,
    keyFile: file,
    cookies,
    now: () => 1_700_000_000_999,
    fetchImpl: async (url, options) => {
      calls += 1;
      assert.equal(url, origin + '/api/auth/window-session');
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      assert.equal(options.signal instanceof AbortSignal, true);
      assert.equal(options.signal.aborted, false);
      assert.equal(options.body, undefined);
      assert.deepEqual(Object.fromEntries(new Headers(options.headers)), {
        'x-cockpit-window-key': key,
      });

      return response();
    },
  });

  assert.equal(result, 'window-key');
  assert.equal(calls, 1);
  assert.deepEqual(cookies.sets, [{
    url: origin + '/',
    name: 'cockpit_sid',
    value: 'session_value',
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: false,
    expirationDate: 1_700_003_600,
  }]);
});

test('DW-30: истёкшая cookie ведёт к ключу и заменяется новой', async (t) => {
  const { file } = await keyFixture(t);
  const cookies = cookieJar([{
    name: 'cockpit_sid',
    value: 'expired_sid',
  }]);
  const methods = [];

  assert.equal(await ensureSession({
    origin,
    keyFile: file,
    cookies,
    now: () => 1_700_000_000_999,
    fetchImpl: async (_url, options) => {
      methods.push(options.method);

      return options.method === 'GET'
        ? {
          ...response(),
          json: async () => ({ authenticated: false }),
        }
        : response();
    },
  }), 'window-key');
  assert.deepEqual(methods, ['GET', 'POST']);
  assert.deepEqual(cookies.sets, [{
    url: origin + '/',
    name: 'cockpit_sid',
    value: 'session_value',
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: false,
    expirationDate: 1_700_003_600,
  }]);
});

test('DW-31: ошибка оставляет отказ без повторов', async (t) => {
  const { file } = await keyFixture(t);

  for (const reply of [
    response(403),
    response(500),
    response(200, []),
    response(200, [setCookie + '; Secure']),
    {
      ...response(),
      headers: {
        getSetCookie: () => {
          throw new Error('ошибка getSetCookie');
        },
      },
    }]) {
    const cookies = cookieJar();
    let calls = 0;

    assert.equal(await ensureSession({
      origin,
      keyFile: file,
      cookies,
      fetchImpl: async () => {
        calls += 1;

        return reply;
      },
      sleep: async () => assert.fail('Повтор для этого отказа не разрешён'),
    }), 'unavailable');
    assert.equal(calls, 1);
    assert.deepEqual(cookies.sets, []);
  }

  const cookies = cookieJar();

  assert.equal(await ensureSession({
    origin,
    keyFile: file,
    cookies,
    fetchImpl: async () => {
      throw new Error('тестовый сетевой отказ');
    },
  }), 'unavailable');
  assert.deepEqual(cookies.sets, []);
});

test('DW-31: отсутствие или ошибка чтения дают два чтения и отказ', async (t) => {
  const { file } = await keyFixture(t);

  await chmod(file, 0o644);

  for (const keyFile of [null, file]) {
    const sleeps = [];

    assert.equal(await ensureSession({
      origin,
      keyFile,
      cookies: cookieJar(),
      fetchImpl: async () => assert.fail('Без приватного ключа нет запроса'),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    }), 'unavailable');
    assert.deepEqual(sleeps, [100]);
  }
});

test('DW-31: исключения JSON, cookies.get и cookies.set закрывают обмен', async (t) => {
  const { file } = await keyFixture(t);
  const brokenGet = cookieJar();

  brokenGet.get = async () => {
    throw new Error('ошибка get');
  };
  assert.equal(await ensureSession({
    origin,
    keyFile: file,
    cookies: brokenGet,
    fetchImpl: async () => assert.fail('После ошибки cookies.get запросов нет'),
  }), 'unavailable');

  const existing = cookieJar([{
    name: 'cockpit_sid',
    value: 'existing_sid',
  }]);

  assert.equal(await ensureSession({
    origin,
    keyFile: file,
    cookies: existing,
    fetchImpl: async () => ({
      ...response(),
      json: async () => {
        throw new SyntaxError('не JSON');
      },
    }),
  }), 'unavailable');
  assert.deepEqual(existing.sets, []);

  const brokenSet = cookieJar();
  let sets = 0;

  brokenSet.set = async () => {
    sets += 1;

    throw new Error('ошибка set');
  };
  assert.equal(await ensureSession({
    origin,
    keyFile: file,
    cookies: brokenSet,
    fetchImpl: async () => response(),
  }), 'unavailable');
  assert.equal(sets, 1);
});

test('DW-32: ротация перечитывает новый ключ один раз', async (t) => {
  for (const status of [401, 503]) {
    const { file } = await keyFixture(t);
    const cookies = cookieJar();
    const sent = [];
    const sleeps = [];

    assert.equal(await ensureSession({
      origin,
      keyFile: file,
      cookies,
      fetchImpl: async (_url, options) => {
        sent.push(new Headers(options.headers).get('x-cockpit-window-key'));

        if (sent.length === 1) {
          await writeFile(file, 'B'.repeat(43));

          return response(status);
        }

        return response();
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    }), 'window-key');
    assert.deepEqual(sent, [key, 'B'.repeat(43)]);
    assert.deepEqual(sleeps, [100]);
    assert.equal(cookies.sets.length, 1);
  }
});

test('DW-32: исчезнувший файл перечитывается, два отказа завершают вход', async (t) => {
  const { file } = await keyFixture(t);

  await rm(file);

  let calls = 0;
  const cookies = cookieJar();

  assert.equal(await ensureSession({
    origin,
    keyFile: file,
    cookies,
    fetchImpl: async () => {
      calls += 1;

      return response();
    },
    sleep: async (ms) => {
      assert.equal(ms, 100);
      await writeFile(file, key, { mode: 0o600 });
    },
  }), 'window-key');
  assert.equal(calls, 1);

  calls = 0;

  const deniedJar = cookieJar();
  const sleeps = [];

  assert.equal(await ensureSession({
    origin,
    keyFile: file,
    cookies: deniedJar,
    fetchImpl: async () => {
      calls += 1;

      return response(calls === 1 ? 401 : 503);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  }), 'unavailable');
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [100]);
  assert.deepEqual(deniedJar.sets, []);
});

test('DW-33: GET и POST ограничены таймаутами', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const { file } = await keyFixture(t);

  for (const method of ['GET', 'POST']) {
    const cookies = cookieJar(method === 'GET' ? [{
      name: 'cockpit_sid',
      value: 'existing_sid',
    }] : []);
    let signal;
    const pending = ensureSession({
      origin,
      keyFile: file,
      cookies,
      fetchImpl: (_url, options) => {
        assert.equal(options.method, method);
        assert.equal(options.redirect, 'error');
        signal = options.signal;

        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    });

    await observe(() => signal !== undefined);
    t.mock.timers.tick(method === 'GET' ? 1999 : 4999);
    assert.equal(signal.aborted, false);
    t.mock.timers.tick(1);
    assert.equal(signal.aborted, true);
    assert.equal(await pending, 'unavailable');
    assert.deepEqual(cookies.sets, []);
  }
});

test('DW-33: остановка запрещает следующий эффект после await', async (t) => {
  const { file } = await keyFixture(t);
  const controller = new AbortController();
  const deferred = Promise.withResolvers();
  const cookies = cookieJar();

  cookies.get = () => deferred.promise;

  const pending = ensureSession({
    origin,
    keyFile: file,
    cookies,
    signal: controller.signal,
    fetchImpl: async () => assert.fail('После abort нет fetch'),
  });

  controller.abort();
  deferred.resolve([]);
  assert.equal(await pending, 'unavailable');
  assert.deepEqual(cookies.sets, []);

  const postController = new AbortController();
  const postCookies = cookieJar();

  assert.equal(await ensureSession({
    origin,
    keyFile: file,
    cookies: postCookies,
    signal: postController.signal,
    fetchImpl: async () => ({
      ...response(),
      headers: {
        getSetCookie: () => {
          postController.abort();

          return [setCookie];
        },
      },
    }),
  }), 'unavailable');
  assert.deepEqual(postCookies.sets, []);

  const retryController = new AbortController();
  let calls = 0;

  assert.equal(await ensureSession({
    origin,
    keyFile: file,
    cookies: cookieJar(),
    signal: retryController.signal,
    fetchImpl: async () => {
      calls += 1;

      return response(401);
    },
    sleep: async () => retryController.abort(),
  }), 'unavailable');
  assert.equal(calls, 1);
});

/**
 * Redirect ведёт на второй собственный loopback listener, без внешнего сайта.
 * После закрытия каждого сервера не остаётся открытых сокетов фикстуры.
 */
async function redirectFixture(t) {
  const received = [];
  const requested = [];
  const target = createServer((request, reply) => {
    received.push(request.headers);
    reply.end('чужой получатель');
  });

  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));

  const destination = `http://127.0.0.1:${target.address().port}/target`;
  const source = createServer((request, reply) => {
    requested.push(request.method);
    reply.writeHead(307, { Location: destination });
    reply.end();
  });

  await new Promise((resolve) => source.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => source.close(resolve));
    await new Promise((resolve) => target.close(resolve));
  });

  return {
    origin: `http://127.0.0.1:${source.address().port}`,
    received,
    requested,
  };
}

test('DW-33: секрет не уходит при настоящем redirect', async (t) => {
  const { file } = await keyFixture(t);
  const fixture = await redirectFixture(t);

  for (const existing of [[], [{
    name: 'cockpit_sid',
    value: 'existing_sid',
  }]]) {
    const sets = [];

    assert.equal(await ensureSession({
      origin: fixture.origin,
      keyFile: file,
      cookies: {
        get: async () => existing,
        set: async (details) => {
          sets.push(details);
        },
      },
    }), 'unavailable');
    assert.deepEqual(sets, []);
    assert.deepEqual(fixture.received, []);
  }

  assert.deepEqual(fixture.requested, ['POST', 'GET']);
});

test('DW-33: внешняя отмена прерывает зависший GET и POST', async (t) => {
  const { file } = await keyFixture(t);

  for (const existing of [[], [{
    name: 'cockpit_sid',
    value: 'existing_sid',
  }]]) {
    const cookies = cookieJar(existing);
    const controller = new AbortController();
    let requests = 0;
    let signal;
    const pending = ensureSession({
      origin,
      keyFile: file,
      cookies,
      signal: controller.signal,
      fetchImpl: (_url, options) => {
        requests += 1;
        signal = options.signal;

        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
      sleep: async () => assert.fail('После внешней отмены не требуется повтор'),
    });

    await observe(() => signal !== undefined);
    controller.abort();
    assert.equal(await pending, 'unavailable');
    assert.equal(signal.aborted, true);
    assert.equal(requests, 1);
    assert.deepEqual(cookies.sets, []);
  }
});


test('SW-N06 проверка cookie без обмена ключом', async (t) => {
  const calls = [];
  const cookies = cookieJar([{ name: 'cockpit_sid', value: 'session_value' }]);
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });

    return response();
  };

  assert.equal(await sessionCookieActive({
    origin,
    cookies,
    fetchImpl
  }), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, origin + '/api/auth/state');
  assert.equal(calls[0].options.headers.Cookie, 'cockpit_sid=session_value');
  assert.equal(calls[0].options.redirect, 'error');

  for (const existing of [[],
    [{ name: 'cockpit_sid', value: 'bad!' }],
    [{ name: 'cockpit_sid', value: 'a' }, { name: 'cockpit_sid', value: 'b' }]]) {
    assert.equal(await sessionCookieActive({
    origin,
    cookies: cookieJar(existing),
    fetchImpl
  }), false);
  }

  assert.equal(calls.length, 1);

  for (const result of [response(401), { status: 200, json: async () => ({ authenticated: false }) }]) {
    assert.equal(await sessionCookieActive({
    origin,
    cookies,
    fetchImpl: async () => result
  }), false);
  }

  await assert.rejects(sessionCookieActive({
    origin,
    cookies,
    fetchImpl: async () => ({ status: 200, json: async () => {
      throw new Error('HTML');
    } }),
  }), /HTML/);

  const cancelled = new AbortController();

  cancelled.abort();
  assert.equal(await sessionCookieActive({
    origin,
    cookies,
    fetchImpl,
    signal: cancelled.signal
  }), false);
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const pending = sessionCookieActive({
    origin,
    cookies,
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }),
  });

  await Promise.resolve();

  const rejected = assert.rejects(pending);

  t.mock.timers.tick(2000);
  await rejected;
});
