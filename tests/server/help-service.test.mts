import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compileHelpSources } from '../../shared/node/helpSources.ts';
import { createHelpService } from '../../server/src/lib/help/service.ts';
import helpModule from '../../server/src/modules/help/index.ts';
import authPlugin from '../../server/src/plugins/auth.ts';
import { AuthStore } from '../../server/src/lib/authStore.ts';
import { localeCorpus, localeSource } from '../helpers/helpLocale.mts';
import { mkdir, writeFile } from 'node:fs/promises';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

test('HELP-API1: настоящий auth, один load, безопасная ошибка и повтор', async (t) => {
  const corpus = await compileHelpSources(path.resolve(import.meta.dirname, '../..'), {
    version: '0.1.0', commit: 'source'
  });
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'help-auth-'));
  const authStore = new AuthStore({
    legacyAccountPath: path.join(temporary, 'account.json'),
    sessionsPath: path.join(temporary, 'sessions.json')
  });
  const session = authStore.createSession();
  const cookie = `grigdesk_sid=${session.id}`;
  let calls = 0;
  let fail = true;
  const help = createHelpService({
    root: '/',
    kind: 'packaged',
    read: async () => {
      calls += 1;

      if (fail) {
        throw new Error('PRIVATE-PATH-SENTINEL');
      }

      return corpus;
    }
  });
  const app = Fastify();

  t.after(async () => {
    await app.close();
    await rm(temporary, {
      recursive: true, force: true
    });
  });
  await app.register(authPlugin, {
    authStore
  });
  await app.register(helpModule, {
    help
  });
  app.get('/api/fixture-health', async () => ({
    ok: true
  }));
  assert.equal((await app.inject('/api/help')).statusCode, 401);
  assert.equal((await app.inject('/%61pi/help')).statusCode, 401);

  const denied = await app.inject({
    url: '/api/help', headers: {
      cookie
    }
  });

  assert.equal(denied.statusCode, 503);
  assert.equal(denied.body.includes('PRIVATE-PATH-SENTINEL'), false);
  assert.equal((await app.inject({
    url: '/api/fixture-health', headers: {
      cookie
    }
  })).statusCode, 200);
  fail = false;

  const [left, right] = await Promise.all([help.bundle(), help.bundle()]);

  assert.deepEqual(left, right);
  assert.equal(calls, 2);

  const response = await app.inject({
    url: '/api/help', headers: {
      cookie
    }
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), corpus);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(await help.invoke({
    action: 'read', id: '../private'
  }), {
    ok: false, error: 'help_input_invalid'
  });
});


/**
 * Настоящий auth guard хранит сессии только внутри тестового каталога.
 * Один сервис обслуживает HTTP и tool, поэтому identity проверяется без сетевого дубля.
 */
async function localizedApi(t: import('node:test').TestContext, kind: 'source' | 'packaged') {
  const box = await localeSource(t);

  if (kind === 'packaged') {
    await mkdir(path.join(box.root, 'server/help'), { recursive: true });
    await writeFile(path.join(box.root, 'server/help/help.json'), JSON.stringify(localeCorpus('ru')));
    await writeFile(path.join(box.root, 'server/help/help.en.json'), JSON.stringify(localeCorpus('en')));
  }

  const authStore = new AuthStore({
    legacyAccountPath: path.join(box.root, 'account.json'),
    sessionsPath: path.join(box.root, 'sessions.json'),
  });
  const session = authStore.createSession();
  const headers = { cookie: `grigdesk_sid=${session.id}` };
  const help = createHelpService({ root: box.root, kind });
  const app = Fastify();

  t.after(() => app.close());
  await app.register(authPlugin, { authStore });
  await app.register(helpModule, { help });

  return {
    ...box,
    app,
    help,
    headers,
    authStore,
    session,
  };
}

for (const kind of ['source', 'packaged'] as const) {
  test(`HELP-API-L1: ${kind}, HTTP default/ru/en дают собственный корпус`, async (t) => {
    const h = await localizedApi(t, kind);

    for (const [query, locale] of [['', 'ru'], ['?locale=ru', 'ru'], ['?locale=en', 'en']]) {
      const response = await h.app.inject({ url: '/api/help' + query, headers: h.headers });

      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.json().locale, locale);
      assert.equal(response.json().version, '0.1.0');
      assert.equal(response.json().articles[1].title,
        locale === 'en' ? 'Chat working directory' : 'Рабочая папка');
    }
  });
}

