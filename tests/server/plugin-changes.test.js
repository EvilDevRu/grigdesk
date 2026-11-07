import assert from 'node:assert/strict';
import test from 'node:test';

import { PLUGIN_SLOT_NAMES } from '../../shared/plugins/slots/index.ts';

import { runtimeFixture, settle } from './helpers/pluginRuntimeFixture.js';

const slot = PLUGIN_SLOT_NAMES[0];
const manifest = {
  contributes: {
    settings: [
      {
        key: 'limit',
        type: 'number',
        min: 2,
        max: 10,
        step: 2,
        default: 4,
      },
      {
        key: 'name',
        type: 'text',
        default: 'Исходное',
      },
    ],
    slots: [{
      slot,
      kind: 'provider-usage',
      default: true,
    }],
  },
};

/**
 * Transition пишет только наблюдаемые фазы, не меняя prefs самостоятельно.
 * Поэтому порядок и число commit/rollback отличают принятие от отклонения изменения.
 */
function transition(events) {
  return {
    commit: () => events.push('commit'),
    rollback: async () => events.push('rollback'),
    afterCommit: async () => events.push('afterCommit'),
  };
}

for (const action of ['settings', 'toggle']) {
  test(`CHANGE-01: отказ prepare на ${action} сохраняет prefs и допуск`, async (t) => {
    const events = [];
    const f = await runtimeFixture(t, [{
      id: 'demo',
      manifest,
      hooks: {
        prepareChange: () => {
          events.push('prepare');

          throw Object.assign(new Error('Лимит недоступен.'), {
            statusCode: 422,
            code: 'fixture_rejected',
          });
        },
        onDisable: () => events.push('disable'),
      },
    }]);
    const before = structuredClone(f.prefs.read());
    const response = action === 'settings'
      ? await f.settings('demo', { values: { limit: 6 } }) : await f.toggle('demo', false);

    assert.equal(response.statusCode, 422);
    assert.deepEqual(response.json(), { error: 'fixture_rejected', message: 'Лимит недоступен.' });
    assert.deepEqual(f.prefs.read(), before);
    assert.deepEqual(events, ['prepare']);
    assert.equal((await f.request('GET', '/api/ext/demo/x')).statusCode, 200);
  });
}

test('CHANGE-01: неизвестная ошибка не раскрывает текст исключения', async (t) => {
  const f = await runtimeFixture(t, [{
    id: 'demo',
    manifest,
    hooks: { prepareChange: () => {
      throw new Error('SECRET');
    } },
  }]);
  const response = await f.settings('demo', { values: { limit: 6 } });

  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.json(), {
    error: 'plugin_change_rejected',
    message: 'Плагин отклонил изменения настроек.',
  });
  assert.equal(f.writes.length, 0);
});

test('CHANGE-02: prepare с defaults → write → sync commit → afterCommit', async (t) => {
  const events = [];
  let received;
  const f = await runtimeFixture(t, [{
    id: 'demo',
    manifest,
    hooks: {
      prepareChange(change) {
        received = structuredClone(change);
        events.push('prepare');

        return transition(events);
      },
    },
  }], { beforeWrite: () => events.push('write') });
  const response = await f.settings('demo', { values: { limit: '7', garbage: true } });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(received, { values: { limit: 8, name: 'Исходное' } });
  assert.deepEqual(events, ['prepare', 'write', 'commit', 'afterCommit']);
  assert.deepEqual(f.prefs.read().pluginSettings.demo, { limit: 8 });
});

test('CHANGE-02: отказ prefs.write откатывает ровно раз и сохраняет enabled', async (t) => {
  const events = [];
  const f = await runtimeFixture(t, [{
    id: 'demo',
    manifest,
    hooks: {
      prepareChange: () => transition(events),
      onDisable: () => events.push('disable'),
    },
  }], { beforeWrite: () => {
    throw new Error('Синтетический отказ записи');
  } });
  const before = structuredClone(f.prefs.read());
  const response = await f.toggle('demo', false);

  assert.equal(response.statusCode, 500);
  assert.deepEqual(events, ['rollback']);
  assert.deepEqual(f.prefs.read(), before);
  assert.equal((await f.request('GET', '/api/ext/demo/x')).statusCode, 200);
});

test('CHANGE-02: неверная форма transition отклоняется до записи', async (t) => {
  const f = await runtimeFixture(t, [{
    id: 'demo',
    manifest,
    hooks: { prepareChange: () => ({ commit: 42, rollback: async () => {} }) },
  }]);
  const before = structuredClone(f.prefs.read());
  const response = await f.settings('demo', { values: { limit: 8 } });

  assert.equal(response.statusCode, 409);
  assert.deepEqual(f.prefs.read(), before);
  assert.equal(f.writes.length, 0);
});

