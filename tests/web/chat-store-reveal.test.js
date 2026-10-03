import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chatStoreFixture
} from './helpers/chat-store.js';

async function fixture() {
  return chatStoreFixture({
    sessions: ['c1', 'c2'].map((id) => ({

      id,

      title: id,

      messages: [],

      steps: [],

      createdAt: 100,

      updatedAt: 200,

    }))
  });
}

test('C1/C2: reveal выбирает существующий чат и просит показать его', async () => {
  const chat = await fixture();

  assert.equal(await chat.revealChat('c2'), true);
  assert.equal(chat.activeId, 'c2');
  assert.equal(chat.revealRequest, 'c2');
});

test('C2: неизвестный id сохраняет выбор и запрос показа', async () => {
  const chat = await fixture();

  await chat.revealChat('c2');
  assert.equal(await chat.revealChat('missing'), false);
  assert.equal(chat.activeId, 'c2');
  assert.equal(chat.revealRequest, 'c2');
});

test('C2: consumeReveal поглощает запрос показа', async () => {
  const chat = await fixture();

  await chat.revealChat('c2');
  chat.consumeReveal();
  assert.equal(chat.revealRequest, '');
});
