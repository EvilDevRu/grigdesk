import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { createPinia, setActivePinia } from '../../web/node_modules/pinia/dist/pinia.mjs';

import { api, ApiError } from '../../web/src/shared/apiClient.ts';
import { useBoardStore } from '../../web/src/stores/board.ts';
import { useTasksStore } from '../../web/src/stores/tasks.ts';
import { startBoardRelay } from '../../web/src/shared/windowRelay.ts';
import { useTrackersStore } from '../../web/src/stores/trackers.ts';

/**
 * Барьер отделяет поздний ответ прежнего источника от текущего чтения.
 * Все производители освобождаются в finally независимо от проверки.
 */
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

test('SOURCE-01: успех A, смена аккаунта и ошибка B не показывают задачи A', async (t) => {
  setActivePinia(createPinia());

  let login = 'one';

  t.mock.method(api, 'get', async (path) => {
    if (path === '/api/trackers') {
      return {
        externalId: login,
        revision: login === 'one' ? 1 : 2,
      };
    }
    if (path === '/api/tracker/task-seen') {
      return {
        scope: 'fixture',
        revision: 1,
        initialized: true,
        taskIds: [],
      };
    }
    if (login === 'two') {
      throw new TypeError('fixture B unavailable');
    }

    return { tasks: [{ id: 42, title: 'Only A' }] };
  });

  const board = useBoardStore();

  await board.load(true);
  assert.equal(typeof board.sourceKey, 'string');
  assert.ok(board.sourceKey);

  const oldSource = board.sourceKey;

  login = 'two';
  await board.load(true);
  assert.equal(board.data, null);
  assert.notEqual(board.sourceKey, oldSource);
  board.applySnapshot({ tasks: [{ id: 42, title: 'Only A' }] }, Date.now() + 1000, oldSource);
  assert.equal(board.data, null);
});

test('SOURCE-02: поздний GET A не восстанавливает данные и не завершает новое чтение B', async (t) => {
  setActivePinia(createPinia());

  const oldReply = deferred();
  const newReply = deferred();
  let login = 'one';

  t.mock.method(api, 'get', async (path) => {
    if (path === '/api/trackers') {
      return {
        externalId: login,
        revision: login === 'one' ? 1 : 2,
      };
    }
    if (path === '/api/tracker/task-seen') {
      return {
        scope: 'fixture',
        revision: 1,
        initialized: true,
        taskIds: [],
      };
    }

    return login === 'one' ? oldReply.promise : newReply.promise;
  });

  const board = useBoardStore();
  const first = board.load(true);
  let second;

  try {
    await setImmediate();
    assert.equal(typeof board.clearSource, 'function');
    board.clearSource();
    login = 'two';
    second = board.load(true);
    await setImmediate();
    oldReply.resolve({ tasks: [{ id: 42, title: 'Only A' }] });
    await first;
    assert.equal(board.data, null);
    assert.equal(board.loading, true);
    newReply.resolve({ tasks: [{ id: 88, title: 'Only B' }] });
    await second;
    assert.equal(board.data.tasks[0].title, 'Only B');
  } finally {
    oldReply.resolve({ tasks: [] });
    newReply.resolve({ tasks: [] });
    await Promise.allSettled([first, second]);
  }
});

test('SOURCE-03: запись настроек снимает снимок до POST, подтверждение запускает чтение', async (t) => {
  setActivePinia(createPinia());

  const pending = deferred();
  const board = useBoardStore();

  t.mock.method(api, 'post', () => pending.promise);
  t.mock.method(api, 'get', async (path) => path === '/api/trackers'
    ? sourceView() : path.endsWith('task-seen') ? seenView : { tasks: [] });

  const writing = useTrackersStore().saveSettings({
    externalId: 'one',
    settings: {},
    expectedRevision: 1,
  });

  try {
    assert.equal(board.sourceSuspended, true);
    pending.resolve({ revision: 2 });
    await writing;
    assert.equal(board.sourceSuspended, false);
    assert.deepEqual(board.data.tasks, []);
  } finally {
    pending.resolve({ revision: 2 });
    await writing;
  }
});
/**
 * Валидный публичный снимок принадлежит только синтетической конфигурации теста.
 * В нём нет пароля, cookie или номера пользователя портала.
 */
function sourceView(login = 'one') {
  return {
    externalId: login,
        revision: login === 'one' ? 1 : 2,
  };
}

const seenView = {
  scope: 'fixture',
  revision: 1,
  initialized: true,
  taskIds: [],
};

