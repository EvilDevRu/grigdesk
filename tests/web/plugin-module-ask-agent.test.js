import assert from 'node:assert/strict';
import { mkdir, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ApiError } from '../../web/src/shared/apiClient.ts';
import { chatAppFixture, TEST_MODEL_REF } from '../server/helpers/chat-turns.js';
import { resolveChatWorkdir, validateWorkdirPath } from '../../server/src/lib/chat/workdir.ts';
import { chatStoreFixture } from './helpers/chat-store.js';
import { loadApi } from './helpers/chat-load.js';
import { serviceFixture } from './helpers/pluginModuleServices.js';
import { deferred, settle } from './helpers/pluginRuntimeUnit.js';

const request = {
  workdir: { kind: 'path', path: '/fixture/work' },
  title: 'Помощь',
  draft: 'Не отправлять'
};
const previewReply = {
  capability: { switch: 'resume', roots: 'multi' },
  target: { cwd: '/fixture/work', workdir: request.workdir },
};

/**
 * Порты управляют только ожиданиями и навигацией; один сценарий ниже использует реальный store и HTTP.
 * Каждая попытка имеет собственный signal, поэтому гонки не требуют выхода из живого окна.
 */
async function askFixture(t, options = {}) {
  const f = await serviceFixture(t, 'shared/askAgent.ts');
  const abort = new AbortController();
  const calls = [];
  const chat = options.chat ?? {
    loaded: true,
    defModelRef: { ...TEST_MODEL_REF },
    ensure: async () => {},
    newSession: (value) => {
      calls.push(['newSession', value]);

      return 'new-chat';
    },
  };
  const router = { push: async (value) => calls.push(['push', value]) };
  const preview = options.preview ?? (async (body, init) => {
    calls.push(['preview', body, init?.signal]);

    return structuredClone(previewReply);
  });
  const run = (input = request) => f.askAgent(input, {
    chat,
    router,
    preview,
    signal: abort.signal,
    isAlive: () => !abort.signal.aborted,
  });

  t.after(() => abort.abort());

  return {
    ...f,
    abort,
    calls,
    chat,
    run
  };
}

test('PM-ASK-DRAFT: настоящий preview и newSession сохраняют неотправленный черновик', async (t) => {
  const runs = [];
  const server = await chatAppFixture(t, { executor: {
    id: TEST_MODEL_REF.provider,
    workdir: { switch: 'resume', roots: 'multi' },
    run: async (input) => runs.push(input),
  } });
  const directory = path.join(server.root, 'work');

  await mkdir(directory);

  const workdir = { kind: 'path', path: directory };
  const posts = [];
  /**
   * Запрос идёт в настоящий Fastify, включая серверную проверку папки и capability.
   * Список запросов отделяет подготовку черновика от отправки хода исполнителю.
   */
  const preview = async (body, init) => {
    assert.equal(init.signal.aborted, false);
    posts.push('/api/chat/workdir/preview');

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/chat/workdir/preview',
      payload: body,
    });

    assert.equal(response.statusCode, 200, response.body);

    return response.json();
  };
  // Этот запрос доказывает пригодность HTTP-фикстуры ещё до проверки нового helper.
  // Модель берётся из того же TEST_MODEL_REF, который читает executorResolver сервера.
  const checked = await preview({ modelRef: TEST_MODEL_REF, candidate: { taskId: null, workdir } }, {
    signal: new AbortController().signal,
  });

  assert.equal(checked.target.cwd, await validateWorkdirPath(directory));

  const f = await askFixture(t, { preview });
  const chat = await chatStoreFixture({ sessions: [{
    id: 'old-chat',
    messages: [],
    createdAt: 1,
  }] });

  chat.defModelRef = { ...TEST_MODEL_REF };
  t.mock.method(chat, '_persist', () => {});
  t.mock.method(chat, 'ensure', async () => {});
  posts.length = 0;

  const id = await f.askAgent({ ...request, workdir }, {
    chat,
    router: { push: async (value) => f.calls.push(['push', value]) },
    preview,
    signal: f.abort.signal,
    isAlive: () => true,
  });
  const created = chat.sessions.find((session) => session.id === id);

  assert.ok(created);
  assert.equal(chat.sessions.length, 2);
  assert.equal(created.title, request.title);
  assert.equal(created.draft, request.draft);
  assert.deepEqual(created.workdir, workdir);
  assert.deepEqual(created.messages, []);
  assert.deepEqual(posts, ['/api/chat/workdir/preview']);
  assert.deepEqual(runs, []);
  assert.deepEqual(f.calls, [['push', { path: '/chats', query: { openChat: id } }]]);
});

