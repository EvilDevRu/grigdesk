import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

import factoryModule from '../../server/src/modules/factory/index.ts';
import { Analyzer } from '../../server/src/lib/analysis/analyzer.ts';
import { registerTrackerRoutes } from '../../server/src/lib/mobile/facade/tracker.ts';
import { ActionTokens } from '../../server/src/lib/mobile/actionTokens.ts';
import { mobileFacadeFixture } from './helpers/mobile-facade.js';
import { inboxConsumerFixture, REVISION } from './helpers/trackerInbox.js';
import { selectTracker, trackerCalls, trackerFixture, writeTracker } from './helpers/trackerFixture.js';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));

test('TRACKER-SOURCE-URL-01: factory ticket использует sourceUrl драйвера', async (t) => {
  const fixture = await trackerFixture(t, {
    setup: (config) => writeTracker(config, 'fixture-driver'),
  });

  if (fixture.runtime) {
    await selectTracker(fixture, 'fixture-driver');
  } else {
    fixture.tracker.client = () => ({
      baseUrl: 'https://tracker.fixture',
      discoverUserId: async () => 7,
      taskPageData: async () => ({ comments: [] }),
    });
    fixture.tracker.sourceUrl = (id) => `https://tracker.fixture/t/${id}`;
  }

  const config = fixture.config;
  const binDir = path.join(fixture.root, 'bin');

  config.factoryConfigRoot = path.join(fixture.root, 'factory-config');

  await mkdir(binDir);
  await writeFile(path.join(config.profilesDir, 'beta/profile.sh'), `
profile_repositories() { printf 'demo\\t${fixture.root}/src\\t${fixture.root}/work\\n'; }
`);
  config.factoryBin = path.join(binDir, 'factory');
  await writeFile(config.factoryBin, `#!/bin/bash
case "$1" in
  check) echo 'OK delivery=disabled instrumentation=disabled'; exit 0 ;;
  slots) echo '{"supported":false}'; exit 0 ;;
esac
echo 'fixture stopped after ticket' >&2
exit 42
`, { mode: 0o755 });
  await writeFile(path.join(binDir, 'systemd-run'), '#!/bin/bash\nexit 1\n', { mode: 0o755 });

  const oldPath = process.env.PATH;

  process.env.PATH = `${binDir}:${oldPath}`;
  t.after(() => {
    process.env.PATH = oldPath;
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
      description: 'Постановка'
    },
  });
  const ticketFile = path.join(config.ticketsDir, 't42.ticket.json');
  const bytes = await readFile(ticketFile, 'utf8').catch(() => null);

  assert.ok(bytes, `Настоящий factory собрал ticket: ${response.body}`);
  assert.equal(JSON.parse(bytes).sourceUrl, 'https://tracker.fixture/t/42');
});

test('TRACKER-SWITCH-02: смена driver во время Inbox подготовки запрещает эффект в новом аккаунте',
  async (t) => {
    const fixture = await trackerFixture(t, {
      setup: async (config) => {
        await writeTracker(config, 'fixture-a');
        await writeTracker(config, 'fixture-b');
      },
    });

    await selectTracker(fixture, 'fixture-a');

    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const inbox = inboxConsumerFixture({
      b24: fixture.tracker,
      prepare: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    const operation = inbox.service.task(inbox.itemRef, {
      revision: REVISION,
      messageRefs: [inbox.messageRef],
    }).then(() => ({ ok: true }), (error) => ({ error }));

    t.after(() => release.resolve());
    await entered.promise;

    await selectTracker(fixture, 'fixture-b');

    release.resolve();

    const result = await operation;

    assert.equal(result.error?.code, 'tracker_context_changed');
    assert.deepEqual(await trackerCalls(fixture.config, 'fixture-a'), []);
    assert.deepEqual(await trackerCalls(fixture.config, 'fixture-b'), []);
    assert.deepEqual(inbox.calls.decide, []);
  });

test('TRACKER-CONSUMERS-01: analyzer и mobile используют выбранный B через общий facade', async (t) => {
  const fixture = await trackerFixture(t, {
    setup: async (config) => {
      await writeTracker(config, 'fixture-a');
      await writeTracker(config, 'fixture-b');
    },
  });

  await selectTracker(fixture, 'fixture-a');
  await selectTracker(fixture, 'fixture-b');

  const analyzer = Object.create(Analyzer.prototype);

  Object.assign(analyzer, {
    config: fixture.config,
    tracker: fixture.tracker,
    log: { warn() {} }
  });
  assert.equal((await analyzer._fetchTicket('42')).title, 'fixture-b');

  const inbox = inboxConsumerFixture({ b24: fixture.tracker });
  const created = await inbox.service.task(inbox.itemRef, {
    revision: REVISION,
    messageRefs: [inbox.messageRef],
  });

  assert.equal(created.taskId, '43');
  assert.equal((await trackerCalls(fixture.config, 'fixture-b'))
    .filter((call) => call.method === 'createTask').length, 1);


  const mobile = await mobileFacadeFixture(t, (app) => registerTrackerRoutes(app, {
    tokens: new ActionTokens(),
    callApi: async (method, url, payload) => {
      const response = await fixture.request(method, url, payload);

      return { statusCode: response.statusCode, body: response.json() };
    },
  }));
  const response = await mobile.app.inject('/api/mobile/v1/tracker/tasks/42');

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().task.title, 'fixture-b');
  assert.deepEqual(await trackerCalls(fixture.config, 'fixture-a'), []);
});
