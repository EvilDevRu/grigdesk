import assert from 'node:assert/strict';

import test from 'node:test';

import dbModule from '../../server/src/modules/db/index.ts';

import { installHttpFixture, installPortFixture } from './helpers/pluginInstallHttpFixture.js';

const BASE = '/api/db/engine-installs';

/**
 * Настоящие auth и DB scopes оборачивают наблюдаемый installer port.
 * Port нужен только для доказательства отказа до каких-либо файловых эффектов.
 */
async function routes(t) {
  const stub = installPortFixture();

  let enabled = true;

  const fixture = await installHttpFixture(t, {
    installs: stub.port,
    configure(app) {
      app.decorate('pluginEnabled', () => enabled);
    },
    registerRoutes: (app) => app.register(dbModule, { installs: stub.port }),
  });

  return {
    ...fixture,
    stub,
    disable: () => {
      enabled = false;
    }
  };
}

/**
 * Legacy DTO сохраняет pluginId, а путь предмета становится engines.
 * Ни один запрос клиента не выбирает род пакета или каталог установки.
 */
function operations(id) {
  return [
    ['/versions', { url: 'file:///fixture-driver.git' }],
    ['/jobs', { url: 'file:///fixture-driver.git' }],
    [`/jobs/${id}/apply`, { reviewToken: 'd'.repeat(64) }],
    [`/jobs/${id}/cancel`, {}],
    ['/engines/demo/update', {}],
    ['/engines/demo/rollback', {
      requestId: '00000000-0000-4000-8000-000000000001',
      expectedRevision: 1,
      expectedPreviousDigest: 'b'.repeat(64),
    }],
    ['/check', {}],
  ];
}

test('DHTTP-01: session POST jobs возвращает202 через DB scope с legacy DTO', async (t) => {
  const fixture = await routes(t);

  const response = await fixture.app.inject({
    method: 'POST',
    url: BASE + '/jobs',
    headers: fixture.session,
    payload: { url: 'file:///fixture-driver.git' },
  });

  assert.equal(response.statusCode, 202);

  assert.equal(response.json().job.pluginId, 'demo');

  assert.equal(fixture.stub.calls[0].name, 'startInstall');
});

test('DHTTP-01: все endpoints требуют auth/session и выключаются вместе с Базами', async (t) => {
  const fixture = await routes(t);

  const requests = [
    ...operations(fixture.stub.job.id).map(([url, payload]) => ({
      method: 'POST',
      url: BASE + url,
      payload
    })),
    { method: 'GET', url: BASE + '/jobs/current' },
    { method: 'GET', url: `${BASE}/jobs/${fixture.stub.job.id}` },
  ];

  for (const request of requests) {
    assert.equal((await fixture.app.inject(request)).statusCode, 401, request.url);

    for (const headers of [fixture.cli, fixture.internal]) {
      assert.equal((await fixture.app.inject({ ...request, headers })).statusCode, 403, request.url);
    }
  }

  assert.equal(fixture.stub.calls.length, 0);

  for (const request of requests) {
    const response = await fixture.app.inject({ ...request, headers: fixture.session });

    assert.ok([200, 202].includes(response.statusCode), `${request.url}: ${response.statusCode}`);
  }

  fixture.disable();

  fixture.stub.calls.length = 0;

  for (const request of requests) {
    assert.equal((await fixture.app.inject({ ...request, headers: fixture.session })).statusCode, 404);
  }

  assert.equal(fixture.stub.calls.length, 0);
});

test('DHTTP-01: Origin/JSON/token/unknown fields и повторная авторизация', async (t) => {
  const fixture = await routes(t);

  const jobPath = `${BASE}/jobs/${fixture.stub.job.id}/apply`;

  for (const [url, payload, extraHeaders, status] of [
    [BASE + '/jobs', { url: 'file:///driver.git' }, { origin: 'https://foreign.invalid' }, 403],
    [BASE + '/jobs', '{}', { 'content-type': 'text/plain' }, 415],
    [jobPath, { reviewToken: 'bad' }, {}, 400],
    [BASE + '/jobs', { url: 'file:///driver.git', packageKind: 'plugin' }, {}, 400],
    [BASE + '/jobs', { url: 'file:///driver.git', kind: 'plugin' }, {}, 400],
    [BASE + '/jobs', { url: 'file:///driver.git', path: '/tmp/private' }, {}, 400],
    [BASE + '/jobs', { url: 'file:///driver.git', runtime: {} }, {}, 400],
  ]) {
    const response = await fixture.app.inject({
      method: 'POST',
      url,
      payload,
      headers: { ...fixture.session, ...extraHeaders },
    });

    assert.equal(response.statusCode, status, response.body);
  }

  assert.equal(fixture.stub.calls.length, 0);

  for (const [url, payload] of operations(fixture.stub.job.id).filter(([url]) =>
    url.endsWith('/apply') || url.endsWith('/rollback'))) {
    const response = await fixture.app.inject({
      method: 'POST',
      url: BASE + url,
      payload,
      headers: {
        ...fixture.session,
        host: 'fixture.invalid',
        origin: 'http://fixture.invalid'
      },
    });

    assert.equal(response.statusCode, 200);

    assert.equal((await fixture.app.inject({
      method: 'POST',
      url: BASE + url,
      payload,
      headers: fixture.cli,
    })).statusCode, 403);
  }
});