test('SOURCE-04: удержанный probe зеркала не поглощает refresh после timer POST', async (t) => {
  setActivePinia(createPinia());

  const probe = deferred();
  let probes = 0;
  let dashboards = 0;

  t.mock.method(api, 'get', async (path) => {
    if (path === '/api/trackers') {
      probes += 1;

      return probes === 1 ? probe.promise : sourceView();
    }
    if (path === '/api/tracker/task-seen') {
      return seenView;
    }

    dashboards += 1;

    return { tasks: [] };
  });
  t.mock.method(api, 'post', async () => ({}));

  const board = useBoardStore();

  board.setMirror(() => undefined);

  const passive = board.load();
  let mutation;

  try {
    await setImmediate();
    mutation = useTasksStore().timer('42', 'start');
    await setImmediate();
    assert.equal(dashboards, 0);
    probe.resolve(sourceView());
    await mutation;
    await passive;
    assert.equal(dashboards, 1);
  } finally {
    probe.resolve(sourceView());
    await Promise.allSettled([passive, mutation]);
  }
});

test('SOURCE-05: ошибка старого GET не меняет новый relay того же источника', async (t) => {
  setActivePinia(createPinia());

  const failed = deferred();

  t.mock.method(api, 'get', async (path) => {
    if (path === '/api/trackers') {
      return sourceView();
    }

    await failed.promise;

    throw new TypeError('fixture old read failed');
  });

  const board = useBoardStore();
  const reading = board.load(true);

  try {
    await setImmediate();

    const newer = Date.now() + 1000;

    board.applySnapshot({ tasks: [{ id: 88 }] }, newer, board.sourceKey);
    failed.resolve();
    await reading;
    assert.equal(board.data.tasks[0].id, 88);
    assert.equal(board.readAt, newer);
    assert.equal(board.error, null);
  } finally {
    failed.resolve();
    await reading;
  }
});

test('SOURCE-06: удержанный POST закрывает polling и relay до проверенного исхода', async (t) => {
  setActivePinia(createPinia());

  let login = 'one';
  let dashboards = 0;
  const post = deferred();
  let refreshed;

  t.mock.method(api, 'get', async (path) => {
    if (path === '/api/trackers') {
      return sourceView(login);
    }
    if (path === '/api/tracker/task-seen') {
      return seenView;
    }

    dashboards += 1;

    return { tasks: [{ id: login === 'one' ? 42 : 88 }] };
  });

  const board = useBoardStore();

  await board.load(true);

  const oldKey = board.sourceKey;

  t.mock.method(api, 'post', () => post.promise);

  const writing = useTrackersStore().saveSettings({
    externalId: 'two',
    settings: {},
    expectedRevision: 1,
  });

  try {
    await board.load(true);
    board.applySnapshot({ tasks: [{ id: 42 }] }, Date.now() + 1000, oldKey);
    assert.equal(board.sourceSuspended, true);
    assert.equal(board.data, null);
    assert.equal(dashboards, 1);
    login = 'two';
    post.resolve(sourceView(login));
    await writing;
    await refreshed;
    assert.equal(board.sourceSuspended, false);
    assert.equal(board.data.tasks[0].id, 88);
    assert.equal(dashboards, 2);
  } finally {
    post.resolve(sourceView(login));
    await writing;
    await refreshed;
  }
});

test('SOURCE-07: исход старой записи не снимает паузу новой записи', async (t) => {
  setActivePinia(createPinia());

  t.mock.method(api, 'get', async (path) => path === '/api/trackers'
    ? sourceView() : path === '/api/tracker/task-seen' ? seenView : { tasks: [] });

  const board = useBoardStore();
  const first = board.beginSourceChange();
  const second = board.beginSourceChange();

  await board.finishSourceChange(first);
  assert.equal(board.sourceSuspended, true);
  await board.finishSourceChange(second);
  assert.equal(board.sourceSuspended, false);
  assert.deepEqual(board.data.tasks, []);
});

/**
 * Настоящая шина связывает два независимых Pinia store через управляемые каналы.
 * Доставка идёт в микрозадачах, поэтому очистка и повторная проверка не рекурсивны.
 */