test('PM-ASK-DRAFT: preview завершается до создания, snapshot модели и signal переданы', async (t) => {
  const pending = deferred();
  const bodies = [];
  const f = await askFixture(t, { preview: (body, init) => {
    bodies.push([body, init.signal]);

    return pending.promise;
  } });
  const result = f.run();

  await settle();
  assert.deepEqual(f.calls, []);
  assert.deepEqual(bodies, [[{
    modelRef: TEST_MODEL_REF, candidate: { taskId: null, workdir: request.workdir },
  }, f.abort.signal]]);
  pending.resolve(previewReply);
  assert.equal(await result, 'new-chat');
  assert.deepEqual(f.calls, [
    ['newSession', request], ['push', { path: '/chats', query: { openChat: 'new-chat' } }],
  ]);
});

test('PM-ASK-REALPATH: сервер канонизирует допустимый симлинк вне списка проектов', async (t) => {
  const server = await chatAppFixture(t, { executor: {
    id: TEST_MODEL_REF.provider,
    workdir: { switch: 'reseed', roots: 'single' },
    run: async () => ({}),
  } });
  const actual = path.join(server.root, 'actual');
  const alias = path.join(server.root, 'alias');

  await mkdir(actual);
  await symlink(actual, alias);

  const target = await resolveChatWorkdir({
    config: server.config,
    prefs: { read: () => ({}) },
    provider: TEST_MODEL_REF.provider,
    caps: { switch: 'reseed', roots: 'single' },
    workdir: { kind: 'path', path: alias },
  });

  assert.equal(target.cwd, actual);

  const f = await askFixture(t, { preview: async () => ({
    capability: { switch: 'reseed', roots: 'single' }, target,
  }) });

  await f.run({ ...request, workdir: { kind: 'path', path: alias } });
  assert.deepEqual(f.calls[0][1].workdir, { kind: 'path', path: actual });
});

for (const [label, reply] of Object.entries({
  'null-capability': { ...previewReply, capability: null },
  'bad-capability': { ...previewReply, capability: { switch: 'anything', roots: 'multi' } },
  'missing-target': { capability: previewReply.capability },
  'missing-workdir': { ...previewReply, target: { cwd: '/fixture/work' } },
  'relative-cwd': { ...previewReply, target: { ...previewReply.target, cwd: 'relative' } },
  'bad-workdir': { ...previewReply, target: { ...previewReply.target, workdir: { kind: 'unknown' } } },
})) {
  test(`PM-ASK-FAILURES: ${label} не создаёт чат`, async (t) => {
    const f = await askFixture(t, { preview: async () => reply });

    await assert.rejects(f.run());
    assert.deepEqual(f.calls, []);
  });
}

for (const error of [
  new ApiError('Исполнитель запрещает эту папку', 400, { error: 'provider_workdir_denied' }),
  new ApiError('Войдите снова', 401, { error: 'unauthorized' }),
  new Error('Сеть недоступна'),
]) {
  test(`PM-ASK-FAILURES: ${error.message} сохраняется без чата и перехода`, async (t) => {
    const f = await askFixture(t, { preview: async () => {
      throw error;
    } });

    await assert.rejects(f.run(), (failure) => failure.message.includes(error.message));
    assert.deepEqual(f.calls, []);
  });
}

for (const input of [
  { title: 'T', draft: 'D' }, { ...request, workdir: null },
  { ...request, workdir: { kind: 'path', path: 'relative' } },
  { ...request, title: '' }, { ...request, draft: null },
]) {
  test(`PM-ASK-FAILURES: повреждённый вход ${JSON.stringify(input)}`, async (t) => {
    const f = await askFixture(t);

    await assert.rejects(f.run(input));
    assert.deepEqual(f.calls, []);
  });
}

