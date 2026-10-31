import assert from 'node:assert/strict';
import nodeTest, { before } from 'node:test';
import { customReadModule } from './helpers/trackerPackage.js';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';




import { TaskFavoritesService } from '../../server/src/lib/taskFavoritesService.ts';

/**
 * Барьер держит операцию до прямого освобождения в finally.
 * Тесты не обращаются к порталу и не зависят от скорости машины.
 */
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

/**
 * Подставной клиент позволяет удержать отдельную фазу производственного адаптера.
 * Сессия, очередь и кэш самого адаптера остаются настоящими.
 */
function fixture(client) {
  const adapter = new B24Adapter({
    host: {
      credentials: { read: () => null },
      serial: serial(),
      cookiePath: '/tmp/unused-b24-adapter-reads-cookie',
    },
  });

  adapter.client = () => client;

  return adapter;
}

test('ADAPTER-01: локальное избранное читает scope до занятой очереди', async () => {
  const held = deferred();
  const adapter = fixture({
    baseUrl: 'https://portal.example.test',
    discoverUserId: async () => 77,
    taskDetails: () => held.promise,
  });

  await adapter.accountIdentity();

  const busy = adapter.taskDetail('42');
  let readStore = false;
  const service = new TaskFavoritesService({
    tracker: adapter,
    store: {
      async list() {
        readStore = true;

        return { revision: 1, taskIds: [] };
      },
    },
  });
  const local = service.list();

  try {
    await setImmediate();
    assert.equal(readStore, true);
  } finally {
    held.resolve({});
    await Promise.all([busy, local]);
  }
});

test('ADAPTER-02: одинаковые dashboard объединены до следующей мутации', async () => {
  const held = deferred();
  const adapter = fixture({ timer: async () => ({ ok: true }) });
  let calls = 0;

  adapter._getDashboard = async () => {
    calls += 1;

    if (calls === 1) {
      await held.promise;
    }

    return { version: calls };
  };

  const first = adapter.getDashboard();
  const joined = adapter.getDashboard();

  await setImmediate();

  try {
    assert.equal(calls, 1);

    const mutation = adapter.timer('start', '42');
    const afterMutation = adapter.getDashboard();

    held.resolve();
    assert.deepEqual(await first, { version: 1 });
    assert.deepEqual(await joined, { version: 1 });
    await mutation;
    assert.deepEqual(await afterMutation, { version: 2 });
    assert.equal(calls, 2);
  } finally {
    held.resolve();
    await Promise.allSettled([first, joined]);
  }
});

test('ADAPTER-03: invalidate не даёт позднему определению вернуть старый scope', async () => {
  const held = deferred();
  let old = true;
  const adapter = fixture({
    baseUrl: 'https://portal.example.test',
    discoverUserId: () => old ? held.promise : Promise.resolve(88),
  });
  const first = adapter.accountIdentity().catch((error) => error);

  await setImmediate();
  adapter.invalidate();
  old = false;
  held.resolve(77);
  assert.equal((await first).name, 'AbortError');
  assert.equal((await adapter.accountIdentity()).userId, '88');
});

test('ADAPTER-04: изменения credentials не оставляют кэш прошлого аккаунта', async (t) => {
  let creds = {
    baseUrl: 'https://first.example.test',
    login: 'one',
    password: 'one',
  };

  t.mock.method(B24Client.prototype, 'discoverUserId', async function () {
    return this.login === 'one' ? 77 : 88;
  });

  const adapter = new B24Adapter({
    host: {
      credentials: { read: () => creds },
      serial: serial(),
      cookiePath: '/tmp/unused-b24-adapter-account-cookie',
    },
  });

  assert.equal((await adapter.accountIdentity()).userId, '77');
  creds = {
    baseUrl: 'https://second.example.test',
    login: 'two',
    password: 'two',
  };
  assert.equal((await adapter.accountIdentity()).userId, '88');
});

