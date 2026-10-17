import assert from 'node:assert/strict';
import test from 'node:test';

import { installHttpFixture } from './helpers/pluginInstallHttpFixture.js';

export const operations = (id) => [
  ['/versions', { url: 'file:///fixture-plugin.git' }],
  ['/jobs', { url: 'file:///fixture-plugin.git' }],
  [`/jobs/${id}/apply`, { reviewToken: 'd'.repeat(64) }],
  [`/jobs/${id}/cancel`, {}],
  ['/plugins/demo/update', {}],
  ['/plugins/demo/rollback', {
    requestId: '00000000-0000-4000-8000-000000000001',
    expectedRevision: 1,
    expectedPreviousDigest: 'b'.repeat(64),
  }],
  ['/check', {}],
];

test('R1: реальный auth guard, анонимный401, CLI/internal только GET, session вызывает port', async (t) => {
  const fixture = await installHttpFixture(t);
  const base = '/api/plugin-installs';

  for (const url of ['/jobs/current', `/jobs/${fixture.stub.job.id}`]) {
    assert.equal((await fixture.app.inject(base + url)).statusCode, 401);

    for (const headers of [fixture.cli, fixture.internal, fixture.session]) {
      assert.equal((await fixture.app.inject({ url: base + url, headers })).statusCode, 200);
    }
  }

  fixture.stub.calls.length = 0;

  for (const [url, payload] of operations(fixture.stub.job.id)) {
    assert.equal((await fixture.app.inject({
      method: 'POST',
      url: base + url,
      payload,
    })).statusCode, 401);

    for (const headers of [fixture.cli, fixture.internal]) {
      const response = await fixture.app.inject({
        method: 'POST',
        url: base + url,
        payload,
        headers,
      });

      assert.equal(response.statusCode, 403);
      assert.equal(response.json().error, 'session_required');
    }
  }

  assert.equal(fixture.stub.calls.length, 0, 'отказы произошли до service');

  for (const [url, payload] of operations(fixture.stub.job.id)) {
    const response = await fixture.app.inject({
      method: 'POST',
      url: base + url,
      payload,
      headers: fixture.session,
    });

    assert.ok([200, 202].includes(response.statusCode));
  }

  assert.equal(fixture.stub.calls.length, 7);
});

test('R13: чужой Origin/content type отклонён до port, same-origin JSON проходит', async (t) => {
  const fixture = await installHttpFixture(t);
  const url = '/api/plugin-installs/versions';
  const payload = { url: 'file:///fixture-plugin.git' };
  const host = 'cockpit.fixture.invalid:1234';

  for (const [headers, body, status, code] of [
    [{
      ...fixture.session,
      host,
      origin: 'http://foreign.example.invalid',
    }, payload, 403, 'origin_forbidden'],
    [{
      ...fixture.session,
      host,
      origin: 'null',
    }, payload, 403, 'origin_forbidden'],
    [{
      ...fixture.session,
      host,
      'content-type': 'text/plain',
    }, '{}', 415, 'unsupported_media_type'],
  ]) {
    const response = await fixture.app.inject({
      method: 'POST',
      url,
      payload: body,
      headers,
    });

    assert.equal(response.statusCode, status);
    assert.equal(response.json().error, code);
  }

  assert.equal(fixture.stub.calls.length, 0);
  assert.equal((await fixture.app.inject({
    method: 'POST',
    url,
    payload,
    headers: {
      ...fixture.session,
      host,
      origin: `http://${host}`,
      'content-type': 'application/json; charset=utf-8',
    },
  })).statusCode, 200);

  fixture.stub.job.workers = { commandId: { pid: 123, cwd: '/fixture-private-path' } };
  fixture.stub.job.prepared = { secret: 'fixture-private-value' };
  fixture.stub.job.source.env = { secret: 'fixture-private-value' };
  fixture.stub.job.preview.source.env = { secret: 'fixture-private-value' };
  fixture.stub.job.preview.internalPath = '/fixture-private-path';

  const current = await fixture.app.inject({
    url: '/api/plugin-installs/jobs/current',
    headers: fixture.session,
  });

  assert.equal(current.statusCode, 200);
  assert.equal(current.body.includes('fixture-private'), false,
    'response schema не выпускает internal state');
  assert.equal(current.body.includes('commandId'), false);
  assert.equal(current.json().job.id, fixture.stub.job.id);
  fixture.stub.job.backupRef = '../fixture-private-path';

  const invalidBackup = await fixture.app.inject({
    url: '/api/plugin-installs/jobs/current',
    headers: fixture.session,
  });

  assert.equal(invalidBackup.statusCode, 500);
  assert.equal(invalidBackup.body.includes('fixture-private'), false);
});