for (const changed of ['model', 'logout']) {
  test(`PM-ASK-FAILURES: ${changed} во время preview отзывает создание`, async (t) => {
    const pending = deferred();
    const f = await askFixture(t, { preview: () => pending.promise });
    const result = f.run();
    const rejected = assert.rejects(result);

    await settle();

    if (changed === 'model') {
      f.chat.defModelRef = { ...TEST_MODEL_REF, model: 'other-model' };
    } else {
      f.abort.abort();
    }

    pending.resolve(previewReply);
    await rejected;
    assert.deepEqual(f.calls, []);
  });
}

test('PM-ASK-NOT-LOADED: ensure загружает чужую сессию до нового черновика', async (t) => {
  const f = await askFixture(t);
  const serverState = {
    sessions: [{
      id: 'server-chat',
      messages: [],
      createdAt: 1
    }],
    archived: [],
    activeId: 'server-chat',
    defModelRef: TEST_MODEL_REF,
  };
  const { api, calls: requests } = loadApi(async () => serverState);
  const chat = await chatStoreFixture({}, { api, unloaded: true });

  t.mock.method(chat, '_persist', () => {});

  const id = await f.askAgent(request, {
    chat,
    router: { push: async () => {} },
    preview: async () => previewReply,
    signal: f.abort.signal,
    isAlive: () => true,
  });

  assert.equal(chat.loaded, true);
  assert.deepEqual(chat.defModelRef, TEST_MODEL_REF);
  assert.equal(requests.some(([method, url]) => method === 'GET'
    && url.startsWith('/api/chat/store/list?')), true);
  assert.deepEqual(chat.sessions.map((session) => session.id).sort(), ['server-chat', id].sort());
  assert.equal(await chat.revealChat(id), true);
  assert.equal(requests.some(([method, url]) => method === 'POST' && url === '/api/chat'), false);
});

test('PM-ASK-NO-MODEL: после ensure понятная ошибка RU/EN без чата и навигации', async (t) => {
  const f = await askFixture(t);

  f.chat.defModelRef = null;

  const messages = [];

  for (const locale of ['ru', 'en']) {
    f.ui.setUiLocale(locale);

    const expected = f.ui.t('core.pluginAskAgentChooseModel');

    assert.notEqual(expected, 'core.pluginAskAgentChooseModel');
    await assert.rejects(f.run(), (error) => {
      messages.push(error.message);

      return error.message === expected;
    });
  }

  assert.notEqual(messages[0], messages[1]);
  assert.deepEqual(f.calls, []);
  f.ui.setUiLocale('ru');
});

test('PM-ASK-NO-SESSION: отказ newSession не открывает URL без идентификатора', async (t) => {
  const f = await askFixture(t);

  f.chat.newSession = () => null;

  await assert.rejects(f.run(), (error) => error.message === f.ui.t('core.chatStoreNotLoaded'));
  assert.equal(f.calls.some(([kind]) => kind === 'push'), false);
});

test('PM-ASK-FAILURES: настоящий сервер сохраняет запреты root/home и adapter denial', async (t) => {
  const executor = {
    id: TEST_MODEL_REF.provider,
    workdir: { switch: 'resume', roots: 'multi' },
    validateWorkdir: async () => ({ error: 'Запрещено адаптером', extraDirs: [] }),
    run: async () => {
      assert.fail('Предпросмотр не запускает исполнителя');
    },
  };
  const server = await chatAppFixture(t, { executor });
  const f = await askFixture(t, { preview: async (body) => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/chat/workdir/preview',
      payload: body,
    });

    assert.equal(response.statusCode, 400);

    const data = response.json();

    throw new ApiError(data.message, response.statusCode, data);
  } });

  for (const directory of ['/', os.homedir(), server.root]) {
    await assert.rejects(f.run({ ...request, workdir: { kind: 'path', path: directory } }));
  }

  assert.deepEqual(f.calls, []);
});
