import assert from 'node:assert/strict';
import test from 'node:test';
import type * as Pinia from 'pinia';

const { createPinia, setActivePinia }: typeof Pinia = await import(
  new URL('../../web/node_modules/pinia/dist/pinia.mjs', import.meta.url).href
);

import { loadMigrationModule, migrationHarness } from './helpers/compile-vue.js';
import { apiHarness, chatStoreFixture, sseOf } from './helpers/chat-store.js';

/**
 * Настоящий store получает управляемый сетевой ответ; GET/POST учитываются отдельно.
 * Каждая проверка владеет своим Pinia и модулем с независимыми epochs и таймерами.
 */
async function fixture(oldName: string, newName: string, exported: string) {
  setActivePinia(createPinia());

  const calls: Array<{
    method: string;
    url: string;
    body?: unknown
  }> = [];
  const server: { reply: unknown } = { reply: {} };

  migrationHarness.api = {
    async get(url: string) {
      calls.push({ method: 'GET', url });

      return server.reply;
    },
    async post(url: string, body: unknown) {
      calls.push({
        method: 'POST',
        url,
        body
      });

      return server.reply;
    },
  };
  migrationHarness.alerts.length = 0;

  const module = await loadMigrationModule(`src/stores/${oldName}.js`, `src/stores/${newName}.ts`);

  return {
    store: module[exported](),
    server,
    calls
  };
}

test('NET-auth', async () => {
  const { store, server, calls } = await fixture('auth', 'auth', 'useAuthStore');

  server.reply = {
    configured: true,
    authenticated: true,
    login: 'legacy-owner'
  };
  await store.load();
  assert.equal(store.clientScope, 'legacy-owner');
  assert.equal(store.authenticated, true);

  const confirmation = store.logConfirmation;

  server.reply = {
    configured: true,
    authenticated: 'yes',
    login: 'legacy-owner'
  };
  await store.load();
  assert.equal(store.authenticated, false, 'строка не подтверждает вход');
  assert.equal(store.logConfirmation, confirmation);
  assert.equal(store.ready, true);
  assert.deepEqual(calls.map((call) => call.method), ['GET', 'GET']);
});

test('NET-system', async () => {
  const { store, server, calls } = await fixture('system', 'system', 'useSystemStore');

  server.reply = { cpu: { percent: 7 } };
  await store.load();
  assert.equal(store.data.cpu.percent, 7);

  const previous = store.data;
  const updatedAt = store.updatedAt;

  server.reply = { cpu: { percent: 'bad' } };
  await store.load();
  assert.equal(store.data, previous, 'неверные метрики не заменяют последний снимок');
  assert.equal(store.updatedAt, updatedAt);
  assert.equal(store.stale, true);
  assert.ok(store.error);
  assert.equal(calls.length, 2);
});

test('NET-release', async (t) => {
  const { store, server, calls } = await fixture(
    'grigdesk-update', 'grigdeskUpdate', 'useGrigDeskUpdateStore',
  );

  t.after(() => store.stop());
  server.reply = { job: null, latest: null };
  await store.load();
  assert.equal(store.status.job, null);

  const previous = store.status;

  server.reply = { job: { id: 'job', status: 7 } };
  await store.load();
  assert.equal(store.status, previous, 'job.status обязан быть строкой');
  assert.ok(store.error);
  assert.equal(calls.length, 2);
});

test('NET-providers', async () => {
  const { store, server, calls } = await fixture('providers', 'providers', 'useProvidersStore');
  const providers = [{
    id: 'future-provider',
    name: 'Новый исполнитель',
    vendor: 'new-vendor',
    available: true,
    models: [{
      id: 'future-model',
      name: 'Модель',
      efforts: ['new-effort']
    }],
  }];

  server.reply = { providers };
  await store.load();
  assert.equal((await store.whenRegistryReady()).ok, true);
  assert.deepEqual(store.providers, providers);

  for (const bad of ['bad', [{ ...providers[0], models: 'bad' }]]) {
    server.reply = { providers: bad };
    await store.load();
    assert.deepEqual(store.providers, providers, 'неверный реестр не публикуется');
    assert.equal((await store.whenRegistryReady()).ok, false);
  }

  assert.equal(calls.length, 3);
});

