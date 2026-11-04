import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { ChatHistoryStore } from '../../server/src/lib/chat/historyStore.ts';
import { MobileChatControls } from '../../server/src/lib/chat/mobileControls.ts';
import { ChatTurnLocks } from '../../server/src/lib/chat/turnLocks.ts';
import { ActionTokens } from '../../server/src/lib/mobile/actionTokens.ts';
import { registerChatControlRoutes, chatSettings } from '../../server/src/lib/mobile/facade/chatControls.ts';
import { registerAttentionRoutes } from '../../server/src/lib/mobile/facade/attention.ts';
import { decodeContract } from '../../mobile/src/api/contract.ts';
import { mobileFacadeFixture, mutation, testDevice } from './helpers/mobile-facade.js';
import { temporary } from '../relay/helpers.js';
import { chatAppFixture, controlledExecutor, TEST_MODEL_REF, turnBody } from './helpers/chat-turns.js';

const modelRef = { provider: 'one', model: 'model' };
const secondRef = { provider: 'two', model: 'other' };
const registry = {
  one: [{ id: 'model', efforts: ['low', 'high'] }],
  two: [{ id: 'other', efforts: ['max'] }],
};

/**
 * Проверки используют настоящий файловый владелец и admission lock на временной истории.
 * Только каталог исполнителей и сброс внешней сессии заменены управляемыми портами.
 */
async function owner(t, overrides = {}) {
  const root = await temporary(t);
  const history = new ChatHistoryStore({
    chatsDir: path.join(root, 'chats'),
    registryProvider: async () => registry,
  });
  const locks = new ChatTurnLocks();
  const controls = new MobileChatControls({
    history,
    registry: async () => registry,
    busy: (id) => locks.isBusy({ chatKey: id }),
    lock: (id, job) => locks.run({ chatKey: id }, job),
    reset: async () => {},
    changed: () => {},
    ...overrides,
  });

  return { history, controls };
}

test('Создание и настройки: каталог, effort, CAS и подтверждённая смена исполнителя', async (t) => {
  let resets = 0;
  const { controls, history } = await owner(t, { reset: async () => {
    resets += 1;
  } });
  const chat = await controls.create('created', modelRef);

  assert.deepEqual(chat.modelRef, modelRef);
  assert.deepEqual((await controls.create('created', modelRef)).messages, []);
  await assert.rejects(() => controls.create('bad', { provider: 'unknown', model: 'model' }),
    { code: 'unknown_model' });
  await assert.rejects(() => controls.configure('created', {
    expectedRevision: chat.revision,
    modelRef,
    effort: 'max',
    reset: false,
  }), { code: 'unsupported_effort' });

  const changed = await controls.configure('created', {
    expectedRevision: chat.revision,
    modelRef,
    effort: 'high',
    reset: false,
  });

  assert.equal(changed.effort, 'high');
  await assert.rejects(() => controls.configure('created', {
    expectedRevision: chat.revision,
    modelRef,
    effort: 'low',
    reset: false,
  }), { code: 'state_changed' });
  await assert.rejects(() => controls.configure('created', {
    expectedRevision: changed.revision,
    modelRef: secondRef,
    effort: 'max',
    reset: false,
  }), { code: 'reset_required' });
  assert.equal(resets, 0);

  const reset = await controls.configure('created', {
    expectedRevision: changed.revision,
    modelRef: secondRef,
    effort: 'max',
    reset: true,
  });

  assert.equal(resets, 1);
  assert.deepEqual(reset.modelRef, secondRef);
  assert.equal(reset.sessionId, null);
  assert.equal((await history.readOne('created')).effort, 'max');
});

test('Во время сброса PUT ждёт history lock и не откатывает сменившуюся модель', async (t) => {
  let entered;
  let release;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { controls, history } = await owner(t, { reset: async () => {
    entered();
    await gate;
  } });
  const initial = await controls.create('race', modelRef);
  const changing = controls.configure('race', {
    expectedRevision: initial.revision,
    modelRef: secondRef,
    effort: 'max',
    reset: true,
  });

  await started;
  await assert.rejects(() => controls.configure('race', {
    expectedRevision: initial.revision,
    modelRef,
    effort: 'low',
    reset: false,
  }), { code: 'chat_busy' });

  const put = history.saveOne({ ...initial, title: 'Название из другого окна' });

  release();
  await Promise.all([changing, put]);

  const saved = await history.readOne('race');

  assert.deepEqual(saved.modelRef, secondRef);
  assert.equal(saved.effort, 'max');
  assert.equal(saved.title, 'Название из другого окна');
});

