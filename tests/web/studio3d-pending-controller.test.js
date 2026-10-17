import assert from 'node:assert/strict';
import test from 'node:test';

import { createPendingIntentController } from '../../web/src/features/studio3d/pendingIntentController.ts';
import { Studio3dApiError } from '../../web/src/features/studio3d/studio3dApi.ts';
import { studioFingerprint } from '../../web/src/features/studio3d/pendingIntents.ts';
import { LIBRARY_ID, UNIT } from './helpers/studio3d-fixtures.js';

/**
 * Управляемое обещание отмечает точку эффекта, не полагаясь на задержку часов.
 * Тесты освобождают удержание в finally и ограничены собственным deadline.
 */
function barrier() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });

  return { promise, release };
}

/**
 * Снимок формы не содержит UUID: он появляется в durable записи нажатия.
 * Дополнительные поля помогают отличить новое содержимое от повтора прежнего.
 */
function runInput(overrides = {}) {
  return {
    provider: 'tripo',
    operation: 'text-to-model',
    values: { prompt: 'Куб' },
    expectedPrice: 20,
    name: 'Куб',
    ...overrides,
  };
}

/**
 * Порты разделяют сохранённый журнал, видимый pending и состояние сессии.
 * Хуки удерживают запись или ответ транспорта; никаких Vue и серверных процессов нет.
 */
function fixture() {
  const h = {
    session: {
      owner: 'fixture-owner',
      libraryId: LIBRARY_ID,
      generation: 1,
      started: true,
      libraryOk: true,
    },
    saved: new Map(),
    pending: [],
    events: [],
    posts: [],
    reads: [],
    sent: [],
    errors: [],
    dropped: [],
    ends: [],
    hooks: {},
    now: 1_000_000,
    uuids: 0,
    busy: 0,
  };

  /**
   * Каждый API endpoint сохраняет собственный вид и независимый снимок тела.
   * Успех не подменяет decoder: контроллер получает уже проверенный портом результат.
   */
  const send = async (kind, body, modelId, versionId) => {
    const post = {
      kind,
      body: structuredClone(body),
      modelId,
      versionId,
    };

    h.posts.push(post);
    h.events.push('post');

    if (h.hooks[kind]) {
      return h.hooks[kind](body, modelId, versionId);
    }

    return {
      libraryId: LIBRARY_ID,
      intentId: body.idempotencyKey,
      model: null,
      versions: [],
      deleted: false,
    };
  };
  const ports = {
    storage: {
      list: async (owner) => [...h.saved.values()].filter((record) => record.owner === owner)
        .map((record) => structuredClone(record)),
      put: async (record) => {
        h.events.push('put:start');
        await h.hooks.put?.(record);
        h.saved.set(record.key, structuredClone(record));
        h.events.push('put:done');
      },
      remove: async (key) => {
        h.events.push('remove');
        h.saved.delete(key);
      },
    },
    api: {
      run: (body) => send('run', body),
      retry: (modelId, versionId, body) => send('retry', body, modelId, versionId),
      batchRun: (body) => send('batch', body),
      job: async (key, libraryId) => {
        h.reads.push({ key, libraryId });

        return h.hooks.job ? h.hooks.job(key, libraryId) : {};
      },
    },
    fingerprint: studioFingerprint,
    now: () => h.now,
    uuid: () => {
      h.uuids += 1;

      return `00000000-0000-4000-8000-${String(h.uuids).padStart(12, '0')}`;
    },
    session: () => h.session,
    pending: {
      list: () => h.pending,
      add: (record) => {
        if (!h.pending.some((item) => item.key === record.key)) {
          h.pending.push(record);
        }
      },
      replace: (record) => {
        h.pending = h.pending.map((item) => item.key === record.key ? record : item);
      },
      remove: (key) => {
        h.pending = h.pending.filter((item) => item.key !== key);
      },
      reset: (records) => {
        h.pending = records;
      },
    },
    busy: {
      begin: () => {
        h.busy += 1;
        h.events.push('busy:begin');
      },
      end: (generation) => {
        h.ends.push(generation);
        h.busy = Math.max(0, h.busy - 1);
        h.events.push('busy:end');
      },
    },
    onSent: (result, generation) => h.sent.push({ result, generation }),
    onError: (cause, generation) => h.errors.push({ cause, generation }),
    onDropped: (record, text) => h.dropped.push({ record, text }),
  };

  return {
    h,
    ports,
    controller: createPendingIntentController(ports),
  };
}

