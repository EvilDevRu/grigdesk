import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { Analyzer } from '../../server/src/lib/analysis/analyzer.ts';
import { registerTrackerRoutes } from '../../server/src/lib/mobile/facade/tracker.ts';
import { ActionTokens } from '../../server/src/lib/mobile/actionTokens.ts';
import { mobileFacadeFixture } from './helpers/mobile-facade.js';
import { inboxConsumerFixture, REVISION } from './helpers/trackerInbox.js';
import { multiFixture } from './helpers/trackerMulti.js';
import { selectTracker, trackerCalls } from './helpers/trackerFixture.js';
import factoryModule from '../../server/src/modules/factory/index.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));

test('MD-LEGACY: прежние DTO, default, auth и SSE alias сохраняются', async (t) => {
  const fixture = await multiFixture(t);

  for (const id of ['fixture-a', 'fixture-b']) {
    const before = (await fixture.request('GET', '/api/trackers/settings')).json().revision;

    await selectTracker(fixture, id);

    const catalog = await fixture.request('GET', '/api/trackers');
    const dashboard = await fixture.request('GET', '/api/tracker/dashboard');
    const detail = await fixture.request('GET', '/api/tracker/task/42');
    const created = await fixture.request('POST', '/api/tracker/tasks', { title: 'Прежний клиент' });
    const event = fixture.events.filter((item) => item.name === 'trackers-changed').at(-1);

    assert.equal(catalog.statusCode, 200);
    assert.equal(catalog.json().externalId, id);
    assert.ok(catalog.json().revision > before);
    assert.equal(dashboard.statusCode, 200, dashboard.body);
    assert.equal(dashboard.json().trackerId, id);
    assert.deepEqual(dashboard.json().tasks.map((task) => task.title), [id]);
    assert.equal(detail.statusCode, 200, detail.body);
    assert.equal(detail.json().title, id);
    assert.equal(created.statusCode, 200, created.body);
    assert.equal(created.json().id, 43);
    assert.equal(event.payload.externalId, id);
    assert.equal(event.payload.revision, catalog.json().revision);
  }

  for (const url of ['/api/trackers', '/api/tracker/dashboard']) {
    assert.equal((await fixture.app.inject(url)).statusCode, 401, url);
  }
});

test('MD-CONSUMERS: Inbox, analyzer и mobile без цели используют default B', async (t) => {
  const fixture = await multiFixture(t);
  const analyzer = Object.create(Analyzer.prototype);

  Object.assign(analyzer, {
    config: fixture.config,
    tracker: fixture.tracker,
    log: { warn() {} },
  });
  assert.equal((await analyzer._fetchTicket('42')).title, 'fixture-b');

  const inbox = inboxConsumerFixture({ b24: fixture.tracker });
  const created = await inbox.service.task(inbox.itemRef, {
    revision: REVISION,
    messageRefs: [inbox.messageRef],
  });
  const mobile = await mobileFacadeFixture(t, (app) => registerTrackerRoutes(app, {
    tokens: new ActionTokens(),
    callApi: async (method, url, payload) => {
      const response = await fixture.request(method, url, payload);

      return { statusCode: response.statusCode, body: response.json() };
    },
  }));
  const response = await mobile.app.inject('/api/mobile/v1/tracker/tasks/42');

  assert.equal(created.taskId, '43');
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().task.title, 'fixture-b');
  assert.deepEqual(await trackerCalls(fixture.config, 'fixture-a'), []);
  assert.equal((await trackerCalls(fixture.config, 'fixture-b'))
    .filter((call) => call.method === 'createTask').length, 1);
});

test('MD-CONSUMERS: factory ticket берёт URL default B', async (t) => {
  const fixture = await multiFixture(t);
  const config = fixture.config;
  const binDir = path.join(fixture.root, 'bin');

  config.factoryConfigRoot = path.join(fixture.root, 'factory-config');
  config.factoryBin = path.join(binDir, 'factory');
  await mkdir(binDir);
  await writeFile(path.join(config.profilesDir, 'beta/profile.sh'), `
profile_repositories() { printf 'demo\\t${fixture.root}/src\\t${fixture.root}/work\\n'; }
`);
  await writeFile(config.factoryBin, `#!/bin/bash
case "$1" in
  check) echo 'OK delivery=disabled instrumentation=disabled'; exit 0 ;;
  slots) echo '{"supported":false}'; exit 0 ;;
esac
echo 'fixture stopped after ticket' >&2
exit 42
`, { mode: 0o755 });
  await writeFile(path.join(binDir, 'systemd-run'), '#!/bin/bash\nexit 1\n', { mode: 0o755 });

  const previousPath = process.env.PATH;

  process.env.PATH = `${binDir}:${previousPath}`;
  t.after(() => {
    process.env.PATH = previousPath;
  });

  const app = requireFromServer('fastify')({ logger: false });

  t.after(() => app.close());
  await app.register(factoryModule, {
    config,
    tracker: fixture.tracker,
    prefs: { read: () => ({}) },
    analyzer: { readClarifications: async () => null, readOpenQuestions: async () => null },
    factoryState: {
      discoverProfiles: () => ['beta'],
      primaryProfile: async () => 'beta',
      readRegistry: async () => {
        throw Object.assign(new Error('Нет прогона'), { code: 'ENOENT' });
      },
      catalog: async () => ({
        routes: ['feature'],
        catalogHash: 'b'.repeat(64),
        routeOptions: { feature: { deliveryMode: 'disabled', instrumentationMode: 'disabled' } },
      }),
    },
  });

  const response = await app.inject({
    method: 'POST',
    url: '/api/tasks/42/launch',
    payload: {
      profile: 'beta',
      route: 'feature',
      title: 'Задача',
      description: 'Постановка',
    },
  });
  const ticket = await readFile(path.join(config.ticketsDir, 't42.ticket.json'), 'utf8').catch(() => null);

  assert.ok(ticket, response.body);
  assert.equal(JSON.parse(ticket).sourceUrl, 'https://fixture-b.fixture/t/42');
  assert.deepEqual(await trackerCalls(fixture.config, 'fixture-a'), []);
});
