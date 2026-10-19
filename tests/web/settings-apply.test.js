import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';

import { ApiError } from '../../web/src/shared/apiClient.ts';
import { classifyWriteError } from '../../web/src/features/settings/contracts.ts';
import { createSettingsSession } from '../../web/src/features/settings/session.ts';
import { settingsResource, settingsSession } from './helpers/settings-session.js';

/**
 * Часы исполняют только назначенные callbacks при явном продвижении тестом.
 * Проверка сторожевого срока не держит процесс реальными двадцатью секундами.
 */
function controlledClock() {
  const timers = new Map();
  let currentTime = 0;
  let sequence = 0;

  return {
    timers,
    setTimeout(callback, delay) {
      sequence += 1;
      timers.set(sequence, { callback, at: currentTime + delay });

      return sequence;
    },
    clearTimeout: (id) => timers.delete(id),
    /**
     * Выполняются все сроки, наступившие к новой отметке времени.
     * Снятый callback удаляется до вызова и не срабатывает повторно.
     */
    advance(ms) {
      currentTime += ms;

      for (const [id, timer] of timers) {
        if (timer.at <= currentTime) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
  };
}

test('AP01: чистый Apply не пишет, чистый OK разрешает закрытие', async () => {
  const resource = settingsResource('prefs', { value: 0 });
  const session = await settingsSession(resource);
  const applied = await session.apply();
  const accepted = await session.apply('ok');

  assert.equal(applied.status, 'success');
  assert.equal(applied.shouldClose, false);
  assert.equal(accepted.shouldClose, true);
  assert.equal(resource.calls.writes.length, 0);
});

test('AP02: все валидаторы до первой записи, порядок ресурсов не зависит от посещения', async () => {
  const events = [];
  let invalid = true;
  const resources = ['c', 'b', 'a'].map((id) => settingsResource(id, { value: 0 }, {
    order: id.charCodeAt(0),
    validate() {
      events.push(`validate:${id}`);

      return id === 'c' && invalid ? [{ key: 'value', message: 'Введите число' }] : [];
    },
    async write(intents) {
      events.push(`write:${id}`);

      return {
        status: 'success',
        fields: [{
          key: 'value',
          status: 'success',
          serverValue: intents.get('value').value,
        }],
      };
    },
  }));
  const session = await settingsSession(...resources);

  for (const resource of resources) {
    session.setField(resource.adapter.id, 'value', 1);
  }

  const rejected = await session.apply('ok');

  assert.equal(rejected.status, 'failed');
  assert.equal(rejected.validation[0]?.address.fieldPath[0], 'value');
  assert.deepEqual(events, ['validate:a', 'validate:b', 'validate:c']);

  invalid = false;
  events.length = 0;

  assert.equal((await session.apply()).status, 'success');
  assert.deepEqual(events, [
    'validate:a', 'validate:b', 'validate:c', 'write:a', 'write:b', 'write:c',
  ]);
});

test('AP03: повторные Apply/OK не дублируют запись, очередь последовательна, ввод заблокирован',
  async () => {
    const deferred = Promise.withResolvers();
    const first = settingsResource('a', { value: 0 }, { write: () => deferred.promise });
    const second = settingsResource('b', { value: 0 }, { order: 1 });
    const session = await settingsSession(first, second);

    session.setField('a', 'value', 1);
    session.setField('b', 'value', 1);

    const pending = session.apply();

    await nextTurn();

    const repeated = session.apply('ok');

    assert.equal(first.calls.writes.length, 1);
    assert.equal(second.calls.writes.length, 0);
    assert.equal(session.getSnapshot().canClose, false);
    assert.throws(() => session.setField('a', 'value', 2), /сохраня/i);
    assert.throws(() => session.discard(), /сохраня/i);
    assert.equal(session.stopWaiting(), false);

    deferred.resolve({
      status: 'success',
      fields: [{
        key: 'value',
        status: 'success',
        serverValue: 1,
      }],
    });

    assert.equal((await pending).status, 'success');
    assert.equal((await repeated).shouldClose, false);
    assert.equal(first.calls.writes.length, 1);
    assert.equal(second.calls.writes.length, 1);
    assert.equal(session.getSnapshot().canClose, true);
  });

test('AP04: подтверждённое нормализованное значение становится baseline и видимым значением', async () => {
  const resource = settingsResource('prefs', { value: 0 }, {
    write: async () => ({
      status: 'success',
      fields: [{
        key: 'value',
        status: 'success',
        serverValue: 10,
      }],
    }),
  });
  const session = await settingsSession(resource);

  session.setField('prefs', 'value', 11);

  const result = await session.apply();

  assert.equal(result.status, 'success');
  assert.equal(result.saved[0]?.normalized, true);
  assert.equal(result.saved[0]?.serverValue, 10);
  assert.equal(session.getValue('prefs', 'value'), 10);
  assert.equal(session.getBaseline('prefs').value, 10);
  assert.equal(session.getSnapshot().dirtyCount, 0);

  session.setField('prefs', 'value', 12);
  session.discard();

  assert.equal(session.getValue('prefs', 'value'), 10);
});

test('AP05: отказ цепочки оставляет B/C dirty, D сохраняется, повтор не трогает A/D', async () => {
  let fail = true;
  const a = settingsResource('a', { value: 0 });
  const b = settingsResource('b', { value: 0 }, {
    order: 1,
    chain: 'provider:future',
    async write() {
      return fail ? {
        status: 'failed',
        fields: [{
          key: 'value',
          status: 'failed',
          message: 'Отказ сервера',
        }],
      } : {
        status: 'success',
        fields: [{
          key: 'value',
          status: 'success',
          serverValue: 1,
        }],
      };
    },
  });
  const c = settingsResource('c', { value: 0 }, { order: 2, chain: 'provider:future' });
  const d = settingsResource('d', { value: 0 }, { order: 3 });
  const session = await settingsSession(d, c, b, a);

  for (const id of ['a', 'b', 'c', 'd']) {
    session.setField(id, 'value', 1);
  }

  const result = await session.apply('ok');

  assert.equal(result.status, 'partial');
  assert.equal(result.shouldClose, false);
  assert.deepEqual(result.saved.map((field) => field.resourceId), ['a', 'd']);
  assert.deepEqual(result.remaining.map((field) => field.resourceId), ['b', 'c']);
  assert.equal(result.errors[0]?.resourceId, 'b');
  assert.equal(c.calls.writes.length, 0);

  fail = false;

  assert.equal((await session.apply()).status, 'success');
  assert.equal(a.calls.writes.length, 1);
  assert.equal(b.calls.writes.length, 2);
  assert.equal(c.calls.writes.length, 1);
  assert.equal(d.calls.writes.length, 1);
});

test('AP06: единая классификация HTTP, обрыва, abort, разбора и явного отказа store', () => {
  assert.equal(classifyWriteError(new ApiError('Конфликт', 409, null)).outcome, 'conflict');

  for (const status of [400, 401, 403, 404, 500, 503]) {
    const result = classifyWriteError(new ApiError('Отказ сервера', status, null));

    assert.equal(result.outcome, 'failed');
    assert.equal(result.status, status);
  }

  for (const error of [new TypeError('Сеть'), new DOMException('Прервано', 'AbortError'),
    new SyntaxError('Неверный JSON'), { ok: true }]) {
    assert.equal(classifyWriteError(error).outcome, 'unknown');
  }

  assert.equal(classifyWriteError({
    ok: false,
    status: 503,
    message: 'Отказ',
  }).outcome, 'failed');
});

test('AP07: per-field подтверждает первую запись и повторяет только вторую', async () => {
  const resource = settingsResource('native', { first: 0, second: 0 }, {
    body: 'per-field',
    write: async () => ({
      status: 'failed',
      fields: [
        {
          key: 'first',
          status: 'success',
          serverValue: 1,
        },
        {
          key: 'second',
          status: 'failed',
          message: 'Отказ',
        },
      ],
    }),
  });
  const session = await settingsSession(resource);

  session.setField('native', 'first', 1);
  session.setField('native', 'second', 1);

  const result = await session.apply();

  assert.equal(result.status, 'partial');
  assert.equal(session.getIntent('native', 'first'), undefined);
  assert.equal(session.getBaseline('native').first, 1);

  resource.adapter.write = async (intents) => {
    assert.deepEqual([...intents.keys()], ['second']);

    return {
      status: 'success',
      fields: [{
        key: 'second',
        status: 'success',
        serverValue: 1,
      }],
    };
  };

  assert.equal((await session.apply()).status, 'success');
});

test('AP07: поле отсутствует в ответе одного запроса и остаётся dirty с ошибкой', async () => {
  const resource = settingsResource('prefs', { first: 0, second: 0 }, {
    write: async () => ({
      status: 'success',
      fields: [{
        key: 'first',
        status: 'success',
        serverValue: 1,
      }],
    }),
  });
  const session = await settingsSession(resource);

  session.setField('prefs', 'first', 1);
  session.setField('prefs', 'second', 1);

  assert.equal((await session.apply()).status, 'partial');
  assert.equal(session.getIntent('prefs', 'first'), undefined);
  assert.equal(session.getSnapshot().resources[0]?.fields[1]?.error, 'Сервер не принял значение');
  assert.equal(session.getSnapshot().dirtyCount, 1);
});

test('AP08: Apply остаётся открытым, OK закрывается только при полном успехе', async () => {
  const session = await settingsSession(settingsResource('prefs', { value: 0 }));

  session.setField('prefs', 'value', 1);

  assert.equal((await session.apply()).shouldClose, false);
  assert.equal(session.getSnapshot().active, true);

  session.setField('prefs', 'value', 2);

  assert.equal((await session.apply('ok')).shouldClose, true);
});

test('AP09: dispose останавливает очередь и поздний эффект сессии, доменный ACK сохраняется', async () => {
  for (const reason of ['auth-lost', 'owner-closed']) {
    const deferred = Promise.withResolvers();
    let domainValue = 0;
    const first = settingsResource('a', { value: 0 }, {
      async write() {
        const response = await deferred.promise;

        domainValue = 1;

        return response;
      },
    });
    const second = settingsResource('b', { value: 0 }, { order: 1 });
    const session = await settingsSession(first, second);

    session.setField('a', 'value', 1);
    session.setField('b', 'value', 1);

    const pending = session.apply('ok');

    await nextTurn();

    assert.equal(first.calls.writes.length, 1);

    session.dispose(reason);
    deferred.resolve({
      status: 'success',
      fields: [{
        key: 'value',
        status: 'success',
        serverValue: 1,
      }],
    });
    await pending;
    await nextTurn();

    assert.equal(domainValue, 1);
    assert.equal(second.calls.writes.length, 0);
    assert.equal(session.getSnapshot().active, false);
    assert.equal(session.getSnapshot().resources.length, 0);
    assert.equal(session.getSnapshot().applying, false);
  }
});

test('AP09: HTTP 401 останавливает также независимую цепочку', async () => {
  const first = settingsResource('a', { value: 0 }, {
    async write() {
      throw new ApiError('Нужен вход', 401, null);
    },
  });
  const second = settingsResource('b', { value: 0 }, { order: 1 });
  const session = await settingsSession(first, second);

  session.setField('a', 'value', 1);
  session.setField('b', 'value', 1);

  const result = await session.apply();

  assert.equal(result.status, 'failed');
  assert.equal(result.errors[0]?.httpStatus, 401);
  assert.equal(second.calls.writes.length, 0);
});

test('AP10: неизвестный исход останавливает всё и перечитывает без автоматической записи', async () => {
  for (const failure of ['network', 'malformed']) {
    const first = settingsResource('a', { value: 0 }, {
      async write() {
        if (failure === 'network') {
          throw new TypeError('Обрыв связи');
        }

        return { ok: true };
      },
    });
    const second = settingsResource('b', { value: 0 }, { order: 1 });
    const session = await settingsSession(first, second);

    session.setField('a', 'value', 1);
    session.setField('b', 'value', 1);

    const result = await session.apply();

    await nextTurn();

    assert.equal(result.status, 'unknown');
    assert.equal(result.shouldClose, false);
    assert.equal(result.remaining.length, 2);
    assert.equal(first.calls.reads.length, 2);
    assert.equal(first.calls.writes.length, 1);
    assert.equal(second.calls.writes.length, 0);
    assert.equal(session.getSnapshot().dirtyCount, 2);
  }
});

test('AP11: 20 секунд показывают задержку, прекращение ожидания даёт unknown и гасит поздний ACK',
  async () => {
    const clock = controlledClock();
    const deferred = Promise.withResolvers();
    const resource = settingsResource('prefs', { value: 0 }, { write: () => deferred.promise });
    const session = createSettingsSession({ clock });

    session.begin();
    session.register(resource.adapter, resource.fields);
    await session.load('prefs');
    session.setField('prefs', 'value', 1);

    const pending = session.apply('ok');

    await nextTurn();
    clock.advance(19_999);

    assert.equal(session.getSnapshot().applying, true);
    assert.equal(session.getSnapshot().delayed, false);

    clock.advance(1);

    assert.equal(session.getSnapshot().delayed, true);
    assert.equal(session.getSnapshot().statusMessage, 'Ответ задерживается');
    assert.equal(session.stopWaiting(), true);

    const result = await pending;

    assert.equal(result.status, 'unknown');
    assert.equal(result.shouldClose, false);
    assert.equal(session.getSnapshot().canClose, true);
    assert.equal(resource.calls.writes[0]?.signal.aborted, true);

    deferred.resolve({
      status: 'success',
      fields: [{
        key: 'value',
        status: 'success',
        serverValue: 99,
      }],
    });
    await nextTurn();

    assert.equal(session.getBaseline('prefs').value, 0);
    assert.equal(session.getValue('prefs', 'value'), 1);
    assert.equal(clock.timers.size, 0);
  });

test('AP04: успешная запись секрета очищает ввод без значения в baseline и отчёте', async () => {
  const resource = settingsResource('credentials', {}, {
    fields: [{
      key: 'token',
      secret: true,
      address: { pageId: 'agents.providers', fieldPath: ['token'] },
    }],
    write: async () => ({
      status: 'success',
      fields: [{ key: 'token', status: 'success' }],
    }),
  });
  const session = await settingsSession(resource);

  session.setField('credentials', 'token', 'synthetic-apply-private-marker');

  const result = await session.apply();

  assert.equal(result.status, 'success');
  assert.equal(session.getIntent('credentials', 'token'), undefined);
  assert.deepEqual(session.getBaseline('credentials'), {});
  assert.equal(JSON.stringify(result).includes('synthetic-apply-private-marker'), false);
});

test('AP07: пропущенное первое поле не мешает подтвердить второе из того же ответа', async () => {
  const resource = settingsResource('prefs', { first: 0, second: 0 }, {
    write: async () => ({
      status: 'success',
      fields: [{
        key: 'second',
        status: 'success',
        serverValue: 1,
      }],
    }),
  });
  const session = await settingsSession(resource);

  session.setField('prefs', 'first', 1);
  session.setField('prefs', 'second', 1);

  const result = await session.apply();

  assert.equal(result.status, 'partial');
  assert.deepEqual(result.saved.map((field) => field.key), ['second']);
  assert.equal(session.getIntent('prefs', 'second'), undefined);
  assert.equal(session.getSnapshot().resources[0]?.fields[0]?.error, 'Сервер не принял значение');
});

test('AP09: прежний Apply даже в фазе проверки не меняет новое открытие', async () => {
  const old = settingsResource('prefs', { value: 0 });
  const session = await settingsSession(old);

  session.setField('prefs', 'value', 1);

  const previous = session.apply();
  const fresh = settingsResource('prefs', { value: 2 }, {
    validate: () => [{ key: 'value', message: 'Ошибка новой формы' }],
  });

  session.begin();
  session.register(fresh.adapter, fresh.fields);
  session.acceptSnapshot('prefs', { value: 2 });
  session.setField('prefs', 'value', 3);

  await previous;

  assert.equal(session.getSnapshot().resources[0]?.fields[0]?.error, undefined);
  assert.equal(session.getValue('prefs', 'value'), 3);
  assert.equal(old.calls.writes.length, 0);
  assert.equal(fresh.calls.writes.length, 0);
});

test('AP02: ошибка адаптера без известного ключа всё равно блокирует запись', async () => {
  const resource = settingsResource('prefs', { value: 0 }, {
    validate: () => [{ key: 'removed', message: 'Каталог полей изменился' }],
  });
  const session = await settingsSession(resource);

  session.setField('prefs', 'value', 1);

  const result = await session.apply();

  assert.equal(result.status, 'failed');
  assert.equal(result.validation[0]?.address.fieldPath[0], 'value');
  assert.equal(resource.calls.writes.length, 0);
});

test('AP06: 409 блокирует свою цепочку; явный HTTP-отказ store остаётся известным', async () => {
  const first = settingsResource('a', { value: 0 }, {
    chain: 'provider:future',
    async write() {
      throw new ApiError('Изменено в другой вкладке', 409, null);
    },
  });
  const second = settingsResource('b', { value: 0 }, { order: 1, chain: 'provider:future' });
  const other = settingsResource('c', { value: 0 }, { order: 2 });
  const session = await settingsSession(first, second, other);

  for (const id of ['a', 'b', 'c']) {
    session.setField(id, 'value', 1);
  }

  assert.equal((await session.apply()).status, 'partial');
  assert.equal(second.calls.writes.length, 0);
  assert.equal(other.calls.writes.length, 1);
  assert.equal((await session.apply()).status, 'conflict');

  first.adapter.write = async () => ({
    ok: false,
    status: 503,
    message: 'Отклонено',
  });

  const refused = await session.apply();

  assert.equal(refused.status, 'failed');
  assert.equal(refused.errors[0]?.httpStatus, 503);
});

test('AP10: повреждённое подтверждение не очищает dirty и не отправляет остаток', async () => {
  const malformedResponses = [
    { status: 'success', fields: 'вместо массива' },
    { status: 'success', fields: [{
      key: 'value',
      status: 'success',
      serverValue: undefined,
    }] },
    { status: 'success', fields: [{
      key: 'other',
      status: 'success',
      serverValue: 1,
    }] },
    {
      status: 'success',
      fields: [
        {
          key: 'value',
          status: 'success',
          serverValue: 1,
        },
        {
          key: 'value',
          status: 'success',
          serverValue: 2,
        },
      ],
    },
  ];

  for (const response of malformedResponses) {
    const first = settingsResource('a', { value: 0 }, { write: async () => response });
    const second = settingsResource('b', { value: 0 }, { order: 1 });
    const session = await settingsSession(first, second);

    session.setField('a', 'value', 1);
    session.setField('b', 'value', 1);

    assert.equal((await session.apply()).status, 'unknown');
    assert.equal(session.getSnapshot().dirtyCount, 2);
    assert.equal(second.calls.writes.length, 0);
  }
});

test('AP04: сообщение валидатора и отказ API не выносят секрет в публичный state', async () => {
  let invalid = true;
  const marker = 'synthetic-error-private-marker';
  const resource = settingsResource('credentials', {}, {
    fields: [{
      key: 'token',
      secret: true,
      address: { pageId: 'agents.providers', fieldPath: ['token'] },
    }],
    validate: () => invalid ? [{ key: 'token', message: `Неверный ключ ${marker}` }] : [],
    async write() {
      throw new ApiError(`Ключ ${marker} отклонён`, 400, null);
    },
  });
  const session = await settingsSession(resource);

  session.setField('credentials', 'token', marker);

  const rejected = await session.apply();

  assert.equal(JSON.stringify(rejected).includes(marker), false);
  assert.equal(JSON.stringify(session.getSnapshot()).includes(marker), false);

  invalid = false;

  const failed = await session.apply();

  assert.equal(failed.status, 'failed');
  assert.equal(JSON.stringify(failed).includes(marker), false);
  assert.equal(JSON.stringify(session.getSnapshot()).includes(marker), false);
  assert.equal(session.getValue('credentials', 'token'), marker);
});

for (const mode of ['apply', 'ok']) {
  test(`W2: исключение валидатора становится ошибкой первого dirty-поля — ${mode}`, async () => {
    const resource = settingsResource('provider', { untouched: 0, changed: 0 }, {
      validate() {
        throw new Error('Исполнитель больше недоступен');
      },
    });
    const session = await settingsSession(resource);

    session.setField('provider', 'changed', 1);

    const result = await session.apply(mode);

    assert.equal(result.status, 'failed');
    assert.equal(result.shouldClose, false);
    assert.equal(result.validation[0]?.key, 'changed');
    assert.deepEqual(result.validation[0]?.address.fieldPath, ['changed']);
    assert.match(result.validation[0]?.message ?? '', /Исполнитель больше недоступен/);
    assert.equal(resource.calls.writes.length, 0);
    assert.equal(session.getSnapshot().applying, false);
    assert.equal(session.getSnapshot().dirtyCount, 1);
  });
}