test('PC-01: только подтверждённый put разрешает ровно один POST',
  { timeout: 60_000 }, async () => {
    const { h, controller } = fixture();
    const entered = barrier();
    const held = barrier();

    h.hooks.put = async () => {
      entered.release();
      await held.promise;
    };

    const work = controller.submit('run', runInput());

    try {
      await entered.promise;
      assert.equal(h.posts.length, 0);
      assert.equal(h.busy, 0);
    } finally {
      held.release();
      await work;
    }

    assert.equal(h.posts.length, 1);
    assert.equal(h.events.indexOf('put:done') < h.events.indexOf('post'), true);
  });

/**
 * Запись recovery задаётся независимо от submit и не пересчитывается новым каталогом.
 * Request и его UUID остаются исходными даже после чтения нового экземпляра контроллера.
 */
function savedRecord(overrides = {}) {
  return {
    key: '00000000-0000-4000-8000-000000000001',
    owner: 'fixture-owner',
    libraryId: LIBRARY_ID,
    kind: 'run',
    fingerprint: 'сохранённый отпечаток',
    request: {
      ...runInput(),
      libraryId: LIBRARY_ID,
      idempotencyKey: '00000000-0000-4000-8000-000000000001',
    },
    at: 1_000_000,
    ...overrides,
  };
}

/**
 * Пачка использует полный серверный снимок с собственной ценой и единицей.
 * Контроллер отправляет его целиком, не строит строки из текущей формы заново.
 */
function batchInput() {
  return {
    snapshot: {
      libraryId: LIBRARY_ID,
      catalogVersion: 'fixture',
      rows: [{
        provider: 'tripo',
        operation: 'text-to-model',
        values: { prompt: 'Куб' },
        name: 'Куб',
        project: null,
        category: null,
        expectedPrice: 20,
      }],
      totalEstimated: 20,
      unit: UNIT,
    },
    snapshotHash: 'fixture-hash',
  };
}

test('PC-02: два нажатия до put получают один UUID и один POST',
  { timeout: 60_000 }, async () => {
    const { h, controller } = fixture();
    const entered = barrier();
    const held = barrier();

    h.hooks.put = async () => {
      entered.release();
      await held.promise;
    };

    const first = controller.submit('run', runInput());
    const second = controller.submit('run', runInput());

    try {
      await entered.promise;
      assert.equal(first === second, true);
      assert.equal(h.uuids, 1);
      assert.equal(h.posts.length, 0);
    } finally {
      held.release();
      await Promise.all([first, second]);
    }

    assert.equal(h.posts.length, 1);
  });

test('PC-03: потерянный ответ сохраняет UUID и полное тело повтора', async () => {
  const { h, controller } = fixture();

  h.hooks.run = () => {
    throw new TypeError('Потерян ответ.');
  };
  await assert.rejects(controller.submit('run', runInput()));

  const before = structuredClone(h.posts[0].body);

  assert.equal(h.saved.size, 1);
  assert.equal(h.pending.length, 1);
  delete h.hooks.run;
  await controller.submit('run', runInput());
  assert.deepEqual(h.posts[1].body, before);
  assert.equal(h.uuids, 1);
  assert.equal(h.saved.size, 0);
});

test('PC-04: recovery читает job до POST и только 404 разрешает прежний снимок', async () => {
  for (const [missing, postCount] of [[false, 0], [true, 1]]) {
    const { h, controller } = fixture();
    const record = savedRecord();

    h.saved.set(record.key, record);

    if (missing) {
      h.hooks.job = () => {
        throw new Studio3dApiError(404, 'not_found', {});
      };
    }

    await controller.recoverPending();
    assert.equal(h.reads.length, 1);
    assert.equal(h.posts.length, postCount);
    assert.equal(h.saved.size, 0);
    assert.equal(h.pending.length, 0);

    if (missing) {
      assert.deepEqual(h.posts[0].body, record.request);
    }
  }
});

