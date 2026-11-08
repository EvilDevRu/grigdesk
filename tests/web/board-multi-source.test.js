import assert from 'node:assert/strict';
import test from 'node:test';

import { controlDriver, saveMulti } from '../server/helpers/trackerMulti.js';
import { configureSseRelay, resetSseForTests, sseSubscribe } from '../../web/src/composables/useSse.ts';
import { flushMulti, rowRefs, webMultiFixture } from './helpers/trackerMulti.js';
import { createPinia } from '../../web/node_modules/pinia/dist/pinia.mjs';
import { useBoardStore } from '../../web/src/stores/board.ts';
import { startBoardRelay } from '../../web/src/shared/windowRelay.ts';

test('MD-MERGE: A42+B42 приходят в единую ленту с разными source', async (t) => {
  const fixture = await webMultiFixture(t);

  await fixture.board.load(true);
  assert.deepEqual(rowRefs(fixture.board), [[fixture.sourceA, '42'], [fixture.sourceB, '42']]);
  assert.ok(fixture.calls.some((call) => call.url === '/api/tracker/fixture-a/dashboard'));
  assert.ok(fixture.calls.some((call) => call.url === '/api/tracker/fixture-b/dashboard'));
});

for (const failure of ['error', 'disabled']) {
  test(`MD-FAILURE: ${failure} A сохраняет last-good, B и own доступны`, async (t) => {
    const fixture = await webMultiFixture(t);

    await fixture.board.load(true);
    assert.equal(rowRefs(fixture.board).length, 2);

    if (failure === 'error') {
      await controlDriver(fixture, 'fixture-a', { dashboardError: 'A временно недоступен' });
    } else {
      assert.equal((await saveMulti(fixture, ['fixture-b'], 'fixture-b')).statusCode, 200);
    }

    await fixture.board.load(true);
    assert.deepEqual(rowRefs(fixture.board), [[fixture.sourceA, '42'], [fixture.sourceB, '42']]);
    assert.equal((await fixture.request('GET', '/api/grigdesk-tasks')).statusCode, 200);
    assert.equal((await fixture.request('GET', '/api/tracker/fixture-b/task/42')).statusCode, 200);

    const catalog = (await fixture.request('GET', '/api/trackers')).json();
    const a = catalog.drivers.find((entry) => entry.id === 'fixture-a');

    assert.equal(typeof a.reason, 'string');
    assert.ok(a.reason.length > 0);

    if (failure === 'error') {
      await controlDriver(fixture, 'fixture-a', { dashboardError: null });
      await fixture.board.load(true);
      assert.equal(rowRefs(fixture.board).length, 2);
    }
  });
}

test('MD-FAILURE: холодный отказ A не придумывает строки, B и own продолжают работать', async (t) => {
  const fixture = await webMultiFixture(t);

  await controlDriver(fixture, 'fixture-a', { dashboardError: 'Холодный отказ A' });
  await fixture.board.load(true);
  assert.deepEqual(rowRefs(fixture.board), [[fixture.sourceB, '42']]);

  const catalog = (await fixture.request('GET', '/api/trackers')).json();
  const descriptor = catalog.drivers.find((entry) => entry.id === 'fixture-a');

  assert.equal(descriptor.status, 'unavailable');
  assert.equal(typeof descriptor.reason, 'string');
  assert.ok(descriptor.reason.trim().length > 0);
  assert.equal((await fixture.request('GET', '/api/grigdesk-tasks/100000000001')).statusCode, 200);
});

test('MD-INDEPENDENT-READ: удержанный dashboard A не задерживает публикацию B', async (t) => {
  const release = Promise.withResolvers();
  const fixture = await webMultiFixture(t, {
    intercept: async ({ url }) => {
      if (url === '/api/tracker/fixture-a/dashboard') {
        await release.promise;
      }
    },
  });
  let finished = false;
  const reading = fixture.board.load(true).finally(() => {
    finished = true;
  });

  try {
    await flushMulti();
    await flushMulti();
    assert.ok(rowRefs(fixture.board).some(([source]) => source === fixture.sourceB));
    assert.equal(finished, false, 'Чтение A ещё удержано, B уже опубликован');
  } finally {
    release.resolve();
    await reading;
  }

  assert.equal(rowRefs(fixture.board).length, 2);
});

