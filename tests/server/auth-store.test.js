import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AuthStore } from '../../server/src/lib/authStore.ts';
import authPlugin from '../../server/src/plugins/auth.ts';
import authModule from '../../server/src/modules/auth/index.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');
const DAY_MS = 24 * 3600 * 1000;
const TTL_MS = 400 * DAY_MS;
const origin = 'http://127.0.0.1:28140';
const windowKey = 'AUTH_STORE_WINDOW_KEY_MARKER'.padEnd(43, '_');

/**
 * Хранилище живёт только на собственных временных файлах, время управляется тестом.
 * Прежний файл учётной записи передаётся текстом: важно и его содержимое, и побайтовая
 * неизменность после миграции.
 */
async function storeFixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-auth-store-'));
  const legacyAccountPath = path.join(root, 'auth-account.json');
  const sessionsPath = path.join(root, 'auth-sessions.json');
  let clock = options.start ?? Date.parse('2026-01-01T00:00:00.000Z');

  t.after(() => rm(root, { recursive: true, force: true }));

  if (options.legacy !== undefined) {
    await writeFile(legacyAccountPath, options.legacy, { mode: 0o600 });
  }

  if (options.sessions !== undefined) {
    await writeFile(sessionsPath, options.sessions, { mode: 0o600 });
  }

  return {
    root,
    legacyAccountPath,
    sessionsPath,
    advance: (ms) => {
      clock += ms;
    },
    open: () => new AuthStore({
      legacyAccountPath,
      sessionsPath,
      now: () => clock,
    }),
  };
}

/** Файл сессий читается целиком: проверяются и версия, и состав документа. */
async function sessionsFile(fixture) {
  return JSON.parse(await readFile(fixture.sessionsPath, 'utf8'));
}

test('AS-01: неистёкшая сессия плоского старого формата отвергается', async (t) => {
  const fixture = await storeFixture(t, {
    sessions: JSON.stringify({ 'legacy-session-id': Date.now() + TTL_MS }),
  });
  const store = fixture.open();

  assert.equal(store.isValidSession('legacy-session-id'), false);
  assert.equal(store.sessions.size, 0);
});

test('AS-02: новая сессия переживает создание нового AuthStore', async (t) => {
  const fixture = await storeFixture(t);
  const first = fixture.open();
  const created = first.createSession();

  assert.equal(created.maxAgeSec, 400 * 24 * 3600);

  const second = fixture.open();

  assert.equal(second.isValidSession(created.id), true);
  assert.equal((await sessionsFile(fixture)).version, 2);
});

test('AS-03: сессия действует 400 дней и перестаёт действовать после', async (t) => {
  const fixture = await storeFixture(t);
  const store = fixture.open();
  const created = store.createSession();

  fixture.advance(TTL_MS - 1);
  assert.equal(store.isValidSession(created.id), true);

  fixture.advance(2);
  assert.equal(store.isValidSession(created.id), false);
  assert.equal(store.sessions.size, 0);
});

test('AS-04: двадцать одна сессия вытесняет только самую старую', async (t) => {
  const fixture = await storeFixture(t);
  const store = fixture.open();
  const ids = [];

  for (let index = 0; index < 21; index += 1) {
    ids.push(store.createSession().id);
    fixture.advance(1000);
  }

  assert.equal(store.sessions.size, 20);
  assert.equal(store.isValidSession(ids[0]), false);

  for (const id of ids.slice(1)) {
    assert.equal(store.isValidSession(id), true, id);
  }

  assert.equal(Object.keys((await sessionsFile(fixture)).sessions).length, 20);

  const reopened = fixture.open();

  assert.equal(reopened.isValidSession(ids[0]), false);
  assert.equal(reopened.isValidSession(ids[20]), true);
});

test('AS-05: повреждённый файл и неизвестная версия не дают сессий', async (t) => {
  const damaged = await storeFixture(t, {
    legacy: JSON.stringify({ login: 'owner-from-legacy', hash: 'scrypt$fixture' }),
    sessions: '{ это не JSON',
  });
  const unknown = await storeFixture(t, {
    sessions: JSON.stringify({
      version: 3,
      clientScope: 'x',
      sessions: { fixture: Date.now() + TTL_MS },
    }),
  });

  for (const fixture of [damaged, unknown]) {
    const store = fixture.open();

    assert.equal(store.sessions.size, 0);
    assert.equal(store.isValidSession('fixture'), false);
    assert.equal(store.clientScope, fixture === damaged ? 'owner-from-legacy' : '');
  }
});

test('AS-06: после повреждённого файла scope снова переносится из старой учётки', async (t) => {
  const fixture = await storeFixture(t, {
    legacy: JSON.stringify({ login: 'owner-from-legacy', hash: 'scrypt$fixture' }),
    sessions: 'не json',
  });
  const store = fixture.open();
  const created = store.createSession();

  assert.equal(store.clientScope, 'owner-from-legacy');
  assert.equal((await sessionsFile(fixture)).clientScope, 'owner-from-legacy');

  const reopened = fixture.open();

  assert.equal(reopened.isValidSession(created.id), true);
  assert.equal(reopened.clientScope, 'owner-from-legacy');
});