test('PC-05: десять минут допускаются, лишняя миллисекунда снимает запись с объяснением', async () => {
  for (const [age, posts, dropped] of [[600_000, 1, 0], [600_001, 0, 1]]) {
    const { h, controller } = fixture();
    const record = savedRecord({ at: h.now - age });

    h.saved.set(record.key, record);
    h.hooks.job = () => {
      throw new Studio3dApiError(404, 'not_found', {});
    };
    await controller.recoverPending();
    assert.equal(h.posts.length, posts);
    assert.equal(h.dropped.length, dropped);
    assert.equal(h.saved.size, 0);

    if (dropped) {
      assert.equal(h.dropped[0].text,
        'Заказ «Куб» не отправлен: связь оборвалась. Повторите вручную.');
    }
  }
});

test('PC-06: другой owner, library и blocked запись не отправляются', async () => {
  for (const override of [{ owner: 'other' }, { libraryId: 'other' }, { blocked: 'Запрещено.' }]) {
    const { h, controller } = fixture();
    const record = savedRecord(override);

    await assert.rejects(controller.sendPending(record));
    assert.equal(h.posts.length, 0);
    assert.equal(h.events.length, 0);
    h.saved.set(record.key, record);
    await controller.recoverPending();
    assert.equal(h.posts.length, 0);
    assert.equal(h.reads.length, 0);
  }
});

test('PC-07: поздний успех снимает запись, но не вызывает onSent и busy нового поколения',
  { timeout: 60_000 }, async () => {
    const { h, controller } = fixture();
    const entered = barrier();
    const held = barrier();

    h.hooks.run = async (body) => {
      entered.release();
      await held.promise;

      return { libraryId: LIBRARY_ID, intentId: body.idempotencyKey };
    };

    const work = controller.submit('run', runInput());

    try {
      await entered.promise;
      h.session.generation = 2;
      h.busy = 5;
    } finally {
      held.release();
      await work;
    }

    assert.equal(h.saved.size, 0);
    assert.equal(h.pending.length, 0);
    assert.equal(h.sent.length, 0);
    assert.equal(h.errors.length, 0);
    assert.deepEqual(h.ends, []);
    assert.equal(h.busy, 5);
  });

test('PC-08: price_changed сохраняет blocked и возвращает расчёт без второй оплаты', async () => {
  const { h, controller } = fixture();
  const quote = {
    total: 30,
    lines: [{ label: 'Модель', amount: 30 }],
    unit: UNIT,
    usd: null,
    note: null,
  };

  h.hooks.run = () => {
    throw new Studio3dApiError(409, 'price_changed', { message: 'Цена изменилась.', quote });
  };

  const result = await controller.submit('run', runInput());

  assert.deepEqual(result, { priceChanged: quote });
  assert.equal(h.posts.length, 1);
  assert.equal(h.pending[0].blocked, 'Цена изменилась.');
  assert.equal([...h.saved.values()][0].blocked, 'Цена изменилась.');
  assert.equal(h.errors.length, 0);
});

test('PC-09: run, retry и batch выбирают свои адресные порты с прежним UUID', async () => {
  for (const [kind, input, modelId, versionId] of [
    ['run', runInput(), undefined, undefined],
    ['retry', { expectedPrice: 20 }, 'fixture-model', 'v01-model'],
    ['batch', batchInput(), undefined, undefined],
  ]) {
    const { h, controller } = fixture();
    const key = '00000000-0000-4000-8000-000000000088';

    await controller.submit(kind, input, key, modelId, versionId);
    assert.equal(h.posts.length, 1);
    assert.equal(h.posts[0].kind, kind);
    assert.equal(h.posts[0].body.idempotencyKey, key);
    assert.deepEqual(h.posts[0].body, {
      ...input,
      libraryId: LIBRARY_ID,
      idempotencyKey: key,
    });

    if (kind === 'retry') {
      assert.equal(h.posts[0].modelId, 'fixture-model');
      assert.equal(h.posts[0].versionId, 'v01-model');
    }
  }
});