test('NET-providers-usage', async (t) => {
  const usage = { future: {
    state: 'ok',
    bars: [{ key: 'week', pct: 42 }],
    resources: [{
      key: 'balance',
      label: 'Баланс',
      summary: '10 CNY',
      controls: [],
    }],
  } };

  for (const field of ['bars', 'resources']) {
    await t.test(`неверный контейнер ${field}`, async () => {
      const { store } = await fixture('providers', 'providers', 'useProvidersStore');

      assert.equal(store.applyUsage(usage), true);
      assert.equal(store.applyUsage({ future: { ...usage.future, [field]: 'bad' } }), false);
      assert.deepEqual(store.usage, usage);
    });
  }
});

test('NET-plugins', async () => {
  const { store, server, calls } = await fixture('plugins', 'plugins', 'usePluginsStore');
  const plugins = [{
    id: 'custom',
    name: 'Свой',
    enabled: true
  }];

  server.reply = { plugins };
  await store.load();
  assert.deepEqual(store.list, plugins);
  server.reply = { plugins: [{ ...plugins[0], enabled: 'yes' }] };
  await store.load();
  assert.deepEqual(store.list, plugins, 'enabled принимает только boolean');
  assert.ok(store.loadError);
  assert.equal(calls.length, 2);
});

test('NET-plugins-ack', async () => {
  const { store, server, calls } = await fixture('plugins', 'plugins', 'usePluginsStore');

  store.list = [{
    id: 'custom',
    name: 'Свой',
    enabled: false
  }];
  server.reply = { ok: true, enabled: 'yes' };

  const outcome = await store.toggle('custom', true);

  assert.equal(outcome.ok, false);
  assert.ok(['unknown', 'failed'].includes(outcome.outcome));
  assert.equal(store.list[0].enabled, false);
  assert.deepEqual(calls, [{
    method: 'POST',
    url: '/api/plugins/custom/toggle',
    body: { enabled: true },
  }]);
});

test('NET-pipeline', async () => {
  const { store, server, calls } = await fixture('notify-watch', 'notifyWatch', 'useNotifyWatchStore');

  server.reply = { tasks: [] };
  await store.check(true);
  assert.equal(store.error, null);

  const loadedAt = store.loadedAt;

  server.reply = { tasks: 'bad' };
  await store.check();
  assert.ok(store.error, 'строка tasks не является пустым успешным снимком');
  assert.equal(store.loadedAt, loadedAt);
  assert.deepEqual(store.waiting, []);
  assert.deepEqual(migrationHarness.alerts, []);
  assert.equal(calls.length, 2);
});

test('NET-pipeline-graph', async () => {
  const { store, server, calls } = await fixture('notify-watch', 'notifyWatch', 'useNotifyWatchStore');

  server.reply = {
    tasks: [{ task: '42', title: 'Задача' }],
    nodes: 'bad',
    progress: 'bad'
  };
  await store.check(true);
  assert.ok(store.error || store.observedByTask['42']?.gateKnown === false,
    'неверный граф не становится известным состоянием');
  assert.deepEqual(migrationHarness.alerts, []);
  assert.deepEqual(calls.map((call) => call.url), ['/api/tasks', '/api/tasks/42/graph']);
});

test('NET-b24', async () => {
  const { store, server, calls } = await fixture('board', 'board', 'useBoardStore');
  let baselineCalls = 0;

  store.markBaselineSeen = async () => {
    baselineCalls += 1;
    assert.ok(Array.isArray(store.data.tasks), 'dashboard публикуется до baseline');
  };
  server.reply = { tasks: [] };
  await store.load(true);
  assert.equal(baselineCalls, 1);

  const previous = store.data;

  server.reply = { tasks: 'bad' };
  await store.load(true);
  assert.equal(store.data, previous, 'неверная доска не назначается');
  assert.equal(baselineCalls, 1);
  assert.ok(store.error);
  assert.equal(calls.length, 2);
});