test('HELP-API-L2: auth обеих локалей, строгий query и EN unavailable без RU подмены', async (t) => {
  const h = await localizedApi(t, 'packaged');

  for (const locale of ['ru', 'en']) {
    assert.equal((await h.app.inject('/api/help?locale=' + locale)).statusCode, 401);
  }

  const reader = t.mock.method(h.help, 'bundle', h.help.bundle);

  for (const query of ['locale=de', 'locale=../en', 'locale=en&locale=ru', 'locale[]=en']) {
    const response = await h.app.inject({ url: '/api/help?' + query, headers: h.headers });

    assert.equal(response.statusCode, 400, query);
    assert.equal(response.json().error, 'help_input_invalid');
  }

  assert.equal(reader.mock.callCount(), 0, 'Невалидная локаль отвергается до чтения');
  await rm(path.join(h.root, 'server/help/help.en.json'));

  const unavailable = await h.app.inject({ url: '/api/help?locale=en', headers: h.headers });

  assert.equal(unavailable.statusCode, 404);
  assert.deepEqual(unavailable.json(), { error: 'help_locale_unavailable', locale: 'en' });
  assert.deepEqual(await h.help.invoke({ action: 'index', locale: 'en' }), {
    ok: false,
    error: 'help_locale_unavailable',
    locale: 'en',
  });
  await writeFile(path.join(h.root, 'server/help/help.en.json'), JSON.stringify(localeCorpus('en')));

  const recovered = await h.app.inject({ url: '/api/help?locale=en', headers: h.headers });

  assert.equal(recovered.statusCode, 200);
  assert.equal(recovered.json().locale, 'en');
  h.authStore.sessions.delete(h.session.id);

  for (const locale of ['ru', 'en']) {
    assert.equal((await h.app.inject({
      url: '/api/help?locale=' + locale, headers: h.headers,
    })).statusCode, 401);
  }
});

test('HELP-API-L2: pending разделён по локали, отказ EN не отравляет RU и повтор', async () => {
  const calls: unknown[] = [];
  let fail = true;
  const help = createHelpService({
    root: '/',
    kind: 'packaged',
    read: async (...args: unknown[]) => {
      const locale = args[0] === 'en' ? 'en' : 'ru';

      calls.push(args[0]);

      if (locale === 'en' && fail) {
        throw new Error('PRIVATE-SENTINEL');
      }

      return localeCorpus(locale) as Awaited<ReturnType<typeof compileHelpSources>>;
    },
  });
  const read = (locale: string) => Reflect.apply(help.bundle, help, [locale]);
  const [ru, en] = await Promise.allSettled([read('ru'), read('en')]);

  assert.equal(ru.status, 'fulfilled');
  assert.equal(en.status, 'rejected');
  fail = false;
  assert.equal((await read('en')).locale, 'en');
  assert.equal((await read('ru')).locale, 'ru');
  assert.deepEqual(calls, ['ru', 'en', 'en']);
});

for (const defect of ['sha', 'locale', 'json']) {
  test(`HELP-API-L2: EN ${defect} даёт безопасный 503, RU цел и EN повторяется`, async (t) => {
    const h = await localizedApi(t, 'packaged');
    const good = localeCorpus('en');
    const bytes = defect === 'json' ? '{PRIVATE-SENTINEL' : JSON.stringify(defect === 'sha'
      ? { ...good, revision: '0'.repeat(64) } : localeCorpus('ru'));

    await writeFile(path.join(h.root, 'server/help/help.en.json'), bytes);

    const ru = await h.app.inject({ url: '/api/help', headers: h.headers });
    const failed = await h.app.inject({ url: '/api/help?locale=en', headers: h.headers });

    assert.equal(ru.statusCode, 200);
    assert.equal(failed.statusCode, 503);
    assert.equal(failed.json().error, 'help_unavailable');
    assert.equal(failed.headers['cache-control'], 'no-store');
    assert.equal(failed.body.includes('PRIVATE-SENTINEL'), false);
    await writeFile(path.join(h.root, 'server/help/help.en.json'), JSON.stringify(good));

    const recovered = await h.app.inject({ url: '/api/help?locale=en', headers: h.headers });

    assert.equal(recovered.statusCode, 200);
    assert.equal(recovered.json().locale, 'en');
  });
}
