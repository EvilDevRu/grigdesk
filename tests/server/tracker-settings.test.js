import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';

import { selectTracker, trackerFixture, writeTracker } from './helpers/trackerFixture.js';

import { copyStockPackage } from './helpers/trackerPackage.js';

const SECRET = 'fixture-access-token-must-stay-server-side';

test('TRACKER-SECRETS-01: settings требуют сессию, secret не возвращается и лежит mode0600', async (t) => {
  const fixture = await trackerFixture(t, {
    setup: copyStockPackage,
    fetch: async () => new Response(JSON.stringify({ result: { ID: 7 } }), {
      headers: { 'content-type': 'application/json' },
    }),
  });

  if (!fixture) {
    return;
  }

  const denied = await fixture.app.inject('/api/trackers/settings');

  assert.equal(denied.statusCode, 401);

  await selectTracker(fixture, 'grigdesk-b24', {
    'grigdesk-b24': {
      baseUrl: 'https://cloud.fixture',
      authMode: 'token',
      accessToken: SECRET,
    },
  });

  for (const url of ['/api/trackers', '/api/trackers/settings', '/api/driver-installs/jobs/current']) {
    const response = await fixture.request('GET', url);

    assert.equal(response.statusCode, 200, url);
    assert.equal(response.body.includes(SECRET), false, url);
    assert.equal(response.body.includes('fixture-password'), false, url);
  }

  const stored = await readFile(fixture.config.trackerCredentialsPath, 'utf8');
  const settings = await readFile(fixture.config.trackerSettingsPath, 'utf8');

  assert.ok(stored.includes(SECRET));
  assert.equal(settings.includes(SECRET), false);
  assert.equal(fixture.logs.join('').includes(SECRET), false);
  assert.equal((await stat(fixture.config.trackerCredentialsPath)).mode & 0o777, 0o600);
  await selectTracker(fixture, 'grigdesk-b24', { 'grigdesk-b24': { accessToken: '' } });
  assert.ok((await readFile(fixture.config.trackerCredentialsPath, 'utf8')).includes(SECRET));
});

test('TRACKER-SECRETS-01: stale revision не меняет выбор, успешный выбор публикует SSE', async (t) => {
  const fixture = await trackerFixture(t, {
    setup: (config) => writeTracker(config, 'fixture-a'),
  });
  const initial = await fixture.request('GET', '/api/trackers/settings');

  assert.equal(initial.statusCode, 200);

  const revision = initial.json().revision;

  await selectTracker(fixture, 'fixture-a');

  const stale = await fixture.request('POST', '/api/trackers/settings', {
    externalId: null, expectedRevision: revision,
  });

  assert.equal(stale.statusCode, 409);
  assert.equal((await fixture.request('GET', '/api/trackers')).json().externalId, 'fixture-a');
  assert.ok(fixture.events.some((event) => event.name === 'trackers-changed'));
});

test('Select: HTTP сохраняет строку варианта и отвергает неизвестное значение и тип', async (t) => {
  const fixture = await trackerFixture(t, { setup: copyStockPackage });

  assert.ok(fixture);

  fixture.credsStore.writeFor('grigdesk-b24', {
    baseUrl: 'https://cloud.fixture',
    accessToken: SECRET,
  });

  for (const authMode of ['token', 'password']) {
    await selectTracker(fixture, 'grigdesk-b24', { 'grigdesk-b24': { authMode } });

    const settings = await fixture.request('GET', '/api/trackers/settings');

    assert.equal(settings.json().settings['grigdesk-b24'].authMode, authMode);
  }

  for (const authMode of ['unknown', '', 1, true]) {
    const settings = await fixture.request('GET', '/api/trackers/settings');
    const response = await fixture.request('POST', '/api/trackers/settings', {
      externalId: 'grigdesk-b24',
      expectedRevision: settings.json().revision,
      settings: { 'grigdesk-b24': { authMode } },
    });

    assert.equal(response.statusCode, 400);
  }
});