function boardPair(source, mirror) {
  const a = {
    onmessage: null,
    sent: [],
    close() {},
  };
  const b = {
    onmessage: null,
    sent: [],
    close() {},
  };

  a.postMessage = (data) => {
    a.sent.push(data);
    queueMicrotask(() => b.onmessage?.({ data }));
  };
  b.postMessage = (data) => {
    b.sent.push(data);
    queueMicrotask(() => a.onmessage?.({ data }));
  };

  const bind = (board, role, channel) => startBoardRelay({
    role,
    channel,
    sourceState: () => ({ key: board.sourceKey, suspended: board.sourceSuspended }),
    snapshot: () => board.data ? {
      data: board.data,
      readAt: board.readAt,
      sourceKey: board.sourceKey,
    } : null,
    watchLoads: (callback) => board.$onAction(({ name, after }) => {
      if (name === 'load') {
        after((readAt) => {
          if (typeof readAt === 'number' && readAt === board.readAt) {
            callback();
          }
        });
      }
    }),
    watchInvalidation: (callback) => board.$onAction(({ name, after }) => {
      if (['clearSource', 'beginSourceChange', 'finishSourceChange'].includes(name)) {
        after(() => callback());
      }
    }),
    apply: (data, readAt, key) => board.applySnapshot(data, readAt, key),
    invalidate: (suspended) => board.clearSource(suspended),
    recheck: () => board.load(),
    mirror: (request) => board.setMirror(request),
  });
  const stopA = bind(source, 'source', a);
  const stopB = bind(mirror, 'mirror', b);

  return {
    a,
    b,
    close() {
      stopA();
      stopB();
    },
  };
}

test('SOURCE-RELAY: A очищается в зеркале даже при ошибке B, затем B принимается', async (t) => {
  const source = useBoardStore(createPinia());
  const mirror = useBoardStore(createPinia());
  let login = 'one';
  let available = true;
  let dashboards = 0;

  t.mock.method(api, 'get', async (path) => {
    if (path === '/api/trackers') {
      return sourceView(login);
    }
    if (path === '/api/tracker/task-seen') {
      return seenView;
    }

    dashboards += 1;

    if (!available) {
      throw new TypeError('fixture B unavailable');
    }

    return { tasks: [{ id: login === 'one' ? 42 : 88 }] };
  });

  const pair = boardPair(source, mirror);

  t.after(() => pair.close());
  await source.load(true);
  await mirror.load();
  await setImmediate();
  await setImmediate();
  assert.equal(mirror.data.tasks[0].id, 42);

  const old = pair.a.sent.find((item) => item.type === 'board-snapshot');
  const token = source.beginSourceChange();

  await setImmediate();
  assert.equal(mirror.data, null);
  assert.equal(mirror.sourceSuspended, true);
  login = 'two';
  available = false;
  await source.finishSourceChange(token);
  await setImmediate();
  await setImmediate();
  assert.equal(mirror.data, null);
  available = true;
  await source.load(true);
  await setImmediate();
  await setImmediate();
  assert.equal(mirror.data.tasks[0].id, 88);
  pair.b.onmessage({ data: old });
  await setImmediate();
  await setImmediate();
  assert.equal(mirror.data.tasks[0].id, 88);
  assert.equal(dashboards, 3, 'зеркало не делает собственный dashboard GET');
});

for (const [name, error] of [
  ['failed', new ApiError('fixture rejected', 400, {})],
  ['unknown', new TypeError('fixture connection lost')],
]) {
  test(`SOURCE-OUTCOME: ${name} снимает паузу без повтора POST`, async (t) => {
    setActivePinia(createPinia());

    let posts = 0;

    t.mock.method(api, 'post', async () => {
      posts += 1;

      throw error;
    });
    t.mock.method(api, 'get', async (path) => path === '/api/trackers'
      ? sourceView() : path.endsWith('task-seen') ? seenView : { tasks: [] });

    await assert.rejects(useTrackersStore().saveSettings({
      externalId: 'two',
    settings: {},
    expectedRevision: 1,
    }));
    assert.equal(useBoardStore().sourceSuspended, false);
    assert.equal(posts, 1);
  });
}



test('SOURCE-SHAPE: намеренная форма board совпадает с его секцией golden', async () => {
  setActivePinia(createPinia());

  const baseline = JSON.parse(await readFile(
    new URL('../fixtures/webRuntimeBaseline.json', import.meta.url), 'utf8',
  ));
  const board = useBoardStore();

  assert.deepEqual(
    JSON.parse(JSON.stringify(board.$state)),
    baseline.stores['web/src/stores/board.ts'].state,
  );
});

for (const broken of [
  { drivers: null },
  { drivers: [{ id: 'fixture', dataRevision: -1 }] },
  { enabledIds: ['missing'] },
  { default: 'missing' },
]) {
  const label = `SOURCE-METADATA: повреждённый каталог ${JSON.stringify(broken)}`;

  test(label, async (t) => {
    setActivePinia(createPinia());

    const calls = [];

    t.mock.method(api, 'get', async (path) => {
      calls.push(path);

      return {
        externalId: 'fixture',
        revision: 1,
        enabledIds: ['fixture'],
        default: 'fixture',
        drivers: [{ id: 'fixture', dataRevision: 1 }],
        ...broken,
      };
    });

    const board = useBoardStore();

    await board.load(true);
    assert.ok(board.error);
    assert.equal(board.data, null);
    assert.equal(calls.every((path) => path === '/api/trackers'), true);
  });
}
