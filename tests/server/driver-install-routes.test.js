import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

import { installHttpFixture, installPortFixture } from './helpers/pluginInstallHttpFixture.js';

const moduleUrl = new URL('../../server/src/modules/trackers/installRoutes.ts', import.meta.url);

test('DRIVER-READ-01: installed закрыт auth и читает локальные записи без checkUpdates', async (t) => {
  const stub = installPortFixture();
  const fixture = await installHttpFixture(t, {
    registerRoutes: async (app) => {
      await app.register((await import(moduleUrl.href)).default, { installs: stub.port });
    },
  });
  const url = '/api/driver-installs/installed';

  assert.equal((await fixture.app.inject(url)).statusCode, 401);

  for (const headers of [fixture.session, fixture.cli, fixture.internal]) {
    const response = await fixture.app.inject({ url, headers });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { drivers: {} });
  }

  assert.deepEqual(stub.calls.map((call) => call.name), ['listInstalled', 'listInstalled', 'listInstalled']);
});

test('DRIVER-AUTH-01: реальный auth guard, session/Origin/JSON и отдельные driver routes', async (t) => {
  const stub = installPortFixture();
  const fixture = await installHttpFixture(t, {
    registerRoutes: async (app) => {
      if (existsSync(moduleUrl)) {
        await app.register((await import(moduleUrl.href)).default, { installs: stub.port });
      }
    },
  });
  const base = '/api/driver-installs';
  const jobUrl = `${base}/jobs/current`;

  assert.equal((await fixture.app.inject(jobUrl)).statusCode, 401);

  for (const headers of [fixture.session, fixture.cli, fixture.internal]) {
    const response = await fixture.app.inject({ url: jobUrl, headers });

    assert.equal(response.statusCode, 200, 'новый read API должен существовать');
  }

  const operations = [
    ['/versions', { url: 'file:///fixture-driver.git' }],
    ['/jobs', { url: 'file:///fixture-driver.git', version: '1.0.0' }],
    [`/jobs/${stub.job.id}/apply`, { reviewToken: 'd'.repeat(64) }],
    [`/jobs/${stub.job.id}/cancel`, {}],
    ['/drivers/demo/update', {}],
    ['/drivers/demo/rollback', {
      requestId: '00000000-0000-4000-8000-000000000001',
      expectedRevision: 1,
      expectedPreviousDigest: 'b'.repeat(64),
    }],
    ['/check', {}],
  ];

  stub.calls.length = 0;

  for (const [suffix, payload] of operations) {
    for (const headers of [fixture.cli, fixture.internal]) {
      const response = await fixture.app.inject({
        method: 'POST',
        url: base + suffix,
        headers,
        payload
      });

      assert.equal(response.statusCode, 403);
      assert.equal(response.json().error, 'session_required');
    }
  }

  assert.deepEqual(stub.calls, []);

  for (const [headers, payload, expected] of [
    [{ origin: 'http://foreign.fixture' }, { url: 'file:///fixture-driver.git' }, 403],
    [{ 'content-type': 'text/plain' }, '{}', 415],
  ]) {
    const response = await fixture.app.inject({
      method: 'POST',
      url: `${base}/versions`,
      payload,
      headers: { ...fixture.session, ...headers },
    });

    assert.equal(response.statusCode, expected);
  }

  assert.deepEqual(stub.calls, []);

  for (const [suffix, payload] of operations) {
    const response = await fixture.app.inject({
      method: 'POST',
      url: base + suffix,
      payload,
      headers: {
        ...fixture.session,
        host: 'grigdesk.fixture',
        origin: 'http://grigdesk.fixture'
      },
    });

    assert.ok([200, 202].includes(response.statusCode), `${suffix}: ${response.body}`);
  }

  assert.equal(stub.calls.length, operations.length);
});