test('PC-10: закрытая библиотека или сессия запрещает даже put', async () => {
  for (const field of ['libraryOk', 'started']) {
    const { h, controller } = fixture();

    h.session[field] = false;
    await assert.rejects(controller.submit('run', runInput()), /Библиотека 3D недоступна\./);
    assert.equal(h.events.length, 0);
    assert.equal(h.uuids, 0);
    assert.equal(h.posts.length, 0);
  }
});

test('PC-11: переданный key сохраняется как UUID записи и запроса', async () => {
  const { h, controller } = fixture();
  const key = '00000000-0000-4000-8000-000000000088';
  const saved = [];

  h.hooks.put = (record) => saved.push(structuredClone(record));
  await controller.submit('run', runInput(), key);
  assert.equal(saved[0].key, key);
  assert.equal(saved[0].request.idempotencyKey, key);
  assert.equal(h.posts[0].body.idempotencyKey, key);
  assert.equal(h.uuids, 0);
});

test('PC-12: сетевой повтор сохраняет at первого нажатия', async () => {
  const { h, controller } = fixture();

  h.hooks.run = () => {
    throw new TypeError('Нет связи.');
  };
  await assert.rejects(controller.submit('run', runInput()));
  h.now += 12_000;
  await assert.rejects(controller.submit('run', runInput()));
  assert.equal([...h.saved.values()][0].at, 1_000_000);
  assert.equal(h.posts[0].body.idempotencyKey, h.posts[1].body.idempotencyKey);
  assert.equal(h.uuids, 1);
});

test('PC-13: занятый key другого fingerprint не отправляет изменённое содержимое', async () => {
  const { h, controller } = fixture();
  const record = savedRecord();

  h.saved.set(record.key, record);
  h.pending.push(record);
  await assert.rejects(controller.submit('run', runInput(), record.key),
    /Снимок этого намерения уже другой\./);
  assert.equal(h.posts.length, 0);
  assert.equal(h.events.length, 0);
  assert.equal(h.saved.size, 1);
});

test('PC-14: idempotency_conflict блокирует старую запись, повтор получает новый UUID', async () => {
  const { h, controller } = fixture();
  const conflict = new Studio3dApiError(409, 'idempotency_conflict', { message: 'Снимок уже принят.' });

  h.hooks.run = () => {
    throw conflict;
  };
  await assert.rejects(controller.submit('run', runInput()), (cause) => cause === conflict);

  const first = h.pending[0].key;

  assert.equal(h.pending[0].blocked, 'Снимок уже принят.');
  assert.equal(h.saved.get(first).blocked, 'Снимок уже принят.');
  await assert.rejects(controller.submit('run', runInput()), (cause) => cause === conflict);
  assert.equal(h.posts.length, 2);
  assert.notEqual(h.posts[1].body.idempotencyKey, first);
  assert.equal(h.uuids, 2);
  assert.equal(h.saved.size, 2);
});

test('PC-15: отказ put пробрасывается без POST, onError и изменения busy', async () => {
  const { h, controller } = fixture();
  const failure = new Error('Запись запрещена.');

  h.hooks.put = () => {
    throw failure;
  };
  await assert.rejects(controller.submit('run', runInput()), (cause) => cause === failure);
  assert.equal(h.posts.length, 0);
  assert.equal(h.errors.length, 0);
  assert.equal(h.busy, 0);
  assert.equal(h.pending.length, 0);
  assert.equal(h.saved.size, 0);
  assert.deepEqual(h.events, ['put:start']);
});

test('PC-16: busy охватывает только POST после put и заканчивается в finally', async () => {
  const { h, controller } = fixture();

  h.hooks.run = () => {
    assert.equal(h.busy, 1);

    throw new TypeError('Нет связи.');
  };
  await assert.rejects(controller.submit('run', runInput()));
  assert.equal(h.busy, 0);
  assert.deepEqual(h.ends, [1]);
  assert.deepEqual(h.events, ['put:start', 'put:done', 'busy:begin', 'post', 'busy:end']);
  assert.equal(h.errors.length, 1);
});

