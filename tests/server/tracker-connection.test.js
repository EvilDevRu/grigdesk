import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { selectTracker, trackerFixture, writeTracker } from './helpers/trackerFixture.js';

const endpoint = '/api/trackers/test-connection';
const secret = 'fixture-stored-access-token';

/**
 * Драйвер фиксирует отдельную сессию проверки и читает реквизиты при создании.
 * Такой кеш обнаруживает подмену credentials у уже работающего экземпляра доски.
 */
async function setupConnection(config) {
  await mkdir(path.dirname(config.trackerSettingsPath), { recursive: true });
  await writeTracker(config, 'active-board');

  const probesPath = path.join(path.dirname(config.trackerSettingsPath), 'probes.jsonl');

  await writeTracker(config, 'fixture-jira', {
    manifest: {
      name: 'Jira Cloud',
      settings: {
        email: { type: 'string' },
        token: { type: 'string', secret: true },
      },
    },
    code: `
      import { appendFileSync, writeFileSync } from 'node:fs';
      export default function createDriver(host) {
        const credentials = host.credentials.read();

        if (!credentials?.email) {
          throw new Error('Не задан email для создания сессии');
        }

        return {
          id: 'fixture-jira',
          capabilities: {},
          isConfigured: () => Boolean(credentials?.token),
          taskDetail: async () => null,
          testAuth: async () => {
            writeFileSync(host.cookiePath, 'probe-cookie');
            appendFileSync(${JSON.stringify(probesPath)},
              JSON.stringify({ directory: host.dataDir, phase: 'test' }) + '\\n');
            if (credentials?.token === 'throw-secret') {
              throw new Error('Authorization: ' + credentials.token);
            }
            return credentials?.token === ${JSON.stringify(secret)}
              && credentials?.email === 'draft@fixture.invalid'
              ? { ok: true, userId: 7 }
              : { ok: false, error: 'Jira 401: ' + credentials?.token };
          },
          dispose: async () => {
            appendFileSync(${JSON.stringify(probesPath)},
              JSON.stringify({ directory: host.dataDir, phase: 'dispose' }) + '\\n');
          },
        };
      }
    `,
  });
}