test('CHANGE-03: 4999/5000, abort, busy с выходом, поздний rollback и повтор', async (t) => {
  const held = Promise.withResolvers();
  const events = [];

  t.after(() => held.resolve(transition(events)));

  let signal;
  let prepares = 0;
  const f = await runtimeFixture(t, [{
    id: 'demo',
    manifest,
    hooks: {
      prepareChange(_change, value) {
        prepares += 1;
        signal = value;

        return prepares === 1 ? held.promise : transition(events);
      },
    },
  }]);

  t.mock.timers.enable({ apis: ['setTimeout'] });

  let complete = false;
  const pending = f.settings('demo', { values: { limit: 8 } }).then((response) => {
    complete = true;

    return response;
  });

  await settle();
  assert.equal(prepares, 1, 'пользовательская подготовка должна вызываться');
  t.mock.timers.tick(4999);
  await settle();
  assert.equal(complete, false);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);

  const response = await pending;

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error, 'plugin_change_timeout');
  assert.equal(signal.aborted, true);
  assert.equal(f.writes.length, 0);
  assert.equal((await f.request('GET', '/api/ext/demo/x')).statusCode, 200);

  const busy = await f.toggle('demo', false);

  assert.equal(busy.statusCode, 409);
  assert.equal(busy.json().error, 'plugin_change_busy');
  assert.match(busy.json().message, /перезапуст/i);
  assert.equal(prepares, 1);
  held.resolve(transition(events));
  await settle();
  assert.deepEqual(events, ['rollback']);
  assert.equal((await f.settings('demo', { values: { limit: 6 } })).statusCode, 200);
  assert.equal(prepares, 2);
  assert.deepEqual(events, ['rollback', 'commit', 'afterCommit']);
});

for (const reject of [false, true]) {
  test(`CHANGE-04: settings/toggle/replacement исключены, свежие prefs, reject=${reject}`, async (t) => {
    const held = Promise.withResolvers();

    t.after(() => held.resolve());

    let prepares = 0;
    const f = await runtimeFixture(t, [{
      id: 'demo',
      manifest,
      hooks: {
        prepareChange: () => {
          prepares += 1;

          return held.promise;
        },
        prepareReplace: async () => ({ async finish() {} }),
      },
    }, { id: 'other', manifest }]);

    assert.ok(slot, 'слот берётся из того же оглавления, что и validator');
    assert.equal((await f.settings('demo', { placements: { [slot]: true } })).statusCode, 200);
    assert.equal(f.prefs.read().pluginPlacements.demo[slot], true);
    assert.equal(prepares, 0);

    const pending = f.settings('demo', { values: { limit: 8 } });

    await settle();
    assert.equal(prepares, 1);
    assert.equal((await f.toggle('demo', false)).json().error, 'plugin_change_busy');
    assert.equal((await f.settings('demo', { values: { limit: 2 } })).json().error, 'plugin_change_busy');
    await assert.rejects(f.port.runtime.prepareReplace('demo', new AbortController().signal), {
      code: 'plugin_busy',
    });
    assert.equal((await f.settings('other', { values: { name: 'Сосед' } })).statusCode, 200);
    assert.equal((await f.settings('demo', { placements: { [slot]: false } })).statusCode, 200);
    assert.equal(prepares, 1, 'placements-only не вызывает validator');

    if (reject) {
      held.reject(new Error('Отказ подготовки'));
    } else {
      held.resolve();
    }

    assert.equal((await pending).statusCode, reject ? 409 : 200);
    assert.equal(f.prefs.read().pluginSettings.other.name, 'Сосед');
    assert.equal(f.prefs.read().pluginPlacements.demo[slot], false);
    assert.equal(f.prefs.read().pluginSettings.demo?.limit, reject ? undefined : 8);
  });
}

test('CHANGE-04: reservation replacement не допускает подготовку настроек', async (t) => {
  let prepares = 0;
  const f = await runtimeFixture(t, [{
    id: 'demo',
    manifest,
    hooks: {
      prepareChange: () => {
        prepares += 1;
      },
      prepareReplace: async () => ({ async finish() {} }),
    },
  }]);
  const lease = await f.port.runtime.prepareReplace('demo', new AbortController().signal);

  try {
    const response = await f.settings('demo', { values: { limit: 8 } });

    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, 'plugin_change_busy');
    assert.equal(prepares, 0);
    assert.equal(f.writes.length, 0);
  } finally {
    await lease.finish('reverted');
  }
});

test('CHANGE-05: afterCommit ограничен 5000 мс, prefs приняты, reservation до cleanup', async (t) => {
  const held = Promise.withResolvers();

  t.after(() => held.resolve());

  let afterCommits = 0;
  const f = await runtimeFixture(t, [{
    id: 'demo',
    manifest,
    hooks: {
      prepareChange: () => ({
        commit() {},
        rollback: async () => {},
        afterCommit() {
          afterCommits += 1;

          return afterCommits === 1 ? held.promise : Promise.resolve();
        },
      }),
    },
  }]);

  t.mock.timers.enable({ apis: ['setTimeout'] });

  let done = false;
  const pending = f.settings('demo', { values: { limit: 8 } }).then((response) => {
    done = true;

    return response;
  });

  await settle();
  assert.equal(afterCommits, 1);
  assert.equal(f.prefs.read().pluginSettings.demo.limit, 8);
  t.mock.timers.tick(4999);
  await settle();
  assert.equal(done, false);
  t.mock.timers.tick(1);
  assert.equal((await pending).statusCode, 200);
  assert.equal((await f.settings('demo', { values: { limit: 4 } })).json().error, 'plugin_change_busy');
  held.resolve();
  await settle();
  assert.equal((await f.settings('demo', { values: { limit: 4 } })).statusCode, 200);
  assert.equal(afterCommits, 2);
});