test('Отметка чтения не гасит новый ответ по старой ревизии', async (t) => {
  const { controls, history } = await owner(t);

  const stale = await controls.create('unread', modelRef);

  const before = await history.patchExecution('unread', () => ({ unread: true }));
  const next = await history.patchExecution('unread', () => ({ preview: 'Новый ответ' }));

  await assert.rejects(() => controls.read('unread', before.revision), { code: 'state_changed' });
  await history.saveOne({ ...stale, unread: false });
  assert.equal((await history.readOne('unread')).unread, true);

  const fresh = await history.readOne('unread');

  assert.ok(fresh.revision >= next.revision);
  await controls.read('unread', fresh.revision);
  assert.equal((await history.heads())[0].unread, false);
});

test('HTTP: повтор создания сохраняет id, токен задаёт ревизию, вход проверяется до эффекта', async (t) => {
  const { controls, history } = await owner(t);
  const tokens = new ActionTokens();
  const { app } = await mobileFacadeFixture(t, async (app) => {
    registerChatControlRoutes(app, {
      tokens,
      chat: { controls },
    });
  });
  const at = Date.now();
  const first = await mutation(app, '/api/mobile/v1/chats', { modelRef }, 'create-chat-one', at);
  const replay = await mutation(app, '/api/mobile/v1/chats', { modelRef }, 'create-chat-one', at);

  assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual(replay.json(), first.json());
  assert.equal((await history.heads()).length, 1);

  const result = decodeContract('chat-result', first.json());
  const actionToken = tokens.issue(testDevice.id, `chat:${result.id}`, 'configure', {
    revision: result.revision,
  });
  const changed = await mutation(app, `/api/mobile/v1/chats/${result.id}/settings`, {
    modelRef,
    effort: 'high',
    reset: false,
    actionToken,
  }, 'configure-chat-one');

  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal((await history.readOne(result.id)).effort, 'high');

  const invalid = await mutation(app, '/api/mobile/v1/chats', {
    modelRef,
    unexpected: 'не допускается',
  }, 'bad-input-one');

  assert.equal(invalid.statusCode, 400);
});

test('Каталог без приватных полей; счётчики отличают ожидания, завершение и остановку', async (t) => {
  const source = {
    '/api/providers': { providers: [{
      id: 'one',
      name: 'Первый',
      secret: 'не отдавать',
      available: true,
      capabilities: { chatAutoCompact: true },
      models: [{
        id: 'model',
        name: 'Модель',
        efforts: ['high'],
        context: 1000,
        contextRuntimeOnly: true,
      }],
    }] },
    '/api/projects': { projects: [{
      id: 'project',
      title: 'Проект',
      privateKey: 'не отдавать',
    }] },
    '/api/tasks': { tasks: [
      {
        task: '1',
        title: 'Готово',
        result: 'done',
        stall: {},
      },
      {
        task: '2',
        title: 'Стоп',
        stall: {},
        daemonAlive: true,
      },
      {
        task: '3',
        title: 'Ворота',
        stages: { plan: 'wait' },
        daemonAlive: true,
      },
      {
        task: '4',
        title: 'Работает',
        daemonAlive: true,
      },
    ] },
    '/api/chat/waiting': { waiting: [{ chatKey: 'a' }, { chatKey: 'a' }, { chatKey: 'b' }] },
    '/api/chat/active': { active: [{ chatKey: 'a' }, { chatKey: 'a' }] },
  };
  const deps = {
    chat: {
      heads: async () => [{ unread: true }, { unread: false }],
      defaults: async () => ({ defModelRef: modelRef }),
    },
    callApi: async (_method, url) => ({ statusCode: 200, body: source[url] }),
  };
  const { app } = await mobileFacadeFixture(t, async (app) => {
    registerChatControlRoutes(app, deps);
    registerAttentionRoutes(app, deps);
  });
  const options = (await app.inject('/api/mobile/v1/chat-options')).json();

  decodeContract('chat-options', options);
  assert.deepEqual(options.defaultModelRef, modelRef);
  assert.equal(options.models[0].contextVerified, false);
  assert.equal(JSON.stringify(options).includes('не отдавать'), false);

  const attention = (await app.inject('/api/mobile/v1/attention')).json();

  assert.deepEqual(decodeContract('attention', attention), {
    chats: {
      waiting: 2,
      unread: 1,
      running: 1,
    },
    tasks: {
      waiting: 1,
      stalled: 1,
      running: 1,
    },
  });
  assert.equal(chatSettings({ contextTokens: 15 }, { contextTokens: 0 }, { chat: {} }).context.tokens, 0);
  assert.equal(chatSettings({}, undefined, { chat: {} }).context.tokens, null);
});