test('NET-b24-task', async () => {
  const { store, server, calls } = await fixture('tasks', 'tasks', 'useTasksStore');

  server.reply = { id: 42, title: 'Карточка' };
  await store.load('42');

  const previous = store.details['42'];

  server.reply = { id: '42', title: [] };
  await Promise.resolve(store.load('42', true)).catch(() => {});
  assert.equal(store.details['42'], previous, 'неверный title не кешируется');
  assert.equal(calls.length, 2);
});

test('NET-chat', async () => {
  const chat = await chatStoreFixture({ sessions: [{
    id: 'chat',
    title: 'До',
    messages: []
  }] });
  const original = chat.sessions[0];
  const messages = original.messages;

  apiHarness.get = async () => ({ chat: {
    id: 'chat',
    title: 'После',
    messages: 'bad'
  } });
  await assert.doesNotReject(() => chat._pullChat('chat', false));
  assert.equal(chat.sessions[0], original);
  assert.equal(original.messages, messages);
  assert.equal(original.title, 'До');
  chat.$dispose();
});

test('NET-chat-active', async () => {
  const chat = await chatStoreFixture({ sessions: [{ id: 'chat', messages: [] }] });
  const previous = { ...chat.runtimeRuns };

  apiHarness.get = async () => ({ active: 'bad', protocol: 'bad' });
  await assert.doesNotReject(() => chat._loadActive());
  assert.deepEqual(chat.runtimeRuns, previous);
  assert.equal(chat.inTurnProtocol, 0);
  chat.$dispose();
});

test('NET-chat-sse', async () => {
  const chat = await chatStoreFixture({ sessions: [{ id: 'chat', messages: [] }] });
  const event = sseOf(chat);

  event('chat-permission', { pid: {}, tool: [] });
  assert.deepEqual(chat.pending, {}, 'неверный permission не создаёт подтверждение');
  chat.$dispose();
});

test('NET-chat-legacy-absence', async () => {
  const chat = await chatStoreFixture({ sessions: [{
    id: 'legacy',
    title: 'Чат',
    messages: [],
    draft: '',
    taskId: '42',
    workdir: { kind: 'path', path: '/workspace/current' },
    workdirState: { committed: { cwd: '/workspace/current' } },
  }] });
  const session = chat.sessions[0];
  const calls: string[] = [];

  session.draft = 'Несохранённый текст';
  apiHarness.get = async (url: string) => {
    calls.push(`GET ${url}`);

    return { chat: { id: 'legacy', messages: [] } };
  };
  apiHarness.post = async (url: string) => {
    calls.push(`POST ${url}`);

    return {};
  };
  await chat._pullChat('legacy', false);
  assert.equal(chat.sessions[0], session);
  assert.equal(session.draft, 'Несохранённый текст');
  assert.equal(session.workdir.path, '/workspace/current');
  assert.equal(session.taskId, '42');
  assert.equal(session.workdirState.committed.cwd, '/workspace/current');
  assert.deepEqual(calls, ['GET /api/chat/store/chat/legacy']);

  apiHarness.get = async () => ({ chat: {
    id: 'legacy',
    messages: [],
    workdir: null
  } });
  await chat._pullChat('legacy', false);
  assert.equal(session.workdir, null, 'explicit null отличается от отсутствующего own поля');
  assert.equal(session.taskId, '42');
  chat.defModel = 'model';
  chat.defMode = 'mode';
  sseOf(chat)('chat-store-meta', { meta: { defEffort: 'effort' }, origin: 'another-window' });
  assert.equal(chat.defModel, 'model');
  assert.equal(chat.defMode, 'mode');
  assert.equal(chat.defEffort, 'effort');
  chat.$dispose();
});

