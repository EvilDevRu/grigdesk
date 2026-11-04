import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { ApiClient, ApiError, messageIntent } from '../../mobile/src/api/client.ts';
import { LinkEvents } from '../../mobile/src/api/events.ts';
import { createLatest } from '../../mobile/src/api/latest.ts';
import { ChatOutbox } from '../../mobile/src/api/outbox.ts';
import { MockLink } from '../../mobile/src/link/mockLink.ts';

const golden = async (name) =>
  JSON.parse(
    await readFile(new URL(`../fixtures/mobile-contract/v1/${name}.json`, import.meta.url), 'utf8'),
  );
const json = (body, status = 200) => ({
  status,
  body: JSON.stringify(body),
});
const immediate = () => new Promise((resolve) => setImmediate(resolve));

test('MA-06/07: клиент проверяет каждый GET DTO и повреждённый контракт', async () => {
  const routes = [
    ['hello', 'getHello', []],
    ['chats', 'getChats', []],
    ['chat', 'getChat', ['c1']],
    ['waiting', 'getWaiting', []],
    ['details', 'getWaitingDetails', ['p1']],
    ['tasks', 'getTasks', []],
    ['task', 'getTask', ['17']],
    ['plan', 'getPlan', ['17']],
    ['tracker-tasks', 'getTrackerTasks', []],
    ['tracker-task', 'getTrackerTask', ['17']],
    ['launch-options', 'getLaunchOptions', ['17']],
    ['app', 'getApp', []],
    ['deliveries', 'getDeliveries', ['c1', ['client']]],
    ['operations', 'getOperation', ['key']],
  ];

  for (const [kind, method, args] of routes) {
    const value = await golden(kind);
    const api = new ApiClient(new MockLink({ request: async () => json(value) }));

    assert.deepEqual(await api[method](...args), value);
  }

  await assert.rejects(
    new ApiClient(new MockLink({ request: async () => json({ api: 2 }) })).getHello(),
    (error) => error instanceof ApiError && error.code === 'contract',
  );
});

test('MA-08/34: четыре попытки с одним durable intent и задержками 1/2/4 с', async () => {
  const delays = [];
  const bridge = new MockLink({
    request: async () => {
      throw new Error('network');
    },
  });
  const api = new ApiClient(bridge, {
    sleep: async (milliseconds) => {
      delays.push(milliseconds);
    },
  });
  const intent = messageIntent('c1', 'Сообщение');

  await assert.rejects(api.sendMessage('c1', 'Сообщение', intent), { code: 'network' });
  assert.equal(bridge.calls.length, 4);
  assert.deepEqual(bridge.calls, Array(4).fill(intent));
  assert.deepEqual(delays, [1000, 2000, 4000]);
  assert.deepEqual((await bridge.getOutbox()).items, [intent]);
});

test('minApp запрещает новые POST и повтор очереди до совместимого обновления', async () => {
  let compatible = false;
  const bridge = new MockLink({
    request: async () => {
      compatible = false;

      throw new Error('network');
    },
  });
  const api = new ApiClient(bridge, {
    canMutate: () => compatible,
    sleep: async () => {},
  });
  const intent = messageIntent('c1', 'Сохранённое намерение');

  await assert.rejects(api.sendMessage('c1', 'Текст', intent), { code: 'update_required' });
  assert.equal(bridge.calls.length, 0);
  assert.equal((await bridge.getOutbox()).items.length, 0);
  compatible = true;
  await assert.rejects(api.sendMessage('c1', 'Текст', intent), { code: 'update_required' });
  assert.equal(bridge.calls.length, 1);
  assert.deepEqual((await bridge.getOutbox()).items, [intent]);
});

test('MA-32/33/36: locked, revoked и ответы старого generation не попадают в UI', async () => {
  const fatal = [];
  const bridge = new MockLink({
    request: async () => {
      bridge.lock();

      return json(await golden('hello'));
    },
  });
  const api = new ApiClient(bridge, {
    fatal: (code) => {
      fatal.push(code);
    },
  });

  await assert.rejects(api.getHello(), { code: 'locked' });
  assert.deepEqual(fatal, ['locked']);
  bridge.state.revoked = true;
  await assert.rejects(api.getHello(), { code: 'device_revoked' });
  assert.equal(fatal.at(-1), 'device_revoked');
});

test('MA-09/36: один owner событий, heartbeat и старое поколение без resync', async () => {
  const bridge = new MockLink();
  let starts = 0;
  const nativeStart = bridge.startEvents.bind(bridge);

  bridge.startEvents = async () => {
    starts += 1;
    await nativeStart();
  };

  const events = new LinkEvents(bridge, () => bridge.state.generation);
  const signals = [];
  const signal = (name) => {
    signals.push(name);
  };

  await Promise.all([events.listen(signal, () => {}), events.listen(signal, () => {})]);
  bridge.emit('heartbeat', { at: Date.now() });
  bridge.emit('ready', { api: 1 }, 0);
  assert.deepEqual(signals, ['ready']);
  assert.equal(starts, 1);
  await events.close();
});

