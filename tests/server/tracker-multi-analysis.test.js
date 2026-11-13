import assert from 'node:assert/strict';
import test from 'node:test';

import analysisModule from '../../server/src/modules/analysis/index.ts';
import { Analyzer } from '../../server/src/lib/analysis/analyzer.ts';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { selectTracker, trackerCalls } from './helpers/trackerFixture.js';
import { multiFixture } from './helpers/trackerMulti.js';
import { inboxConsumerFixture, REVISION } from './helpers/trackerInbox.js';

test('MD-ANALYSIS-GUARD: включённая A допускается, default проходит', async (t) => {
  const calls = [];
  const fixture = await multiFixture(t, {
    register: async ({ app, runtime, config }) => {
      await app.register(analysisModule, {
        tracker: runtime.tracker,
        analyzer: {
          config,
          enqueue: async (id) => {
            calls.push(id);

            return { ok: true };
          },
        },
      });
    },
  });

  await selectTracker(fixture, 'fixture-a');

  const sourceA = (await fixture.request('GET', '/api/tracker/dashboard')).json().source;

  await selectTracker(fixture, 'fixture-b');

  const sourceB = (await fixture.request('GET', '/api/tracker/dashboard')).json().source;
  const addressed = await fixture.request('POST', '/api/tasks/42/analyze', { taskSource: sourceA });

  assert.equal(addressed.statusCode, 200, addressed.body);
  assert.equal(calls.length, 1);
  assert.equal((await fixture.request('POST', '/api/tasks/42/analyze', { taskSource: sourceB }))
    .statusCode, 200);

});

test('MD-DEFAULT-CONSUMERS: analyzer и Inbox при последовательных включениях идут в B', async (t) => {
  const fixture = await multiFixture(t);
  const analyzer = Object.create(Analyzer.prototype);

  Object.assign(analyzer, {
    config: fixture.config,
    tracker: fixture.tracker,
    log: { warn() {} },
  });
  assert.equal((await analyzer._fetchTicket('42')).title, 'fixture-b');

  const inbox = inboxConsumerFixture({ b24: fixture.tracker });

  await inbox.service.task(inbox.itemRef, { revision: REVISION, messageRefs: [inbox.messageRef] });
  assert.deepEqual(await trackerCalls(fixture.config, 'fixture-a'), []);
  assert.equal((await trackerCalls(fixture.config, 'fixture-b'))
    .filter((call) => call.method === 'createTask').length, 1);
});

test('OWN-REMOVED-ENQUEUE: explicit grigdesk отвергнут до очереди, default остаётся доступен', async (t) => {
  const calls = [];
  const fixture = await multiFixture(t, {
    register: async ({ app, runtime, config }) => {
      await app.register(analysisModule, {
        tracker: runtime.tracker,
        analyzer: {
          config,
          enqueue: async (id) => {
            calls.push(id);

            return { ok: true };
          },
        },
      });
    },
  });
  const id = '100000000001';

  await writeFile(path.join(fixture.root, 'tasks.json'), JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    nextId: '100000000010',
    tasks: [{
      id,
      source: 'grigdesk',
      title: 'Архив',
      description: 'История',
      projectId: 'beta',
      projectTitle: 'Бета',
      sourceUrl: 'http://client.test/#/board',
      createdAt: '2026-10-24T00:00:00.000Z',
    }],
  }));

  const legacy = await fixture.request('POST', `/api/tasks/${id}/analyze`, { taskSource: 'grigdesk' });

  assert.ok([400, 404, 409].includes(legacy.statusCode), legacy.body);
  assert.deepEqual(calls, []);
  assert.equal((await fixture.request('POST', '/api/tasks/42/analyze', {})).statusCode, 200);
  assert.deepEqual(calls, ['42']);
});
