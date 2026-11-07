import assert from 'node:assert/strict';
import test from 'node:test';

import {
  apiHarness,
  chatStoreFixture,
  sseOf,
} from './helpers/chat-store.js';

test('structured question отправляет явный action и typed answers', async () => {
  const posts = [];
  const chat = await chatStoreFixture();
  apiHarness.post = async (path, body) => {
    posts.push({ path, body });
    return { ok: true };
  };
  chat.pending['form-1'] = {
    pid: 'form-1',
    kind: 'question',
    structured: true,
    chatKey: 'chat-a',
    questions: [],
  };

  await chat.answerQuestion('form-1', {
    action: 'accept',
    answers: [
      { key: 'count', value: 3 },
      { key: 'enabled', value: false },
    ],
  });

  assert.deepEqual(posts, [{
    path: '/api/chat/permission/form-1',
    body: {
      action: 'accept',
      answers: [
        { key: 'count', value: 3 },
        { key: 'enabled', value: false },
      ],
    },
  }]);
  assert.equal(chat.pending['form-1'], undefined);
});

test('legacy question сохраняет прежний payload без action', async () => {
  const posts = [];
  const chat = await chatStoreFixture();
  apiHarness.post = async (path, body) => {
    posts.push({ path, body });
    return { ok: true };
  };
  chat.pending['legacy-1'] = {
    pid: 'legacy-1',
    kind: 'question',
    chatKey: 'chat-a',
  };
  const answers = [{ header: 'Путь', selected: ['Первый'], text: '' }];

  await chat.answerQuestion('legacy-1', answers);

  assert.deepEqual(posts, [{
    path: '/api/chat/permission/legacy-1',
    body: { answers },
  }]);
});

test('external URL нельзя автоподтвердить или добавить в remember-policy', async () => {
  const posts = [];
  const chat = await chatStoreFixture();
  apiHarness.post = async (path, body) => {
    posts.push({ path, body });
    return { ok: true };
  };
  chat.pending['ordinary-1'] = {
    pid: 'ordinary-1',
    kind: 'perm',
    chatKey: 'chat-a',
    tool: 'MCP · installer',
    input: { kind: 'execute' },
  };
  await chat.answerPerm('ordinary-1', true, true);
  posts.length = 0;

  const receive = sseOf(chat);
  receive('chat-permission', {
    pid: 'url-1',
    chatKey: 'chat-a',
    tool: 'MCP · installer',
    canRemember: false,
    input: {
      kind: 'external_url',
      url: 'https://example.test/install',
    },
  });

  assert.equal(chat.pending['url-1']?.pid, 'url-1');
  assert.deepEqual(posts, [], 'remember-policy другого запроса не подтверждает URL');

  await chat.answerPerm('url-1', true, true);
  assert.deepEqual(posts, [{
    path: '/api/chat/permission/url-1',
    body: { allow: true },
  }]);
});
