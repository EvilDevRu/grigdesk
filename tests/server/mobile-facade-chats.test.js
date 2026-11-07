import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import test from 'node:test';

import { ActionTokens } from '../../server/src/lib/mobile/actionTokens.ts';
import { registerChatRoutes } from '../../server/src/lib/mobile/facade/chats.ts';
import { registerWaitingRoutes } from '../../server/src/lib/mobile/facade/waiting.ts';
import { mobileFacadeFixture, mutation } from './helpers/mobile-facade.js';

const fixture = async (name) =>
  JSON.parse(
    await fs.readFile(
      new URL(`../fixtures/mobile-contract/internal/${name}.json`, import.meta.url),
      'utf8',
    ),
  );

/**
 * Модель внутренних ответов повторяет B0, но эффекты и запросы фиксируются отдельно.
 * Проверка схемы ответа принадлежит продукту, тест не пересобирает golden из результата.
 */
async function setup(t) {
  const store = await fixture('chat-store');
  const active = await fixture('chat-active');
  const pending = await fixture('waiting');
  const calls = [];
  let status = 200;

  for (const [index, item] of pending.waiting.entries()) {
    item.version = `version-${index}`;
    item.acceptsComment = true;
  }
  for (const chat of store.sessions) {
    chat.revision = 7;
    chat.messages.forEach((message, index) => {
      message.mobileId = `message-${index}`;
    });
  }

  const deps = {
    tokens: new ActionTokens(),
    chat: {
      read: async (id) => store.sessions.find((chat) => chat.id === id) ?? null,
      heads: async () =>
        [...store.sessions, ...store.archived].map(({ messages: _messages, ...head }) => head),
    },
    callApi: async (method, path, body) => {
      calls.push({
        method,
        path,
        body,
      });

      const payload =
        path === '/api/chat/store'
          ? store
          : path === '/api/chat/active'
            ? active
            : path === '/api/chat/waiting'
              ? pending
              : {
                  ok: true,
                  commentDelivered: false,
                  textDelivered: false,
                };

      return {
        statusCode: status,
        body: payload,
      };
    },
  };
  const { app } = await mobileFacadeFixture(t, (mobile) => {
    registerChatRoutes(mobile, deps);
    registerWaitingRoutes(mobile, deps);
  });

  return {
    app,
    calls,
    store,
    active,
    pending,
    fail: (value) => {
      status = value;
    },
  };
}

test('MC-03/04/05: Компаньон, чтение, cursor, revision и CAS стопа', async (t) => {
  const { app, calls, store } = await setup(t);
  const list = (await app.inject('/api/mobile/v1/chats?limit=1')).json();

  assert.equal(list.chats.length, 1);
  assert.equal(list.hasMore, true);
  assert.deepEqual(calls.find((call) => call.path.endsWith('/ensure')).body, {
    purpose: 'companion',
    taskId: null,
    origin: 'mobile:d12345678',
  });
  assert.equal(
    calls.some((call) => call.path === '/api/chat/store'),
    false,
    'список не читает полную историю всех чатов',
  );

  const detail = (await app.inject('/api/mobile/v1/chats/chat-alpha')).json();

  assert.equal(detail.chat.revision, 7);
  assert.equal(detail.messages[0].id, 'message-0');
  assert.equal(detail.messages[1].parts[0].type, 'image');
  assert.deepEqual(detail.messages[1].media, [
    {
      ref: `w:${Buffer.from('screens/test.png').toString('base64url')}`,
      alt: 'Read: test.png',
      from: 'step',
    },
  ]);
  assert.equal((await app.inject('/api/mobile/v1/chats/missing')).statusCode, 404);
  assert.equal(
    (await app.inject('/api/mobile/v1/chats/chat-alpha?before=1&revision=6')).statusCode,
    409,
  );

  const older = (await app.inject('/api/mobile/v1/chats/chat-alpha?before=1&revision=7')).json();

  assert.equal(older.messages.length, 1);

  const running = (await app.inject('/api/mobile/v1/chats/chat-beta')).json();
  const stopped = await mutation(app, '/api/mobile/v1/chats/chat-beta/stop', {
    actionToken: running.chat.actions.stop,
  });

  assert.equal(stopped.statusCode, 200);
  assert.deepEqual(calls.at(-1).body, {
    chatKey: 'chat-beta',
    expected: {
      runId: 'run-beta',
      queued: ['turn-beta-002'],
    },
  });
  store.sessions[0].messages = Array.from({ length: 100 }, (_, index) => ({
    role: 'assistant',
    text: '字'.repeat(40000),
    mobileId: `large-${index}`,
  }));

  const large = await app.inject('/api/mobile/v1/chats/chat-alpha?limit=100');

  assert.equal(large.statusCode, 200);
  assert.ok(Buffer.byteLength(large.payload) <= 2 * 1024 * 1024);
  assert.equal(large.json().hasMore, true);
  assert.equal(large.json().messages[0].parts[0].truncated, true);
});