test('NET-chat-history-envelope', async () => {
  const chat = await chatStoreFixture({ sessions: Array.from({ length: 100 }, (_, index) => ({
    id: `chat-${index}`,
    title: `Чат ${index}`,
    messages: [],
  })) });
  const original = chat.sessions[0];
  let reads = 0;
  const step = { k: 'tool', id: 'step' };

  Object.defineProperty(step, 'text', {
    enumerable: true,
    get() {
      reads += 1;

      throw new Error('Прочитано историческое тело');
    },
  });

  const attachment = {
    file: 'image.png',
    name: 'Картинка',
    mime: 'image/png',
    url: '/api/chat/uploads/image.png',
  };
  const messages = Array.from({ length: 200 }, (_, index) => ({
    role: 'assistant',
    text: `Ответ ${index}`,
    steps: Array(300).fill(step),
    attachments: [attachment],
    extension: { providerSpecific: true },
  }));
  const calls: string[] = [];

  apiHarness.get = async (url: string) => {
    calls.push(`GET ${url}`);

    return { chat: {
      id: 'chat-0',
      title: 'Другой заголовок',
      messages,
      revision: 1
    } };
  };
  apiHarness.post = async (url: string) => {
    calls.push(`POST ${url}`);

    return {};
  };
  await chat._pullChat('chat-0', false);
  assert.equal(reads, 0);
  assert.equal(chat.sessions.length, 100);
  assert.equal(chat.sessions[0], original);
  assert.equal(original.messages.length, 200);
  assert.deepEqual(original.messages[199].attachments[0], attachment);
  assert.deepEqual(original.messages[199].extension, { providerSpecific: true });
  assert.deepEqual(calls, ['GET /api/chat/store/chat/chat-0']);
  chat.$dispose();
});

test('NET-speech-consent', async (t) => {
  const { speechControllerHarness } = await import('./helpers/compile-vue.js');
  const prefs = {
    engine: 'browser',
    browserProcessing: 'auto',
    browserAutoConsent: false,
    language: 'ru',
    dictionary: '',
    local: { ready: true, reason: '' },
    revision: 'revision-1',
  };
  const { controller, lease, state } = await speechControllerHarness(prefs, {
    settings: { settings: {
      ...prefs,
      browserAutoConsent: 'yes',
      revision: 'revision-2'
    } },
  });

  t.after(() => controller.dispose());
  await lease.start();
  assert.equal(lease.state.prompt, 'browser-consent');
  await lease.confirmBrowserConsent();
  assert.equal(state.recognitions.length, 0);
  assert.equal(state.calls.filter((call: unknown[]) => call[0] === 'POST').length, 1);
  assert.equal(state.prefs.browserAutoConsent, false);
});

test('NET-speech-upload', async (t) => {
  const { speechControllerHarness } = await import('./helpers/compile-vue.js');

  for (const scenario of ['upload', 'warmup']) {
    await t.test(scenario, async (s) => {
      const { controller, lease, state } = await speechControllerHarness({
        engine: 'whisper',
        local: { ready: true, reason: '' },
        revision: 'revision-1',
        language: 'ru',
      }, {
        warmup: { warmupId: scenario === 'warmup' ? 7 : 'warmup-1' },
        upload: { text: scenario === 'upload' ? 42 : 'Распознано' },
      });

      s.after(() => controller.dispose());
      await lease.start();
      assert.equal(lease.state.phase, 'recording');
      await lease.stop();
      await new Promise((resolve) => setImmediate(resolve));

      const uploads = state.calls.filter((call: unknown[]) => call[0] === 'UPLOAD');

      assert.equal(uploads.length, 1);
      assert.equal(state.stopped, 1);

      const upload = uploads[0];

      assert.ok(upload);

      const form = upload[2];

      assert.ok(form instanceof FormData);

      if (scenario === 'warmup') {
        assert.equal(form.has('warmupId'), false, 'число не является id прогрева');
        assert.deepEqual(state.commits, ['Распознано']);
        assert.deepEqual(state.errors, []);
      } else {
        assert.equal(form.get('warmupId'), 'warmup-1');
        assert.deepEqual(state.commits, [], 'число не становится распознанным текстом');
        assert.ok(state.errors.length);
      }
    });
  }
});

