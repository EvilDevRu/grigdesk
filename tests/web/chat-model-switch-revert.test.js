// Настоящее CAS-хранилище и независимые окна воспроизводят гонки выбора настроек.
// Все записи изолированы временной папкой; ни CLI, ни личные данные здесь не нужны.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test as nodeTest } from 'node:test';

import { ChatHistoryStore } from '../../server/src/lib/chat/historyStore.ts';
import { chatStoreFixture, setChatProviders, sseOf } from './helpers/chat-store.js';

const test = (name, run) => nodeTest(name, { timeout: 15000 }, run);

const MODELS = {
  deepseek: [{ id: 'ds-test', efforts: ['off', 'high', 'max'] }],
  claude: [
    { id: 'claude-a', efforts: ['low', 'high', 'max'] },
    { id: 'claude-b', efforts: ['low', 'high'] },
    { id: 'claude-c', efforts: ['low', 'high'] },
    { id: 'claude-empty', efforts: [] },
  ],
};
const refOf = (model) => ({
  provider: Object.keys(MODELS).find((provider) => MODELS[provider].some((item) => item.id === model)),
  model,
});
const copy = (value) => JSON.parse(JSON.stringify(value));
const effortOf = (chat) => chat.effort || '';

/**
 * Каталог окна берёт уровни из тех же записей, что реестр серверного хранилища.
 * Неизвестная модель остаётся неизвестной, а не превращается в модель без уровней.
 */
function installProviders() {
  setChatProviders({
    /**
     * Модель и её уровни разрешаются из локального общего каталога.
     * Отсутствующая запись не подменяется пустым списком уровней.
     */
    modelOf(value) {
      const id = typeof value === 'object' && value ? value.model : value;
      const provider = refOf(id).provider;
      const model = MODELS[provider]?.find((item) => item.id === id) || null;

      return {
        id,
        model,
        provider: provider ? { id: provider, sessionBinding: provider === 'deepseek' } : null,
      };
    },
  });
}

/**
 * Ворота освобождаются даже при падении assertion, чтобы очередь могла завершиться.
 * Отдельный сигнал запроса позволяет менять выбор в точный момент без sleep.
 */
function gate(releases) {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });

  releases.push(resolve);

  return { promise, resolve };
}

/**
 * Сервер сохраняет полный чат и возвращает конверт saveChat, без выдуманного effort в ACK.
 * Каждый новый store получает собственный транспорт; GET всегда читает реальный диск.
 */
