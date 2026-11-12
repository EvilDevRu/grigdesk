import assert from 'node:assert/strict';
import test from 'node:test';

import analysisModule from '../../server/src/modules/analysis/index.ts';
import { Analyzer } from '../../server/src/lib/analysis/analyzer.ts';
import { ownTask, seedTasks } from './helpers/grigdesk-tasks.js';
import { selectTracker, trackerCalls } from './helpers/trackerFixture.js';
import { multiFixture } from './helpers/trackerMulti.js';
import { inboxConsumerFixture, REVISION } from './helpers/trackerInbox.js';

test('MD-ANALYSIS-GUARD: включённая A допускается, own/default проходят', async (t) => {
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
  await seedTasks(fixture.config, [ownTask()]);
  assert.equal((await fixture.request('POST', '/api/tasks/100000000001/analyze', {
    taskSource: 'grigdesk',
  })).statusCode, 200);

  const before = [...calls];
  const absentOwn = await fixture.request('POST', '/api/tasks/100000000099/analyze', {
    taskSource: 'grigdesk',
  });

  assert.equal(absentOwn.statusCode, 404, absentOwn.body);
  assert.deepEqual(calls, before);
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