test('MC-06: legacy/typed ответы, ограничения, каналы, unsupported и полный план', async (t) => {
  const { app, calls, pending } = await setup(t);
  const items = (await app.inject('/api/mobile/v1/waiting')).json().items;
  const legacy = items.find((item) => item.pid === 'question-alpha');
  const response = await mutation(app, '/api/mobile/v1/waiting/question-alpha', {
    actionToken: legacy.actionToken,
    action: 'accept',
    answers: [
      {
        questionId: 'q0',
        optionIds: ['o1'],
        text: 'Пояснение',
      },
    ],
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().textDelivered, false);
  assert.deepEqual(calls.at(-1).body.answers, [
    {
      header: 'Вариант',
      question: 'Как продолжить?',
      selected: ['Второй'],
      text: 'Пояснение',
    },
  ]);

  const typed = items.find((item) => item.pid === 'typed-alpha');
  const before = calls.filter((call) => call.method === 'POST').length;
  const invalid = await mutation(
    app,
    '/api/mobile/v1/waiting/typed-alpha',
    {
      actionToken: typed.actionToken,
      action: 'accept',
      answers: [
        {
          questionId: 'count',
          value: 10,
        },
      ],
    },
    'invalid-typed-1',
  );

  assert.equal(invalid.statusCode, 400);
  assert.equal(calls.filter((call) => call.method === 'POST').length, before);

  const fresh = (await app.inject('/api/mobile/v1/waiting')).json().items;
  const valid = await mutation(
    app,
    '/api/mobile/v1/waiting/typed-alpha',
    {
      actionToken: fresh.find((item) => item.pid === 'typed-alpha').actionToken,
      action: 'accept',
      answers: [
        {
          questionId: 'count',
          text: '2',
        },
        {
          questionId: 'enabled',
          value: true,
        },
      ],
    },
    'valid-typed-1',
  );

  assert.equal(valid.statusCode, 200);
  assert.deepEqual(calls.at(-1).body.answers, [
    {
      key: 'count',
      value: 2,
    },
    {
      key: 'enabled',
      value: true,
    },
  ]);
  pending.waiting[0].input.plan = 'П'.repeat(70000);
  pending.waiting.push({
    pid: 'session-ssh',
    origin: 'ssh',
    version: 'one',
    tool: 'SSH',
  });

  const page = (await app.inject('/api/mobile/v1/waiting')).json().items;
  const plan = page.find((item) => item.pid === 'permission-alpha');

  assert.equal(plan.actionToken, null);
  assert.equal(page.find((item) => item.pid === 'session-ssh').kind, 'unsupported');

  const url = `/api/mobile/v1/waiting/permission-alpha/details?contentRevision=${plan.contentRevision}`;

  assert.equal((await app.inject(`${url}&offset=65536`)).statusCode, 409);

  const middle = (await app.inject(`${url}&offset=${plan.nextOffset}`)).json();
  const repeated = (await app.inject(`${url}&offset=${plan.nextOffset}`)).json();

  assert.equal(middle.text, repeated.text);
  await app.inject('/api/mobile/v1/waiting');

  const end = (await app.inject(`${url}&offset=${middle.nextOffset}`)).json();

  assert.equal(plan.details + middle.text + end.text, pending.waiting[0].input.plan);

  const allow = await mutation(
    app,
    '/api/mobile/v1/waiting/permission-alpha',
    {
      actionToken: end.readToken,
      decision: 'deny',
      comment: 'Отказ',
    },
    'permission-deny-1',
  );

  assert.equal(allow.statusCode, 200);
  assert.equal(allow.json().commentDelivered, false);
  assert.deepEqual(calls.at(-1).body, {
    expectedVersion: 'version-0',
    remember: false,
    allow: false,
    comment: 'Отказ',
  });
});

test('MC-03: существующий Компаньон не требует ensure на каждое чтение списка', async (t) => {
  const { app, calls, store } = await setup(t);

  store.sessions.push({
    id: 'chat-companion',
    title: 'Компаньон',
    purpose: 'companion',
    taskId: null,
    logicalIdentity: 'companion:global',
    messages: [],
    updatedAt: 1760000009000,
  });

  const list = (await app.inject('/api/mobile/v1/chats')).json();

  assert.equal(list.chats.some((chat) => chat.id === 'chat-companion'), true);
  assert.equal(calls.some((call) => call.path.endsWith('/ensure')), false);
  assert.equal(calls.some((call) => call.path === '/api/chat/store'), false);

  store.sessions.at(-1).archived = true;
  await app.inject('/api/mobile/v1/chats');
  assert.equal(calls.filter((call) => call.path.endsWith('/ensure')).length, 1);
});

test('MC-07: неизвестный upstream и отказ внутренней авторизации сохраняют правильные коды', async (t) => {
  const { app, fail } = await setup(t);

  fail(500);
  assert.equal((await app.inject('/api/mobile/v1/chats')).json().error, 'upstream_500');
  fail(401);

  const response = await app.inject('/api/mobile/v1/waiting');

  assert.equal(response.statusCode, 502);
  assert.equal(response.json().error, 'upstream_auth');
});

test('MC-06/38: новый version того же плана требует полного перечитывания', async (t) => {
  const { app, pending } = await setup(t);

  pending.waiting[0].input.plan = 'Я'.repeat(70000);

  const original = (await app.inject('/api/mobile/v1/waiting')).json().items[0];
  const first = `/api/mobile/v1/waiting/permission-alpha/details?contentRevision=${original.contentRevision}`;
  const middle = (await app.inject(`${first}&offset=${original.nextOffset}`)).json();

  pending.waiting[0].version = 'new-waiting-same-plan';
  assert.equal((await app.inject(`${first}&offset=${middle.nextOffset}`)).statusCode, 409);
});

test('MC-06: permission раскрывает все аргументы, неприсланная страница не считается прочитанной',
  async (t) => {
  const { app, pending } = await setup(t);
  const { createHash } = await import('node:crypto');

  pending.waiting[0].tool = 'DeployTool';
  pending.waiting[0].input = {
    plan: 'Описание',
    target: '/synthetic/resource',
    force: true,
  };
  pending.waiting[1] = {
    pid: 'second-permission',
    version: 'second',
    tool: 'ExitPlanMode',
    input: { plan: 'Я'.repeat(70000) },
  };

  const visible = (await app.inject('/api/mobile/v1/waiting?limit=1')).json();

  assert.equal(visible.items.length, 1);
  assert.ok(visible.items[0].details.includes('/synthetic/resource'));
  assert.ok(visible.items[0].details.includes('force'));

  const revision = createHash('sha256').update(pending.waiting[1].input.plan).digest('hex');

  assert.equal(
    (
      await app.inject(
        '/api/mobile/v1/waiting/second-permission/details' +
          `?offset=32768&contentRevision=${revision}`,
      )
    ).statusCode,
    409,
  );
});

test('MC-06: structured choice/multi-choice переводит id вариантов в trusted value', async (t) => {
  const { app, pending, calls } = await setup(t);

  pending.waiting = [
    {
      pid: 'typed-choice',
      version: 'choice-version',
      structured: true,
      actions: ['accept', 'cancel'],
      questions: [
        {
          key: 'one',
          inputType: 'choice',
          options: [
            {
              id: 'visible-id',
              value: 'wire-value',
              label: 'Первый',
            },
          ],
        },
        {
          key: 'many',
          inputType: 'multi-choice',
          options: [
            {
              id: 'visible-two',
              value: 'wire-two',
              label: 'Второй',
            },
          ],
        },
      ],
    },
  ];

  const card = (await app.inject('/api/mobile/v1/waiting')).json().items[0];
  const answer = await mutation(app, '/api/mobile/v1/waiting/typed-choice', {
    action: 'accept',
    actionToken: card.actionToken,
    answers: [
      {
        questionId: 'one',
        optionIds: ['visible-id'],
      },
      {
        questionId: 'many',
        optionIds: ['visible-two'],
      },
    ],
  });

  assert.equal(answer.statusCode, 200);
  assert.deepEqual(calls.at(-1).body.answers, [
    {
      key: 'one',
      value: 'wire-value',
    },
    {
      key: 'many',
      value: ['wire-two'],
    },
  ]);
});

test('MC-07: токены учтены в byte budget страницы из ста крупных ожиданий', async (t) => {
  const { app, pending } = await setup(t);

  pending.waiting = Array.from({ length: 100 }, (_, index) => ({
    pid: `p${String(index).padStart(3, '0')}`,
    version: `v${index}`,
    prompt: 'x'.repeat(20633),
    questions: [
      {
        question: 'Вопрос',
        options: [],
      },
    ],
  }));

  const response = await app.inject('/api/mobile/v1/waiting?limit=100');

  assert.equal(response.statusCode, 200);
  assert.ok(Buffer.byteLength(response.body) <= 2 * 1024 * 1024);
  assert.equal(response.json().hasMore, true);
  assert.ok(response.json().nextCursor);
  assert.ok(response.json().items.every((item) => item.actionToken?.length === 48));
});