test('MD-OWNER: запись credentials A убирает только A до исхода POST', async (t) => {
  const release = Promise.withResolvers();
  let hold = false;
  const fixture = await webMultiFixture(t, {
    intercept: async ({ method, url }) => {
      if (hold && method === 'POST' && url === '/api/trackers/settings') {
        await release.promise;
      }
    },
  });

  await fixture.board.load(true);
  assert.equal(rowRefs(fixture.board).length, 2);
  await fixture.trackers.load(true);
  hold = true;

  const revision = fixture.trackers.catalog.revision;
  const writing = fixture.trackers.saveSettings({
    drivers: ['fixture-a', 'fixture-b'],
    default: 'fixture-b',
    expectedRevision: revision,
    settings: { 'fixture-a': { endpoint: 'https://new-a.fixture' } },
  });

  try {
    await flushMulti();
    assert.deepEqual(rowRefs(fixture.board), [[fixture.sourceB, '42']]);
  } finally {
    release.resolve();
    await writing;
  }

  assert.ok(rowRefs(fixture.board).some(([source]) => source === fixture.sourceB));
  assert.equal(rowRefs(fixture.board).some(([source]) => source === fixture.sourceA), false);
});

test('MD-OWNER: поздний готовый HTTP A не возвращает прежний account source', async (t) => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let hold = false;
  const fixture = await webMultiFixture(t, {
    afterResponse: async ({ url }) => {
      if (hold && url === '/api/tracker/fixture-a/dashboard') {
        hold = false;
        entered.resolve();
        await release.promise;
      }
    },
  });

  await fixture.board.load(true);
  assert.equal(rowRefs(fixture.board).length, 2);
  await fixture.trackers.load(true);
  hold = true;

  const reading = fixture.board.load(true);
  let writing;

  try {
    await Promise.race([
      entered.promise,
      reading.then(() => assert.fail('Адресный A должен участвовать в обновлении')),
    ]);
    writing = fixture.trackers.saveSettings({
      drivers: ['fixture-a', 'fixture-b'],
      default: 'fixture-b',
      expectedRevision: fixture.trackers.catalog.revision,
      settings: { 'fixture-a': { endpoint: 'https://new-owner.fixture' } },
    });
    await flushMulti();
    assert.deepEqual(rowRefs(fixture.board), [[fixture.sourceB, '42']]);
  } finally {
    release.resolve();
    await Promise.allSettled([reading, writing]);
  }

  await writing;
  assert.equal(rowRefs(fixture.board).some(([source]) => source === fixture.sourceA), false);
  assert.ok(rowRefs(fixture.board).some(([source]) => source === fixture.sourceB));
});

test('MD-MIRROR: trackers-changed проходит main→surface одним SSE без echo', (t) => {
  const sources = [];
  const channels = [];
  const received = [];

  const previous = Object.getOwnPropertyDescriptor(globalThis, 'EventSource');

  Object.defineProperty(globalThis, 'EventSource', {
    configurable: true,
    writable: true,
    value: class {
    listeners = new Map();

    constructor() {
      sources.push(this);
    }

    addEventListener(name, callback) {
      this.listeners.set(name, callback);
    }

    close() {}
    },
  });

  t.after(() => {
    if (previous) {
      Object.defineProperty(globalThis, 'EventSource', previous);
    } else {
      delete globalThis.EventSource;
    }
  });

  const makeChannel = () => {
    const channel = {
      onmessage: null,
      sent: [],
      postMessage(value) {
        this.sent.push(value);
      },
      close() {},
    };

    channels.push(channel);

    return channel;
  };

  t.after(() => resetSseForTests());
  configureSseRelay('source', makeChannel);
  sseSubscribe(() => {});
  sources[0].listeners.get('trackers-changed')({ data: '{"externalId":"fixture-b","revision":3}' });
  assert.equal(channels.length, 1);
  assert.equal(channels[0].sent.length, 1, 'Событие подключения должно ретранслироваться');

  const message = structuredClone(channels[0].sent[0]);

  resetSseForTests();
  configureSseRelay('mirror', makeChannel);
  sseSubscribe((name, data) => received.push({ name, data }));
  channels.at(-1).onmessage({ data: message });
  assert.deepEqual(received, [{ name: 'trackers-changed', data: { externalId: 'fixture-b', revision: 3 } }]);
  assert.equal(sources.length, 1);
  assert.deepEqual(channels.at(-1).sent, []);
});