test('MA-35: запоздалое чтение не заменяет актуальный ресурс', async () => {
  const latest = createLatest();
  let answer;
  let value;
  const old = latest.run(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
    (result) => {
      value = result;
    },
  );

  await latest.run(
    async () => 'новое',
    (result) => {
      value = result;
    },
  );
  answer('старое');
  await old;
  assert.equal(value, 'новое');
});

test('MA-37: pending удерживает второе; deliveries восстанавливает порядок после рестарта JS', async () => {
  let accepted = false;
  let firstClient;
  const posts = [];
  const bridge = new MockLink({
    request: async (input) => {
      if (input.method === 'POST') {
        posts.push(JSON.parse(input.body).text);

        if (posts.length === 1) {
          firstClient = JSON.parse(input.body).clientId;

          return json({ operationPending: true }, 202);
        }

        const body = JSON.parse(input.body);

        return json(
          {
            accepted: true,
            clientId: body.clientId,
            turnId: 'turn2',
            state: 'queued',
            duplicate: false,
          },
          202,
        );
      }
      if (input.path.includes('/deliveries')) {
        const id = new URL(input.path, 'https://example.invalid').searchParams.get('ids');
        const proven = accepted && id === firstClient;

        return json({
          deliveries: [
            {
              clientId: id,
              turnId: proven ? 'turn1' : null,
              state: proven ? 'done' : 'unknown',
              outcome: proven ? 'reply' : null,
            },
          ],
        });
      }

      return json({
        state: accepted ? 'not_found' : 'pending',
        result: null,
      });
    },
  });
  const api = new ApiClient(bridge, { sleep: async () => {} });
  const firstUi = new ChatOutbox(api);

  await firstUi.enqueue('c1', 'первое');
  await immediate();
  await firstUi.enqueue('c1', 'второе');
  await firstUi.flush('c1');
  assert.deepEqual(posts, ['первое']);
  assert.deepEqual(
    firstUi.items.map((item) => item.state),
    ['checking', 'previous'],
  );

  const durable = (await bridge.getOutbox()).items;

  firstUi.clear();
  accepted = true;

  const replacement = new ChatOutbox(api);

  await replacement.restore();
  assert.deepEqual(posts, ['первое', 'второе']);
  assert.equal(replacement.items.length, 0);
  assert.equal((await bridge.getOutbox()).items.length, 0);
  assert.equal(
    bridge.calls.filter((item) => item.method === 'POST')[1].idempotencyKey,
    durable[1].idempotencyKey,
  );
});

/**
 * Прокси Capacitor отвечает функцией на любое свойство, в том числе `then`.
 * Такой мост, отданный из Promise, принимался за thenable, и запуск висел на «Подготовке».
 */
test('Нативный мост не thenable: await getLink() на Android не зависает', async () => {
  const { nativeLink } = await import('../../mobile/src/link/nativeLink.ts');
  let timer;
  const settled = await Promise.race([
    Promise.resolve(nativeLink).then(() => 'resolved'),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve('hang'), 500);
    }),
  ]);

  clearTimeout(timer);
  assert.equal(typeof nativeLink.then, 'undefined');
  assert.equal(settled, 'resolved');
  assert.equal(typeof nativeLink.getState, 'function');
});

/**
 * Связь вернулась позже окна приёма: сервер не видел ключ и отвечает operation_expired.
 * Такое сообщение не принималось, поэтому оно «Не отправлено» и убирается человеком,
 * а не повторяет вечную проверку доставки, держа за собой остальную очередь чата.
 */
test('Сообщение после долгого обрыва не застревает в проверке доставки', async () => {
  let online = false;
  const posts = [];
  const bridge = new MockLink({
    request: async (input) => {
      if (!online) {
        throw new Error('network');
      }

      if (input.method === 'POST') {
        posts.push(JSON.parse(input.body).text);

        return json(
          {
            error: 'operation_expired',
            message: 'Время приёма этой команды истекло.',
          },
          409,
        );
      }

      if (input.path.includes('/deliveries')) {
        const id = new URL(input.path, 'https://example.invalid').searchParams.get('ids');

        return json({
          deliveries: [
            {
              clientId: id,
              turnId: null,
              state: 'unknown',
              outcome: null,
            },
          ],
        });
      }

      return json({
        state: 'not_found',
        result: null,
      });
    },
  });
  const outbox = new ChatOutbox(new ApiClient(bridge, { sleep: async () => {} }));

  await outbox.enqueue('c1', 'первое');
  await immediate();
  await outbox.enqueue('c1', 'второе');
  await outbox.flush('c1');
  online = true;
  await outbox.reconnect();
  assert.deepEqual(
    outbox.items.map((item) => item.state),
    ['failed', 'previous'],
  );
  assert.deepEqual(posts, ['первое']);
  await outbox.discard(outbox.items[0]);
  await immediate();
  assert.deepEqual(posts, ['первое', 'второе']);
  assert.deepEqual(
    outbox.items.map((item) => item.state),
    ['failed'],
  );
});