test('AS-07: прежний строковый login становится тем же clientScope', async (t) => {
  const named = await storeFixture(t, {
    legacy: JSON.stringify({ login: 'Прежний Владелец', hash: 'scrypt$fixture' }),
  });
  const namedStore = named.open();

  assert.equal(namedStore.clientScope, 'Прежний Владелец');
  namedStore.createSession();
  assert.equal((await sessionsFile(named)).clientScope, 'Прежний Владелец');

  for (const legacy of [JSON.stringify({ hash: 'scrypt$fixture' }), '{}', '']) {
    const fixture = await storeFixture(t, { legacy });
    const store = fixture.open();

    store.createSession();
    assert.equal(store.clientScope, '');
    assert.equal((await sessionsFile(fixture)).clientScope, '');
  }
});

test('AS-08: после записи версии 2 старая учётка больше не меняет scope', async (t) => {
  const fixture = await storeFixture(t, {
    legacy: JSON.stringify({ login: 'owner-before', hash: 'scrypt$fixture' }),
  });
  const store = fixture.open();

  store.createSession();
  assert.equal(store.clientScope, 'owner-before');

  await writeFile(fixture.legacyAccountPath, JSON.stringify({
    login: 'owner-after',
    hash: 'scrypt$other',
  }));

  const reopened = fixture.open();

  assert.equal(reopened.clientScope, 'owner-before');
  assert.equal((await sessionsFile(fixture)).clientScope, 'owner-before');
});

test('AS-09: новый файл не хранит хеш, а прежняя учётка не перезаписывается', async (t) => {
  const legacyText = JSON.stringify({ login: 'owner', hash: 'scrypt$secret-hash' });
  const fixture = await storeFixture(t, { legacy: legacyText });
  const store = fixture.open();

  store.createSession();

  const raw = await readFile(fixture.sessionsPath, 'utf8');

  assert.equal(raw.includes('hash'), false);
  assert.equal(raw.includes('scrypt'), false);
  assert.equal(raw.includes('secret-hash'), false);
  assert.equal(await readFile(fixture.legacyAccountPath, 'utf8'), legacyText);
});

test('AS-10: запись атомарна и не трогает соседние файлы', async (t) => {
  const fixture = await storeFixture(t, { legacy: JSON.stringify({ login: 'owner' }) });
  const neighbour = path.join(fixture.root, 'neighbour.txt');

  await writeFile(neighbour, 'чужое содержимое');

  const store = fixture.open();

  store.createSession();
  store.createSession();

  const names = await readdir(fixture.root);

  assert.deepEqual(names.filter((name) => name.includes('tmp')), []);
  assert.deepEqual(names.sort(), ['auth-account.json', 'auth-sessions.json', 'neighbour.txt']);
  assert.equal(await readFile(neighbour, 'utf8'), 'чужое содержимое');

  const mode = (await stat(fixture.sessionsPath)).mode;

  assert.equal(mode & 0o777, 0o600);
});

test('AS-11: auth/state не раскрывает scope анонимно и отдаёт его с сессией', async (t) => {
  const fixture = await storeFixture(t, {
    legacy: JSON.stringify({ login: 'owner-scope-marker', hash: 'scrypt$fixture' }),
  });
  const authStore = fixture.open();
  const app = Fastify({ logger: false });

  t.after(async () => {
    await app.close();
  });

  await app.register(authPlugin, { authStore });
  await app.register(authModule, { authStore, windowAuth: { origin, key: windowKey } });

  const anonymous = await app.inject({
    method: 'GET',
    url: '/api/auth/state',
    remoteAddress: '127.0.0.1',
  });

  assert.equal(anonymous.statusCode, 200);
  assert.equal(Object.hasOwn(anonymous.json(), 'clientScope'), false);
  assert.equal(anonymous.payload.includes('owner-scope-marker'), false);

  const exchange = await app.inject({
    method: 'POST',
    url: '/api/auth/window-session',
    remoteAddress: '127.0.0.1',
    headers: {
      host: new URL(origin).host,
      'x-grigdesk-window-key': windowKey,
    },
  });
  const authorized = await app.inject({
    method: 'GET',
    url: '/api/auth/state',
    remoteAddress: '127.0.0.1',
    headers: { cookie: exchange.headers['set-cookie'].split(';')[0] },
  });

  assert.equal(authorized.json().authenticated, true);
  assert.equal(authorized.json().clientScope, 'owner-scope-marker');
  assert.equal(authorized.json().configured, true);
});


test('S2: двадцать долгих сессий не вытесняют новую короткую CLI-сессию', async (t) => {
  const fixture = await storeFixture(t);
  const store = fixture.open();
  const long = [];

  for (let index = 0; index < 20; index += 1) {
    long.push(store.createSession().id);
    fixture.advance(1);
  }

  const short = store.createSession({ ttlMs: 600000 }).id;

  assert.equal(store.isValidSession(short), true);
  assert.equal(long.every((id) => store.isValidSession(id)), true);

  for (let index = 0; index < 21; index += 1) {
    store.createSession({ ttlMs: 600000 });
    fixture.advance(1);
  }

  assert.equal(store.isValidSession(short), false);
  assert.equal(long.every((id) => store.isValidSession(id)), true);
  assert.equal(fixture.open().sessions.size, 40);
});