test('MD-MIRROR: multi-снимок передаётся v2, чужой ключ и старая эпоха не принимаются', async (t) => {
  const fixture = await webMultiFixture(t);

  await fixture.board.load(true);
  assert.equal(rowRefs(fixture.board).length, 2);

  const mirror = useBoardStore(createPinia());
  const sourceChannel = {
    sent: [],
    onmessage: null,
    close() {},
  };
  const mirrorChannel = {
    sent: [],
    onmessage: null,
    close() {},
  };

  sourceChannel.postMessage = (data) => {
    sourceChannel.sent.push(data);
    queueMicrotask(() => mirrorChannel.onmessage?.({ data }));
  };
  mirrorChannel.postMessage = (data) => {
    mirrorChannel.sent.push(data);
    queueMicrotask(() => sourceChannel.onmessage?.({ data }));
  };

  const bind = (board, role, channel) => startBoardRelay({
    role,
    channel,
    sourceState: () => ({ key: board.sourceKey, suspended: board.sourceSuspended }),
    snapshot: () => board.data ? {
      data: board.data,
      sourceKey: board.sourceKey,
      readAt: board.readAt,
      epoch: board.sourceEpoch,
    } : null,
    watchLoads: (callback) => board.$onAction(({ name, after }) => {
      if (name === 'load') {
        after(callback);
      }
    }),
    watchInvalidation: () => () => {},
    apply: (data, readAt, sourceKey) => board.applySnapshot(data, readAt, sourceKey),
    invalidate: (suspended) => board.clearSource(suspended),
    recheck: () => board.load(),
    mirror: (request) => board.setMirror(request),
  });
  const stopSource = bind(fixture.board, 'source', sourceChannel);
  const stopMirror = bind(mirror, 'mirror', mirrorChannel);

  t.after(() => {
    stopMirror();
    stopSource();
    mirror.stopPolling();
  });
  await mirror.load();
  await fixture.board.load(true);
  await flushMulti();
  assert.deepEqual(rowRefs(mirror), rowRefs(fixture.board));

  const snapshot = sourceChannel.sent.findLast((message) => message.type === 'board-snapshot');

  assert.ok(snapshot);
  assert.equal(snapshot.version, 2);
  assert.ok(Object.hasOwn(snapshot, 'epoch'));

  const before = rowRefs(mirror);
  const echoes = mirrorChannel.sent.filter((message) => message.type === 'board-snapshot').length;
  const poisoned = JSON.parse(JSON.stringify(snapshot.data));

  /**
   * Меняется только валидный номер строки внутри настоящего envelope.
   * Повреждение формы могло бы скрыть отсутствие проверки ключа или эпохи.
   */
  const poisonTasks = (value) => {
    if (!value || typeof value !== 'object') {
      return;
    }
    if (String(value.id) === '42' && typeof value.title === 'string') {
      value.id = 99;
    }

    for (const child of Object.values(value)) {
      poisonTasks(child);
    }
  };

  poisonTasks(poisoned);

  for (const changes of [
    { sourceKey: 'foreign-profile-and-owner' },
    { epoch: typeof snapshot.epoch === 'number' ? snapshot.epoch - 1 : 'old-epoch' },
    { script: 'unknown-field' },
  ]) {
    mirrorChannel.onmessage({ data: {
      ...snapshot,
      ...changes,
      readAt: snapshot.readAt + 1000,
      data: poisoned,
    } });
    await flushMulti();
    assert.deepEqual(rowRefs(mirror), before);
  }

  assert.equal(mirrorChannel.sent.filter((message) => message.type === 'board-snapshot').length,
    echoes, 'Приём не посылает снимок обратно');
});