async function fixture(t, { initial = {}, unsaved = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-model-switch-'));
  const history = new ChatHistoryStore({
    chatsDir: path.join(root, 'chats'),
    registryProvider: async () => MODELS,
  });
  const releases = [];
  const windows = [];
  const requests = [];
  const hooks = {};
  const base = {
    id: 'selection-chat',
    model: 'claude-a',
    modelRef: refOf('claude-a'),
    revision: 0,
    effort: 'high',
    mode: 'auto',
    title: 'Проверка выбора',
    messages: [],
    steps: [],
    draft: '',
    createdAt: 1,
    updatedAt: 1,
    ...initial,
  };

  /**
   * Конверт повторяет публичный ответ PUT; сами значения приходят из saveOne.
   * Смена revision и решение stale принадлежат серверу, не фикстуре.
   */
  async function put(body) {
    const result = await history.saveOne(body.chat, !!body.archived);
    const saved = result.chat;

    return {
      ok: true,
      written: result.written,
      restored: result.restored,
      dropped: result.dropped,
      stale: result.stale,
      revision: saved?.revision ?? null,
      schema: saved?.schema ?? null,
      surface: saved?.surface ?? null,
      modelRef: saved?.modelRef ?? null,
      modelRefState: saved?.modelRefState ?? null,
      workdir: saved?.workdir,
      taskId: saved?.taskId ?? null,
      workdirState: saved?.workdirState,
    };
  }

  if (!unsaved) {
    await put({ chat: base });
  }

  /**
   * Приватный транспорт окна не делит apiHarness с соседним store.
   * Перехваты запросов применяются только там, где сценарию нужны управляемые гонки.
   */
  function transport() {
    return {
      /**
       * История и сверка читаются с диска, active/pending управляет тест.
       * GET-конверт совпадает с публичным маршрутом одного чата.
       */
      async get(url) {
        requests.push({ method: 'GET', url });

        if (url === '/api/chat/store') {
          return {
            sessions: [await history.readOne(base.id)],
            archived: [],
            activeId: base.id,
          };
        }
        if (url === `/api/chat/store/chat/${base.id}`) {
          const answer = { chat: await history.readOne(base.id) };

          return hooks.get ? hooks.get(answer) : answer;
        }
        if (url === '/api/chat/pending') {
          return { pending: hooks.pending || [] };
        }

        return { active: [] };
      },
      /**
       * Мета отделена от записи чата, как в реальном API.
       * Ворота удерживают ACK уже сохранённого снимка, а не сам выбор в окне.
       */
      async put(url, body) {
        if (url === '/api/chat/store/meta') {
          return { ok: true };
        }

        requests.push({
          method: 'PUT',
          url,
          chat: copy(body.chat),
        });

        const answer = await put(body);

        return hooks.ack ? hooks.ack(answer, body) : answer;
      },
      /**
       * Reset действительно поднимает серверную ревизию через patchExecution.
       * Ответ синтетического хода можно удержать до сохранения нового выбора.
       */
      async post(url, body) {
        requests.push({
          method: 'POST',
          url,
          body: copy(body),
        });

        if (url === '/api/chat/session/reset') {
          await history.patchExecution(body.chatKey, () => ({ executionRunId: null, sessionId: null }));

          return { ok: true, reset: true };
        }

        assert.equal(url, '/api/chat');

        return hooks.post ? hooks.post(body) : { reply: 'Ответ', effort: body.effort };
      },
      async del(url) {
        requests.push({ method: 'DELETE', url });

        if (url.startsWith('/api/chat/pending/')) {
          hooks.pending = [];
        }

        return { ok: true };
      },
    };
  }

  /**
   * Повторное открытие читает серверную историю как F5, без runtime-намерений старого окна.
   * Каталог восстанавливается после импорта: chatStoreFixture ставит свой реестр.
   */
  async function open(fromServer = false) {
    const seed = unsaved && !fromServer ? base : await history.readOne(base.id);
    const chat = await chatStoreFixture({ sessions: [copy(seed)], activeId: base.id }, {
      api: transport(),
      fromServer,
    });

    installProviders();
    windows.push(chat);

    return chat;
  }

  t.after(async () => {
    releases.forEach((release) => release());
    delete hooks.ack;
    delete hooks.get;

    for (const chat of windows) {
      await chat._writeChat(base.id).catch(() => {});
      chat.$dispose();
    }

    setChatProviders(null);
    await fs.rm(root, { recursive: true, force: true });
  });

  const chat = await open();

  return {
    chat,
    live: chat.sessions[0],
    history,
    hooks,
    requests,
    open,
    put,
    read: () => history.readOne(base.id),
    gate: () => gate(releases),
  };
}

/**
 * Принудительно снимает только debounce, сохраняя обычный путь автосохранения и его CAS.
 * Хвост очереди ждём явно: один ACK не означает завершения следующего снимка.
 */
async function flush(chat) {
  chat._persist(true);
  await chat._writeChat('selection-chat');
}

/**
 * Сверяет окно, GET, F5 и второе независимое окно с одним ожидаемым выбором.
 * Перезагрузка проверяет сохранённое поведение, а не только локальный объект Pinia.
 */
async function assertSaved(f, expected) {
  const disk = await f.read();
  const fresh = await f.open(true);
  const other = await f.open(true);

  for (const [key, value] of Object.entries(expected)) {
    for (const actual of [f.live, disk, fresh.sessions[0], other.sessions[0]]) {
      assert.deepEqual(key === 'effort' ? effortOf(actual) : actual[key], value, `поле ${key}`);
    }
  }
}

test('MS-B1: stale сохраняет чужие model/effort/mode и историю', async (t) => {
  const f = await fixture(t);
  const old = await f.read();
  const current = {
    ...old,
    model: 'claude-b',
    modelRef: refOf('claude-b'),
    effort: 'low',
    mode: 'plan',
    messages: [{ role: 'assistant', text: 'Ответ из другого окна' }],
  };

  await f.put({ chat: current });

  const answer = await f.put({ chat: {
    ...old,
    draft: 'Мой черновик',
    messages: [{ role: 'user', text: 'Старый вопрос' }],
  } });
  const disk = await f.read();

  assert.equal(answer.stale, true);
  assert.deepEqual(disk.modelRef, current.modelRef);
  assert.equal(disk.effort, current.effort);
  assert.equal(disk.mode, current.mode);
  assert.equal(disk.draft, 'Мой черновик');
  assert.ok(disk.messages.some((message) => message.text === 'Ответ из другого окна'));
  assert.ok(disk.messages.some((message) => message.text === 'Старый вопрос'));
});

test('MS-B2: чистое окно принимает чужие настройки через SSE', async (t) => {
  const f = await fixture(t);
  const expected = {
    modelRef: refOf('claude-b'),
    effort: 'low',
    mode: 'plan',
  };
  const arrived = f.gate();

  await f.history.patchExecution(f.live.id, () => expected);
  f.hooks.get = (answer) => {
    arrived.resolve();

    return answer;
  };
  sseOf(f.chat)('chat-store', {
    id: f.live.id,
    archived: false,
    origin: 'другое-окно',
  });
  await arrived.promise;
  await new Promise(setImmediate);

  assert.equal(f.chat.activeId, f.live.id);
  await assertSaved(f, expected);
});

for (const model of ['claude-b', 'catalog-not-loaded']) {
  test(`MS-B3: high сохраняется при выборе ${model}`, async (t) => {
    const f = await fixture(t);

    f.chat.setModel(f.live.id, model);

    assert.equal(f.live.effort, 'high');
  });
}

for (const messages of [[], [{ role: 'user', text: 'Вопрос' }, { role: 'assistant', text: 'Ответ' }]]) {
  test(`MS-01: reset сохраняет новую модель, ходов ${messages.length}`, async (t) => {
    const f = await fixture(t, {
      initial: {
        model: 'ds-test',
        modelRef: refOf('ds-test'),
        sessionId: 'old-binding',
        messages,
      },
    });

    assert.equal(await f.chat.resetContext(f.live.id), true);
    f.chat.setModel(f.live.id, 'claude-a');
    await flush(f.chat);

    await assertSaved(f, { modelRef: refOf('claude-a') });
    assert.deepEqual(f.live.messages.filter((message) => message.role !== 'note'), messages);
  });
}

for (const unsaved of [true, false]) {
  test(`MS-02: выбор во время PUT переживает старый ACK, первый PUT ${unsaved}`, async (t) => {
    const f = await fixture(t, { unsaved });
    const entered = f.gate();
    const release = f.gate();
    let first = true;

    f.hooks.ack = async (answer) => {
      if (first) {
        first = false;
        entered.resolve();
        await release.promise;
      }

      return answer;
    };
    f.chat.setDraft(f.live.id, 'Черновик в полёте');

    const writing = f.chat._writeChat(f.live.id);

    await entered.promise;
    f.chat.setModel(f.live.id, 'claude-b');
    release.resolve();
    await writing;

    assert.deepEqual(f.live.modelRef, refOf('claude-b'), 'старый ACK не меняет селект');
    await flush(f.chat);
    await assertSaved(f, { modelRef: refOf('claude-b'), draft: 'Черновик в полёте' });
    assert.deepEqual(f.requests.filter((r) => r.method === 'PUT').at(-1).chat.modelRef, refOf('claude-b'));
  });
}

test('MS-02c: подтверждение промежуточной модели не отменяет следующую', async (t) => {
  const f = await fixture(t);
  const entered = f.gate();
  const release = f.gate();
  let first = true;

  f.hooks.ack = async (answer) => {
    if (first) {
      first = false;
      entered.resolve();
      await release.promise;
    }

    return answer;
  };
  f.chat.setModel(f.live.id, 'claude-b');

  const writing = f.chat._writeChat(f.live.id);

  await entered.promise;
  f.chat.setModel(f.live.id, 'claude-c');
  release.resolve();
  await writing;
  await f.history.patchExecution(f.live.id, () => ({ sessionId: 'server-turn' }));
  await flush(f.chat);

  await assertSaved(f, { modelRef: refOf('claude-c') });
});

for (const model of ['claude-a', 'claude-empty']) {
  test(`MS-03: несовместимый effort сохраняется как default на ${model}`, async (t) => {
    const f = await fixture(t, { initial: {
      model: 'ds-test',
      modelRef: refOf('ds-test'),
      effort: 'off',
    } });

    assert.equal(await f.chat.resetContext(f.live.id), true);
    f.chat.setModel(f.live.id, model);

    const normalizedBySelection = effortOf(f.live) === '';

    if (model === 'claude-a') {
      // Уже существующая нормализация ChatSession: здесь проверяется её запись после reset.
      // Модель с efforts=[] отдельно проверяет перенос нормализации в общий setter.
      f.chat.setEffort(f.live.id, '');
    }

    assert.equal(effortOf(f.live), '', 'известная новая модель не поддерживает off');
    assert.equal(f.chat.defEffort || '', '');
    await flush(f.chat);
    await assertSaved(f, { effort: '', modelRef: refOf(model) });
    assert.equal(normalizedBySelection, true, 'setModel сам снимает несовместимый уровень');
  });
}

for (const cause of ['turn', 'reset']) {
  for (const fields of ['effort', 'mode', 'both']) {
    test(`MS-04: настройка после серверной записи сохраняется: ${cause}, ${fields}`, async (t) => {
      const f = await fixture(t);

      if (cause === 'reset') {
        assert.equal(await f.chat.resetContext(f.live.id, { note: false }), true);
      } else {
        await f.history.patchExecution(f.live.id, () => ({ sessionId: 'server-turn' }));
      }

      const expected = {};

      if (fields !== 'mode') {
        f.chat.setEffort(f.live.id, 'max');
        expected.effort = 'max';
      }
      if (fields !== 'effort') {
        f.chat.setMode(f.live.id, 'plan');
        expected.mode = 'plan';
      }

      const getsBefore = f.requests.filter((r) => r.method === 'GET').length;

      await flush(f.chat);

      const getsAfter = f.requests.filter((r) => r.method === 'GET').length;

      await assertSaved(f, expected);
      assert.equal(getsAfter - getsBefore, 1, 'одно stale требует ровно один GET полного чата');
    });
  }
}

test('MS-04: повтор после GET выдерживает ещё одну серверную запись', async (t) => {
  const f = await fixture(t);
  let extraPatch = false;

  await f.history.patchExecution(f.live.id, () => ({ sessionId: 'turn-1' }));
  f.hooks.get = async (answer) => {
    if (!extraPatch) {
      extraPatch = true;
      await f.history.patchExecution(f.live.id, () => ({ sessionId: 'turn-2' }));
    }

    return answer;
  };
  f.chat.setEffort(f.live.id, 'max');
  f.chat.setMode(f.live.id, 'plan');
  await flush(f.chat);

  await assertSaved(f, { effort: 'max', mode: 'plan' });
  assert.equal(extraPatch, true);
});

for (const scenario of ['draft', 'separate', 'conflict']) {
  test(`MS-08: rebase не перезаписывает чужие настройки: ${scenario}`, async (t) => {
    const f = await fixture(t);
    const remote = scenario === 'draft'
      ? {
        modelRef: refOf('claude-b'),
        effort: 'low',
        mode: 'plan',
      }
      : { effort: scenario === 'conflict' ? 'low' : 'high', mode: 'plan' };

    f.chat.setDraft(f.live.id, 'Мой несохранённый текст');

    if (scenario !== 'draft') {
      f.chat.setEffort(f.live.id, 'max');
    }

    await f.history.patchExecution(f.live.id, () => remote);
    await flush(f.chat);

    await assertSaved(f, {
      ...remote,
      effort: scenario === 'separate' ? 'max' : remote.effort,
      draft: 'Мой несохранённый текст',
    });
  });
}

test('MS-09: stale автосохранения не даёт свежую CAS до сверки', async (t) => {
  const f = await fixture(t);
  const entered = f.gate();
  const release = f.gate();
  const revision = f.live.revision;

  await f.history.patchExecution(f.live.id, () => ({ effort: 'low' }));
  f.chat.setDraft(f.live.id, 'Черновик');
  f.chat.setMode(f.live.id, 'plan');
  f.chat.setModel(f.live.id, 'claude-b');
  f.hooks.get = async () => {
    entered.resolve(true);
    await release.promise;

    throw new Error('Управляемый отказ GET');
  };

  const writing = f.chat._writeChat(f.live.id);
  const observed = await Promise.race([entered.promise, writing.then(() => false)]);

  assert.equal(observed, true, 'stale должен начать GET, а не считаться сохранённым');
  assert.deepEqual(f.live.modelRef, refOf('claude-b'));
  assert.equal(f.live.revision, revision);
  release.resolve();
  await assert.rejects(writing, /Управляемый отказ GET/);
  assert.equal(f.live.revision, revision);
  assert.equal(f.chat._dirty(f.live), true);

  delete f.hooks.get;
  await flush(f.chat);
  await assertSaved(f, {
    modelRef: refOf('claude-b'),
    effort: 'low',
    mode: 'plan',
    draft: 'Черновик',
  });
});

for (const delivery of ['send', 'pending', 'pending-f5']) {
  test(`MS-05: окончание хода не меняет сохранённый выбор: ${delivery}`, async (t) => {
    const f = await fixture(t);
    let target = f.chat;
    let sending;
    const entered = f.gate();
    const release = f.gate();

    if (delivery === 'send') {
      f.hooks.post = async () => {
        entered.resolve();

        return release.promise;
      };
      sending = f.chat.send(f.live.id, 'Вопрос');
      await entered.promise;
    }

    f.chat.setEffort(f.live.id, 'max');
    await flush(f.chat);
    assert.equal((await f.read()).effort, 'max', 'выбор сохранён до конца ответа');

    if (delivery === 'pending-f5') {
      target = await f.open(true);
    }
    if (delivery === 'send') {
      release.resolve({
        reply: 'Ответ',
        effort: 'high',
        model: 'claude-a',
      });
      await sending;
    } else {
      f.hooks.pending = [{
        id: 'old-turn',
        chatKey: f.live.id,
        reply: 'Ответ',
        effort: 'high',
        model: 'claude-a',
      }];
      await target._collectPending();
    }

    const session = target.sessions[0];

    assert.equal(session.effort, 'max', 'actual effort старого хода не настройка следующего');
    assert.equal(session.messages.find((message) => message.role === 'assistant').effort, 'high');
    await flush(target);
    assert.equal((await f.read()).effort, 'max');
  });
}

for (const delivery of ['send', 'pending-f5']) {
  test(`MS-06: окончание старой модели не возвращает чужую ступень: ${delivery}`, async (t) => {
    const f = await fixture(t, { initial: { effort: 'max' } });
    const entered = f.gate();
    const release = f.gate();
    let sending;

    if (delivery === 'send') {
      f.hooks.post = async () => {
        entered.resolve();

        return release.promise;
      };
      sending = f.chat.send(f.live.id, 'Старый вопрос');
      await entered.promise;
    }

    f.chat.setModel(f.live.id, 'claude-b');
    // Нормализация интерфейса уже существует; этот тест изолирует именно конец хода.
    f.chat.setEffort(f.live.id, '');
    await flush(f.chat);

    const target = delivery === 'send' ? f.chat : await f.open(true);

    if (delivery === 'send') {
      release.resolve({
        reply: 'Ответ A',
        model: 'claude-a',
        effort: 'max',
      });
      await sending;
    } else {
      f.hooks.pending = [{
        id: 'model-a-turn',
        chatKey: f.live.id,
        reply: 'Ответ A',
        model: 'claude-a',
        effort: 'max',
      }];
      await target._collectPending();
    }

    const session = target.sessions[0];

    assert.equal(effortOf(session), '');
    assert.deepEqual(session.modelRef, refOf('claude-b'));
    assert.equal(session.messages.find((message) => message.role === 'assistant').effort, 'max');
    f.hooks.post = async () => ({ reply: 'Ответ B' });
    await target.send(session.id, 'Следующий вопрос');

    const post = f.requests.filter((request) => request.url === '/api/chat').at(-1);

    assert.equal(post.body.effort, '');
    assert.deepEqual(post.body.modelRef, refOf('claude-b'));
  });
}
