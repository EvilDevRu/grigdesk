import assert from 'node:assert/strict';
import test from 'node:test';

import {
  driverContext, generationHeader, multiFixture, saveMulti, shelfInput,
} from './helpers/trackerMulti.js';

const PERSONAL = [
  ['task-favorites', 'PUT', '/42', undefined, 'taskIds'],
  ['task-seen', 'POST', '', { taskIds: ['42'], baseline: true }, 'taskIds'],
  ['task-shelf', 'PUT', '/42', shelfInput(), 'entries'],
];

for (const [suffix, method, tail, payload, field] of PERSONAL) {
  test(`MD-PERSONAL: ${suffix} A42 не меняет B42, scope задаёт сервер`, async (t) => {
    const fixture = await multiFixture(t, { personal: true });

    if (suffix === 'task-shelf') {
      const control = await fixture.request('PUT', '/api/tracker/task-shelf/999', payload);

      assert.equal(control.statusCode, 200, 'Фикстура полки должна проходить прежнюю валидацию');
      assert.equal((await fixture.request('DELETE', '/api/tracker/task-shelf/999')).statusCode, 200);
    }

    const a = await fixture.request('GET', `/api/tracker/fixture-a/${suffix}`);
    const b = await fixture.request('GET', `/api/tracker/fixture-b/${suffix}`);

    assert.equal(a.statusCode, 200, a.body);
    assert.equal(b.statusCode, 200, b.body);
    assert.notEqual(a.json().scope, b.json().scope);

    const write = await fixture.request(method, `/api/tracker/fixture-a/${suffix}${tail}?scope=evil`, {
      ...payload,
      scope: b.json().scope,
    });

    assert.equal(write.statusCode, 200, write.body);
    assert.equal(write.json().scope, a.json().scope);
    assert.equal(write.json()[field].length, 1);
    assert.deepEqual((await fixture.request('GET', `/api/tracker/fixture-b/${suffix}`)).json(), b.json());
  });
}

for (const changed of ['fixture-a', 'fixture-b']) {
  test(`MD-PERSONAL-RACE: очередь A повторно сверяет поколение после изменения ${changed}`, async (t) => {
    const fixture = await multiFixture(t, { personal: true });
    const context = await driverContext(fixture, 'fixture-a');
    const store = fixture.services.favorites.store;
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const original = store.add.bind(store);

    store._chain = release.promise;
    t.mock.method(store, 'add', (...args) => {
      entered.resolve();

      return original(...args);
    });
    t.after(() => release.resolve());

    const writing = fixture.request('PUT', '/api/tracker/fixture-a/task-favorites/42', undefined,
      generationHeader(context));

    try {
      await Promise.race([
        entered.promise,
        writing.then((response) => assert.fail(`Запись не дошла до очереди: ${response.body}`)),
      ]);

      const updated = await saveMulti(fixture, ['fixture-a', 'fixture-b'], 'fixture-b', {
        [changed]: { endpoint: 'https://changed.fixture' },
      });

      assert.equal(updated.statusCode, 200, updated.body);
    } finally {
      release.resolve();
    }

    const response = await writing;

    assert.equal(response.statusCode, changed === 'fixture-a' ? 409 : 200, response.body);
    assert.deepEqual((await store.list(context.source.split('@')[1])).taskIds,
      changed === 'fixture-a' ? [] : ['42']);
  });
}