test('NET-speech-ready', async () => {
  const { transportHarness } = await import('./helpers/compile-vue.js');
  const { createSpeechStream, SPEECH_STREAM_AUDIO } = await loadMigrationModule(
    'src/shared/speech-stream.js', 'src/shared/speechStream.ts',
  );
  const harness = transportHarness();
  const opening = createSpeechStream(harness.config);
  const socket = harness.state.sockets[0];

  assert.ok(socket);
  socket.open();
  socket.message({
    type: 'ready',
    protocolVersion: 99,
    audio: SPEECH_STREAM_AUDIO
  });
  await assert.rejects(opening, { code: 'speech_stream_protocol' });
  assert.equal(socket.sent.filter((value: unknown) => value instanceof ArrayBuffer).length, 0);
  assert.equal(harness.state.sockets.length, 1);
});

test('NET-chat-waiting', async () => {
  const chat = await chatStoreFixture({ sessions: [{ id: 'chat', messages: [] }] });

  apiHarness.get = async () => ({ waiting: 'bad' });
  await assert.doesNotReject(() => chat._loadWaiting());
  assert.deepEqual(chat.pending, {}, 'неверная waiting очередь не создаёт фантомный запрос');
  chat.$dispose();
});

test('NET-chat-pending', async () => {
  const chat = await chatStoreFixture({ sessions: [{ id: 'chat', messages: [] }] });
  const calls: string[] = [];

  apiHarness.get = async (url: string) => {
    calls.push(`GET ${url}`);

    return { pending: 'bad' };
  };
  apiHarness.del = async (url: string) => {
    calls.push(`DELETE ${url}`);

    return {};
  };
  await chat._collectPending();
  assert.deepEqual(chat.sessions[0].messages, []);
  assert.deepEqual(calls, ['GET /api/chat/pending']);
  chat.$dispose();
});

test('NET-chat-receipt', async () => {
  const { newChatInTurnRun } = await import('../../web/src/stores/chatInTurn.ts');
  const chat = await chatStoreFixture({ sessions: [{ id: 'chat', messages: [] }] });
  const run = newChatInTurnRun('chat', 'run-12345678');
  const calls: string[] = [];

  run.active = true;
  run.availability = {
    runId: 'run-12345678',
    available: true,
    revision: 1
  };
  chat.inTurnProtocol = 1;
  chat.inTurnRuns.chat = run;
  apiHarness.post = async (url: string) => {
    calls.push(`POST ${url}`);

    return {
      accepted: true,
      state: 7,
      messageId: {}
    };
  };
  apiHarness.get = async (url: string) => {
    calls.push(`GET ${url}`);

    return { messages: {} };
  };
  assert.equal(await chat.sendInTurn('chat', 'Уточнение'), false,
    'неверный receipt не подтверждает отправку');
  assert.equal(calls.filter((call) => call.startsWith('POST')).length, 1);
  assert.ok(chat.inTurnAttempts.chat, 'неизвестный исход сохраняет id прежней попытки');
  assert.deepEqual(chat.sessions[0].messages, []);
  chat.$dispose();
});

test('NET-chat-storage', async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const writes: string[] = [];
  const storage = {
    getItem(key: string) {
      return key === 'grigdesk-chat-snapshot' ? JSON.stringify({ sessions: 'bad' }) : null;
    },
    setItem(key: string) {
      writes.push(key);
    },
    removeItem() {},
  };

  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  t.after(() => {
    if (previous) {
      Object.defineProperty(globalThis, 'localStorage', previous);
    } else {
      Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });

  const chat = await chatStoreFixture();

  chat.loaded = false;
  apiHarness.get = async (url: string) => {
    if (url === '/api/chat/store') {
      return { sessions: [], archived: [] };
    }

    return {
      active: [],
      queued: [],
      waiting: [],
      pending: []
    };
  };
  await assert.doesNotReject(() => chat._load());
  assert.deepEqual(chat.sessions, []);
  assert.deepEqual(writes, [], 'повреждённый snapshot не публикуется заново');
  chat.$dispose();
});