test('Настоящий владелец: запуск запрещает настройку, перенос папки проходит общий CAS', async (t) => {
  const { executor, runs, waitForRuns } = controlledExecutor();
  const { app: grigdesk } = await chatAppFixture(t, { executor });
  const initial = await grigdesk.mobileChat.controls.create('mobile-controls', TEST_MODEL_REF);

  await grigdesk.mobileChat.send({
    ...turnBody('mobile-controls', 'mobile-controls-turn'),
    owner: {
      deviceId: testDevice.id,
      clientId: 'mobile-controls-message',
      contentHash: 'a'.repeat(64),
    },
  });
  await waitForRuns(1);
  await assert.rejects(() => grigdesk.mobileChat.controls.configure('mobile-controls', {
    expectedRevision: initial.revision,
    modelRef: TEST_MODEL_REF,
    effort: '',
    reset: false,
  }), { code: 'chat_busy' });
  runs[0].release('Готово');

  const tokens = new ActionTokens();
  const { app } = await mobileFacadeFixture(t, async (app) => {
    registerChatControlRoutes(app, {
      tokens,
      chat: grigdesk.mobileChat,
      callApi: async (method, url, payload) => {
        const response = await grigdesk.inject({
          method,
          url,
          payload,
        });

        return { statusCode: response.statusCode, body: response.json() };
      },
    });
  });
  const created = await mutation(
    app, '/api/mobile/v1/chats', { modelRef: TEST_MODEL_REF }, 'workspace-chat-new',
  );
  const id = created.json().id;
  const preview = await mutation(app, `/api/mobile/v1/chats/${id}/workspace/preview`, {
    taskId: null,
    workdir: { kind: 'path', path: '/tmp' },
  }, 'workspace-preview-one');

  assert.equal(preview.statusCode, 200, preview.body);
  decodeContract('workspace-preview', preview.json());

  const changed = await mutation(app, `/api/mobile/v1/chats/${id}/workspace`, {
    actionToken: preview.json().actionToken,
    transfer: 'reset',
  }, 'workspace-change-one');

  assert.equal(changed.statusCode, 200, changed.body);
  assert.deepEqual((await grigdesk.mobileChat.read(id)).workdir, { kind: 'path', path: '/tmp' });
});


test('SPEED-MOBILE-NEW: standard только нового чата, повтор create сохраняет speed', async (t) => {
  const { controls, history } = await owner(t);
  const first = await controls.create('speed-new', modelRef);

  assert.equal(first.speed, 'standard');
  await history.patchExecution(first.id, () => ({ speed: 'ultrafast' }), { durable: true });

  const again = await controls.create('speed-new', modelRef);

  assert.equal(again.speed, 'ultrafast');
});


for (const speed of ['fast', 'ultrafast', null, undefined, 'standard']) {
  for (const target of ['provider', 'unsupported', 'compatible']) {
    test(`SPEED-MOBILE-SWITCH: ${String(speed)} / ${target}`, async (t) => {
      const previous = registry.one;

      t.after(() => {
        registry.one = previous;
      });
      registry.one = [
        { ...previous[0], chatSpeedModes: ['standard', 'fast', 'ultrafast'] },
        {
          id: 'slow',
          efforts: [],
          chatSpeedModes: ['standard'],
        },
      ];

      const { controls, history } = await owner(t);
      const first = await controls.create('speed-switch', modelRef);
      const current = await history.patchExecution(first.id, () => ({ speed }), { durable: true });
      const nextRef = target === 'provider' ? secondRef
        : target === 'unsupported' ? { provider: 'one', model: 'slow' } : modelRef;
      const changed = await controls.configure(first.id, {
        expectedRevision: current.revision,
        modelRef: nextRef,
        effort: target === 'provider' ? 'max' : '',
        reset: true,
      });
      const expected = speed != null && speed !== 'standard' && target !== 'compatible'
        ? 'standard' : speed;

      assert.equal(changed.speed, expected);
      assert.equal((await history.readOne(first.id)).speed, expected);
      assert.deepEqual(changed.modelRef, nextRef);
    });
  }
}