test('PC-17: recovery снимает доказанный отказ, сохраняет сетевой и серверный исход', async () => {
  for (const [where, status, dropped, errors] of [
    ['get', 403, 1, 0],
    ['post', 409, 1, 0],
    ['get', 503, 0, 1],
    ['post', 503, 0, 1],
    ['get', 0, 0, 1],
    ['post', 0, 0, 1],
  ]) {
    const { h, controller } = fixture();
    const record = savedRecord();
    const failure = status ? new Studio3dApiError(status, 'fixture', { message: 'Доказанный отказ.' })
      : new TypeError('Нет связи.');

    h.saved.set(record.key, record);
    h.hooks.job = () => {
      throw where === 'get' ? failure : new Studio3dApiError(404, 'not_found', {});
    };
    h.hooks.run = () => {
      throw failure;
    };
    await controller.recoverPending();
    assert.equal(h.dropped.length, dropped);
    assert.equal(h.errors.length, errors);
    assert.equal(h.saved.size, dropped ? 0 : 1);

    if (dropped) {
      assert.equal(h.dropped[0].text, 'Заказ «Куб» не отправлен: Доказанный отказ.');
    }
  }
});

test('PC-19: смена сессии во время put оставляет durable запись без POST', async () => {
  const { h, controller } = fixture();

  h.hooks.put = () => {
    h.session.generation = 2;
    h.session.owner = 'other';
    h.session.started = false;
  };
  await assert.rejects(controller.submit('run', runInput()),
    /Сессия изменилась\. Намерение сохранено без отправки\./);
  assert.equal(h.saved.size, 1);
  assert.equal(h.pending.length, 0);
  assert.equal(h.posts.length, 0);
  assert.equal(h.errors.length, 0);
  assert.equal(h.busy, 0);
});

test('PC-20: ответ другой библиотеки снимает запись без onSent', async () => {
  const { h, controller } = fixture();

  h.hooks.run = () => ({ libraryId: 'other' });
  await controller.submit('run', runInput());
  assert.equal(h.saved.size, 0);
  assert.equal(h.pending.length, 0);
  assert.equal(h.sent.length, 0);
  assert.equal(h.busy, 0);
});

test('PC-18: каждый kind сохраняет явный канонический отпечаток без UUID', async () => {
  const cases = [
    ['run', runInput(),
      '{"kind":"run","owner":"fixture-owner","request":{"expectedPrice":20,"libraryId":'
      + '"00000000-0000-4000-8000-000000000099","name":"Куб","operation":"text-to-model",'
      + '"provider":"tripo","values":{"prompt":"Куб"}}}'],
    ['retry', { expectedPrice: 20 },
      '{"kind":"retry","modelId":"fixture-model","owner":"fixture-owner","request":{"ex'
      + 'pectedPrice":20,"libraryId":"00000000-0000-4000-8000-000000000099"},"versionId":'
      + '"v01-model"}'],
    ['batch', batchInput(),
      '{"kind":"batch","owner":"fixture-owner","request":{"libraryId":"00000000-0000-40'
      + '00-8000-000000000099","snapshot":{"catalogVersion":"fixture","libraryId":"000000'
      + '00-0000-4000-8000-000000000099","rows":[{"category":null,"expectedPrice":20,"nam'
      + 'e":"Куб","operation":"text-to-model","project":null,"provider":"tripo","values":'
      + '{"prompt":"Куб"}}],"totalEstimated":20,"unit":{"few":"кредита","many":"кредитов"'
      + ',"one":"кредит"}},"snapshotHash":"fixture-hash"}}'],
  ];

  for (const [kind, input, expected] of cases) {
    const { h, controller } = fixture();

    h.hooks[kind] = () => {
      throw new TypeError('Нет связи.');
    };
    await assert.rejects(controller.submit(kind, input, undefined,
      kind === 'retry' ? 'fixture-model' : undefined, kind === 'retry' ? 'v01-model' : undefined));
    assert.equal([...h.saved.values()][0].fingerprint, expected);
  }
});