test('Черновик проверяет нужный драйвер, сохраняет секрет и изолирует cookie от доски', async (t) => {
  const fixture = await trackerFixture(t, { setup: setupConnection });

  await selectTracker(fixture, 'active-board', {
    'fixture-jira': { email: 'saved@fixture.invalid', token: secret },
  });

  const cookiePath = path.join(path.dirname(fixture.config.trackerSettingsPath),
    'tracker-data/fixture-jira/cookies.json');

  await mkdir(path.dirname(cookiePath), { recursive: true });
  await writeFile(cookiePath, 'saved-cookie');

  const beforeSettings = await readFile(fixture.config.trackerSettingsPath, 'utf8');
  const beforeCredentials = await readFile(fixture.config.trackerCredentialsPath, 'utf8');
  const beforeEvents = fixture.events.length;
  const revision = fixture.runtime.selection.read().revision;
  const response = await fixture.request('POST', endpoint, {
    driverId: 'fixture-jira',
    settings: { email: 'draft@fixture.invalid', token: '' },
    expectedRevision: revision,
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { ok: true });
  assert.equal(await readFile(fixture.config.trackerSettingsPath, 'utf8'), beforeSettings);
  assert.equal(await readFile(fixture.config.trackerCredentialsPath, 'utf8'), beforeCredentials);
  assert.equal(await readFile(cookiePath, 'utf8'), 'saved-cookie');
  assert.equal(fixture.events.length, beforeEvents);
  assert.deepEqual(fixture.runtime.registry.activeIds, ['own', 'active-board']);

  const probes = (await readFile(path.join(path.dirname(cookiePath), '../../probes.jsonl'), 'utf8'))
    .trim().split('\n').map(JSON.parse);

  assert.deepEqual(probes.map((probe) => probe.phase), ['test', 'dispose']);
  assert.equal(probes[0].directory, probes[1].directory);
  assert.equal(existsSync(probes[0].directory), false);
  assert.equal(fixture.logs.join('').includes(secret), false);
});

test('Отказ и исключение драйвера не раскрывают введённый секрет', async (t) => {
  const fixture = await trackerFixture(t, { setup: setupConnection });

  for (const token of ['rejected-secret', 'throw-secret', secret]) {
    const response = await fixture.request('POST', endpoint, {
      driverId: 'fixture-jira',
      settings: { email: 'draft@fixture.invalid', token },
      expectedRevision: 0,
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().ok, token === secret);
    assert.equal(response.body.includes(token), false);
    assert.equal(fixture.logs.join('').includes(token), false);
  }

  assert.equal(existsSync(fixture.config.trackerCredentialsPath), false);
  assert.equal(fixture.runtime.selection.read().externalId, null);
});

test('Проверка защищена сессией, Origin, JSON, схемой и поколением подключения', async (t) => {
  const fixture = await trackerFixture(t, { setup: setupConnection });
  const payload = {
    driverId: 'fixture-jira',
    settings: {},
    expectedRevision: 0,
  };

  for (const headers of [{}, { 'x-grigdesk-token': 'tracker-test-cli' }, {
    'x-grigdesk-internal': 'tracker-test-internal',
  }]) {
    const response = await fixture.app.inject({
      method: 'POST',
      url: endpoint,
      payload,
      headers,
    });

    assert.equal(response.statusCode, Object.keys(headers).length ? 403 : 401);
  }

  const origin = await fixture.request('POST', endpoint, payload, { origin: 'https://foreign.invalid' });
  const text = await fixture.request('POST', endpoint, '{}', { 'content-type': 'text/plain' });

  assert.equal(origin.statusCode, 403);
  assert.equal(text.statusCode, 415);

  for (const invalid of [
    { ...payload, driverId: 'own' },
    { ...payload, driverId: 'missing' },
    { ...payload, settings: { unknown: true } },
    { ...payload, settings: { token: 42 } },
    { ...payload, extra: true },
  ]) {
    assert.equal((await fixture.request('POST', endpoint, invalid)).statusCode, 400);
  }

  await selectTracker(fixture, 'active-board');
  assert.equal((await fixture.request('POST', endpoint, payload)).statusCode, 409);
  assert.equal(fixture.runtime.registry.isLoaded('fixture-jira'), false);
});

test('Доска Jira возвращает нейтральную ошибку и сохраняет причину драйвера', async (t) => {
  const fixture = await trackerFixture(t, {
    setup: (config) => writeTracker(config, 'fixture-jira', {
      code: `
        export default () => ({
          id: 'fixture-jira',
          capabilities: {},
          isConfigured: () => true,
          taskDetail: async () => null,
          getDashboard: async () => { throw new Error('Jira: HTTP 401'); },
        });
      `,
    }),
  });

  await selectTracker(fixture, 'fixture-jira');

  const response = await fixture.request('GET', '/api/tracker/dashboard');

  assert.equal(response.statusCode, 502);
  assert.deepEqual(response.json(), { error: 'tracker_error', message: 'Jira: HTTP 401' });
});

for (const action of ['замена пакета', 'смена реквизитов']) {
  test(`${action} ждёт проверку и dispose, закрывая новые вызовы`, async (t) => {
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const disposing = Promise.withResolvers();
    const disposed = Promise.withResolvers();

    t.after(() => {
      release.resolve();
      disposed.resolve();
    });

    const fixture = await trackerFixture(t, {
      setup: (config) => writeTracker(config, 'fixture-probe', {
        code: `
          export default (host) => ({
            id: 'fixture-probe',
            testAuth: async () => {
              await host.fetch('https://tracker.fixture/probe');
              return { ok: true };
            },
            dispose: async () => { await host.fetch('https://tracker.fixture/dispose'); },
          });
        `,
      }),
      fetch: async (url) => {
        if (String(url).endsWith('/probe')) {
          entered.resolve();
          await release.promise;
        } else {
          disposing.resolve();
          await disposed.promise;
        }

        return new Response('{}');
      },
    });

    const response = fixture.request('POST', endpoint, {
      driverId: 'fixture-probe',
      settings: {},
      expectedRevision: 0,
    }).then((result) => result);

    await entered.promise;

    let changeReady = false;
    const change = action === 'замена пакета'
      ? fixture.runtime.registry.prepareReplace('fixture-probe', new AbortController().signal)
      : fixture.runtime.writeSettings(null, { 'fixture-probe': { token: 'changed-token' } });
    const changing = change.then((lease) => {
      changeReady = true;

      return lease;
    });

    await assert.rejects(fixture.runtime.registry.testAuth('fixture-probe'), { code: 'tracker_unavailable' });
    assert.equal(changeReady, false);
    release.resolve();
    await disposing.promise;
    assert.equal(changeReady, false);
    disposed.resolve();

    const result = await response;
    const lease = await changing;

    if (lease) {
      assert.equal(result.statusCode, 200);
      assert.equal(result.json().ok, true);
      await lease.finish('installed');
      assert.equal(fixture.runtime.registry.descriptors()
        .find((entry) => entry.id === 'fixture-probe').status, 'restartRequired');
    } else {
      assert.equal(result.statusCode, 409);
      assert.equal(result.json().error, 'tracker_context_changed');
      assert.equal(fixture.runtime.selection.read().revision, 1);
    }
  });
}