test('ADAPTER-05: все внешние читатели получают контекст, мутация его не получает', async () => {
  const names = ['taskDetails', 'taskPageData', 'findUsers', 'listGroups', 'probeTaskNumber'];
  const client = Object.fromEntries(names.map((name) => [name, async () => {
    assert.ok(currentB24Read()?.signal);

    return name === 'probeTaskNumber' ? 'exists' : {};
  }]));

  client.timer = async () => {
    assert.equal(currentB24Read(), undefined);

    return {};
  };

  const adapter = fixture(client);

  adapter.isConfigured = () => true;
  await adapter.taskDetail('42');
  await adapter.taskPageData('42');
  await adapter.findUsers('fixture');
  await adapter.listGroups();
  await adapter.probeTaskNumber('42');
  await adapter.timer('start', '42');
});

test('ADAPTER-06: живые cookies прежнего аккаунта не подтверждают новый логин или портал', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'b24-cookie-ownership-'));
  const cookiePath = path.join(root, 'cookies.json');
  const legacy = JSON.stringify({ fixture_session: '77' });

  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(cookiePath, legacy, { mode: 0o600 });

  let creds = {
    baseUrl: 'https://first.example.test',
    login: 'one',
    password: 'fixture-one',
  };
  let expected = 77;
  const logins = [];

  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(String(input));
    const cookie = String(options.headers?.Cookie ?? '');
    const id = Number(cookie.match(/fixture_session=(\d+)/u)?.[1] ?? 0);

    if (options.method === 'POST' && url.searchParams.get('login') === 'yes') {
      const form = new URLSearchParams(String(options.body));
      const login = form.get('USER_LOGIN');
      const userId = url.hostname === 'second.example.test' ? 99 : login === 'one' ? 77 : 88;

      logins.push(userId);

      return new Response('', { headers: { 'set-cookie': `fixture_session=${userId}; Path=/` } });
    }

    // Cookie предыдущего аккаунта не должна попасть даже в пробу авторизации нового.
    assert.ok(id === 0 || id === expected);

    if (url.pathname === '/local/ajax/notifications.php') {
      return new Response(JSON.stringify({ success: id > 0 }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response(`<a href="/personal/user/${id}/">fixture</a>`);
  });

  const adapter = new B24Adapter({
    host: {
      credentials: { read: () => creds },
      cookiePath,
      serial: serial(),
    },
  });

  assert.equal((await adapter.accountIdentity()).userId, '77');
  creds = {
    ...creds,
    login: 'two',
    password: 'fixture-two',
  };
  expected = 88;
  adapter.invalidate();
  assert.equal((await adapter.accountIdentity()).userId, '88');
  creds = { ...creds, baseUrl: 'https://second.example.test' };
  expected = 99;
  assert.equal((await adapter.accountIdentity()).userId, '99');
  assert.deepEqual(logins, [77, 88, 99]);
  assert.equal(await readFile(cookiePath, 'utf8'), legacy);
});

/**
 * Фикстура воспроизводит host.serial с той же непрерывной цепочкой.
 * Отказ не разрешает двум операциям работать с одной сессией одновременно.
 */
function serial() {
  let tail = Promise.resolve();

  return (fn) => {
    const result = tail.then(fn);

    tail = result.catch(() => undefined);

    return result;
  };
}

let B24ReadOperations;
let B24Client;
let B24Adapter;
let currentB24Read;
let missing = false;

before(async () => {
  const context = {
    skip: () => {
      missing = true;
    },
  };
  const reads = await customReadModule('src/readOperations.ts', context);

  if (reads) {
    ({ B24ReadOperations, currentB24Read } = reads);
    ({ B24Client } = await customReadModule('src/client.ts', context));
    ({ CustomSession: B24Adapter } = await customReadModule('src/session.ts', context));
  }
});

/**
 * Каждый сценарий получает явный skip только при отсутствующем необязательном пакете.
 * Ошибки подготовки и непустой неверный env по-прежнему прерывают before с ошибкой.
 */
function test(name, options, run) {
  const operation = run ?? options;
  const settings = run ? options : {};

  return nodeTest(name, settings, async (t) => {
    if (missing) {
      t.skip('пакет не подготовлен');

      return;
    }

    return operation(t);
  });
}
