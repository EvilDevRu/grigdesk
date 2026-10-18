import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createDesktopLink } from '../../mobile/src/link/desktopLink.ts';
import { ApiClient, messageIntent } from '../../mobile/src/api/client.ts';
import { ChatOutbox } from '../../mobile/src/api/outbox.ts';

/**
 * Тестовый порт сохраняет транспорт мобильного клиента без снятого desktop IPC.
 * Обёртки outbox снимаются здесь, а ответ request задаётся самой фикстурой.
 */
function portLink(port) {
  return createDesktopLink({
    invoke: async (method, input) => {
      if (method === 'putOutbox') {
        return port.putOutbox(input.item);
      }

      if (method === 'removeOutbox') {
        return port.removeOutbox(input.idempotencyKey);
      }

      return port[method](input);
    },
    onEvent: () => () => {
    },
  });
}

test('DC-28/29/30: методы, media и недоступные возможности соблюдают контракт моста', async () => {
  const calls = [];
  let media = { file: 'a'.repeat(64), generation: 7 };
  const link = createDesktopLink({
    invoke: async (...args) => {
      calls.push(args);

      return args[0] === 'fetchMedia' ? media : null;
    },
    onEvent: () => () => {},
  });

  for (const [method, input] of [
    ['getState'], ['addFromText', { text: 'код' }], ['selectRelay', { id: 'relay' }],
    ['removeRelay', { id: 'relay' }], ['unlock'], ['request', { method: 'GET', path: '/path' }],
    ['getOutbox'], ['putOutbox', { item: {} }], ['removeOutbox', { idempotencyKey: 'key' }],
    ['startEvents'], ['stopEvents'], ['fetchMedia', { chatId: 'chat', ref: 'u:test.png' }], ['resetDevice'],
  ]) {
    await link[method](input);
    assert.deepEqual(calls.at(-1), input === undefined ? [method] : [method, input]);
  }

  assert.deepEqual(await link.fetchMedia({}), { path: 'grigdesk-media://media/7/' + 'a'.repeat(64) });
  media = { error: 'locked' };
  assert.deepEqual(await link.fetchMedia({}), media);

  for (const bad of [{}, { file: '../x', generation: 7 }, { file: 'a'.repeat(64), generation: -1 }]) {
    media = bad;
    assert.deepEqual(await link.fetchMedia({}), { error: 'network' });
  }

  const count = calls.length;

  await assert.rejects(link.scanQr(), /Камеры нет/);
  await assert.rejects(link.downloadUpdate(), /ставится установщиком/);
  assert.equal(calls.length, count);
});

test('DC-31: одна подписка моста раздаёт события до последней отписки', async () => {
  let deliver;
  let subscriptions = 0;
  let removals = 0;
  const link = createDesktopLink({
    invoke: async () => null,
    onEvent(callback) {
      subscriptions += 1;
      deliver = callback;

      return () => {
        removals += 1;
      };
    },
  });
  const events = [];
  const states = [];
  const first = await link.addListener('linkEvent', (value) => events.push(value));
  const second = await link.addListener('linkState', (value) => states.push(value));

  deliver('linkEvent', 'event');
  deliver('linkState', 'state');
  deliver('other', 'секрет');
  assert.deepEqual(events, ['event']);
  assert.deepEqual(states, ['state']);
  assert.equal(subscriptions, 1);
  await first.remove();
  assert.equal(removals, 0);
  await second.remove();
  await second.remove();
  assert.equal(removals, 1);

  const third = await link.addListener('linkState', () => {});

  assert.equal(subscriptions, 2);
  await third.remove();
});

test('DC-32: отсутствие моста даёт понятную ошибку для каждого метода', async () => {
  const link = createDesktopLink(undefined);

  for (const method of ['getState', 'scanQr', 'downloadUpdate', 'fetchMedia', 'unlock', 'resetDevice']) {
    await assert.rejects(link[method]({}), /Мост приложения недоступен/);
  }

  await assert.rejects(link.addListener('linkState', () => {}), /Мост приложения недоступен/);
});

test('DC-32a/34b: ApiClient сохраняет intent, различает ошибки и запрещает minApp', async () => {
  const sample = new URL('../fixtures/mobile-contract/v1/accepted.json', import.meta.url);
  const accepted = await readFile(sample, 'utf8');

  for (const error of [null, 'contract', 'network', 'pin_mismatch']) {
    const posts = [];
    const outbox = [];
    const fatal = [];
    const port = {
      getState: () => ({ unlocked: true, generation: 7 }),
      putOutbox: async (item) => outbox.push(item),
      removeOutbox: async () => outbox.splice(0),
      request: async (input) => {
        posts.push(input);

        if (error && posts.length === 1) {
          return {
            status: 0,
            body: JSON.stringify({ error }),
            generation: 7,
          };
        }

        return {
          status: 202,
          body: accepted,
          generation: 7,
        };
      },
    };
    const link = portLink(port);
    const api = new ApiClient(link, { sleep: async () => {}, fatal: (code) => fatal.push(code) });
    const operation = { ...messageIntent('chat', 'Из компьютера'), order: 2 };
    const send = () => api.call('accepted', 'POST', operation.path, undefined, operation);

    if (error === 'contract' || error === 'pin_mismatch') {
      await assert.rejects(send(), (failure) => failure.code === error);
      assert.deepEqual(fatal, [error]);
      assert.deepEqual(outbox, [operation]);
    } else {
      await send();
      assert.deepEqual(outbox, []);
    }

    assert.equal(posts.length, error === 'network' ? 2 : 1);

    for (const post of posts) {
      assert.deepEqual(post, operation);
    }

    const incompatible = new ApiClient(link, { canMutate: () => false });

    await assert.rejects(incompatible.call('accepted', 'POST', operation.path, undefined, operation),
      (failure) => failure.code === 'update_required');
    assert.equal(posts.length, error === 'network' ? 2 : 1);
  }
});

test('DC-32c: настоящий ChatOutbox отправляет сообщение через тестовый транспорт', async () => {
  const posts = [];
  const outbox = [];
  const sample = new URL('../fixtures/mobile-contract/v1/accepted.json', import.meta.url);
  const accepted = await readFile(sample, 'utf8');
  const port = {
    getState: () => ({ unlocked: true, generation: 7 }),
    putOutbox: async (item) => outbox.push(item),
    removeOutbox: async () => outbox.splice(0),
    request: async (input) => {
      posts.push(input);

      return {
        status: 202,
        body: accepted,
        generation: 7,
      };
    },
  };
  const link = portLink(port);
  const queue = new ChatOutbox(new ApiClient(link));

  await queue.enqueue('chat', 'Сообщение из общего интерфейса');
  await queue.flush('chat');
  assert.equal(posts.length, 1);
  assert.equal(JSON.parse(posts[0].body).text, 'Сообщение из общего интерфейса');
  assert.equal(Object.hasOwn(posts[0], 'state'), false);
  assert.equal(Object.hasOwn(posts[0], 'error'), false);
  assert.deepEqual(queue.items, []);
  assert.deepEqual(outbox, []);
});
