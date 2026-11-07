// Доставка хода от окна до исполнителя и обратно: НАСТОЯЩИЙ стор чата (как в браузере)
// разговаривает с НАСТОЯЩИМ модулем чата через inject, события SSE раздаёт тест.
// Проверяются исходы, которые раньше давали «реплику без исполнителя» или двойной
// запуск: F5 до приёма, потерянный ответ на приём, обрыв SSE на конце хода, очередь
// одного чата и второе окно.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import test from 'node:test';
import { withChatImageHint } from '../../server/src/lib/chat/imageHint.ts';
import { ChatHistoryStore } from '../../server/src/lib/chat/historyStore.ts';

import { chatStoreFixture, sseOf } from '../web/helpers/chat-store.js';
import {
  chatAppFixture,
  controlledExecutor,
  saveChat,
  waitFor,
} from './helpers/chat-turns.js';

/**
 * Сеть одного окна поверх inject. `cut(method, url)` решает судьбу запроса:
 * 'before' — не дошёл до сервера, 'after' — сервер обработал, ответ потерян.
 */
function windowApi(app, log = []) {
  const net = { cut: () => null, dead: false };

  // Один запрос окна: журнал для проверок порядка, решение сети, затем inject и разбор
  // ответа как у apiClient (ошибка с status и data вместо HTTP-ответа).
  async function call(method, url, body) {
    // Закрытая вкладка ничего не отправляет и ответов не ждёт: её запросы просто висят.
    if (net.dead) {
      return new Promise(() => {});
    }

    const verdict = net.cut(method, url, body);
    const replyIds = (body?.chat?.messages || [])
      .filter((message) => message.role === 'assistant' && message.pid)
      .map((message) => message.pid);

    const entry = {
      method,
      url,
      verdict,
      replyIds,
    };

    log.push(entry);

    if (verdict === 'before') {
      throw new TypeError('Failed to fetch');
    }

    let response;
    const started = performance.now();

    try {
      response = await app.inject({
        method,
        url,
        ...(body === undefined ? {} : { payload: body }),
      });
    } catch (error) {
      // Сервер теста уже остановлен, а окно ещё дописывает историю: как у закрытой
      // вкладки, запрос просто повисает, и повторы не держат процесс теста.
      if (/already been closed/.test(String(error?.message))) {
        return new Promise(() => {});
      }

      throw error;
    }

    if (verdict === 'after') {
      throw new TypeError('Failed to fetch');
    }

    const data = response.body ? JSON.parse(response.body) : null;

    entry.ackMs = performance.now() - started;
    entry.status = response.statusCode;

    if (response.statusCode >= 400) {
      const error = new Error(data?.message || data?.error || `HTTP ${response.statusCode}`);

      error.name = 'ApiError';
      error.status = response.statusCode;
      error.data = data;

      throw error;
    }

    return data;
  }

  return {
    net,
    log,
    api: {
      get: (url) => call('GET', url),
      post: (url, body) => call('POST', url, body),
      put: (url, body) => call('PUT', url, body),
      patch: (url, body) => call('PATCH', url, body),
      del: (url, body) => call('DELETE', url, body),
    },
  };
}

/**
 * Сервер и окна: события SSE доходят только до окон «на связи» и асинхронно, как по
 * сети. Окно открывается, как после F5, — загрузкой истории с сервера.
 */
async function world(t) {
  const windows = new Set();
  const control = controlledExecutor();

  t.after(() => {
    for (const view of windows) {
      view.surface?.dispose();
      view.chat.$dispose();
      view.transport.net.dead = true;
    }
  });

  const fixture = await chatAppFixture(t, {
    executor: control.executor,
    // Раздать событие окнам на связи: копия JSON, как у настоящего SSE, и доставка
    // следующим тиком, чтобы обработчик окна не выполнялся внутри broadcast сервера.
    onEvent(event, data) {
      const copy = data === undefined ? undefined : JSON.parse(JSON.stringify(data));

      for (const view of windows) {
        if (view.online) {
          setImmediate(() => view.sse(event, copy));
        }
      }
    },
  });

  // Новое окно: свой транспорт, история с сервера и подписка на общий поток событий.
  // Окно сразу «на связи» — его можно отключить полем online.
  async function openWindow(chatId) {
    const transport = windowApi(fixture.app);
    const chat = await chatStoreFixture({}, { api: transport.api, fromServer: true });
    const view = {
      chat,
      transport,
      online: true,
      sse: sseOf(chat),
    };

    windows.add(view);

    if (chatId) {
      view.surface = chat.registerSurface(view, { chatId, visible: true });
      await chat.ensureChatMessages?.(chatId);
    }

    return view;
  }

  return {
    ...fixture,
    ...control,
    openWindow,
    /**
     * Закрытие окна снимает поверхность и таймеры до остановки тестового сервера.
     * Прежняя сеть становится недоступна и не возобновляет доставку после F5.
     */
    closeWindow(view) {
      windows.delete(view);
      view.surface?.dispose();
      view.chat.$dispose();
      view.transport.net.dead = true;
    },
  };
}

async function serverChat(app, id) {
  return (await app.inject({ method: 'GET', url: `/api/chat/store/chat/${id}` })).json().chat;
}

async function serverPending(app) {
  return (await app.inject({ method: 'GET', url: '/api/chat/pending' })).json().pending;
}

function replies(chat, id) {
  return (chat.session ? chat.session(id) : chat)?.messages?.filter((m) => m.role === 'assistant') || [];
}

const settle = () => new Promise((resolve) => {
  setTimeout(resolve, 20);
});

test('ENOSPC при подготовке инструментов завершает ход в окне и позволяет новый запуск', async (t) => {
  const w = await world(t);
  const id = 'preparation-error-chat';

  w.executor.workToolsTransport = 'mcp';
  await saveChat(w.app, id);

  const view = await w.openWindow(id);
  const mkdtemp = fs.mkdtemp;
  const failure = Object.assign(new Error('ENOSPC: no space left on device, mkdtemp'), {
    code: 'ENOSPC',
  });
  const mock = t.mock.method(fs, 'mkdtemp', (prefix, ...args) => {
    if (String(prefix).includes('grigdesk-work-')) {
      return Promise.reject(failure);
    }

    return mkdtemp(prefix, ...args);
  });

  await view.chat.send(id, 'Проверь временные файлы');
  await waitFor(() => view.chat.session(id).messages.some((message) => message.role === 'error'));
  await settle();

  const session = view.chat.session(id);
  const error = session.messages.find((message) => message.role === 'error');
  const turnId = session.messages.find((message) => message.role === 'user').turnId;
  const done = w.events.filter((entry) => entry.event === 'chat-done' && entry.data.turnId === turnId);

  assert.equal(done.length, 1, 'подготовка тоже обязана послать конец хода');
  assert.equal(session.sending, false, 'после ошибки агент не остаётся работающим');
  assert.match(error.text, /недостаточно места/i);
  assert.match(error.text, /освободите/i);
  assert.match(error.text, /ENOSPC/);
  assert.equal(w.runs.length, 0, 'ошибка подготовки не запускает исполнителя');
  assert.deepEqual((await w.app.inject('/api/chat/active')).json().active, []);

  mock.mock.restore();
  await view.chat.send(id, 'Место освобождено, проверь снова');
  await w.waitForRuns(1);
  w.runs[0].release('Запуск восстановлен');
  await waitFor(() => replies(view.chat, id).some((message) => message.text === 'Запуск восстановлен')
    && !view.chat.session(id).sending);
  assert.equal(w.runs.length, 1);
});

test('ошибка подготовки из очереди снимает работу после предыдущего успешного хода', async (t) => {
  const w = await world(t);
  const id = 'queued-preparation-chat';

  await saveChat(w.app, id);

  const view = await w.openWindow(id);

  await view.chat.send(id, 'Первое сообщение');
  await w.waitForRuns(1);

  w.executor.workToolPolicy = () => {
    throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  };

  await view.chat.send(id, 'Второе сообщение');
  w.runs[0].release('Первый ответ');
  await waitFor(() => replies(view.chat, id).length === 1
    && view.chat.session(id).messages.some((message) => message.role === 'error'));
  await settle();
  assert.equal(view.chat.session(id).sending, false);
  assert.equal(w.runs.length, 1);

  const failedDone = w.events.find((entry) => entry.event === 'chat-done' && !entry.data.runId);

  delete w.executor.workToolPolicy;
  await view.chat.send(id, 'Третье сообщение');
  await w.waitForRuns(2);
  view.sse('chat-done', failedDone.data);
  await settle();
  assert.equal(view.chat.session(id).sending, true, 'поздний конец подготовки не гасит новый запуск');
  w.runs[1].release('Третий ответ');
  await waitFor(() => replies(view.chat, id).length === 2 && !view.chat.session(id).sending);
});

test('20 завершённых блоков с серверными записями сохраняются sparse без лишних full PUT', async (t) => {
  const w = await world(t);
  const id = 'live-reuse-chat';
  const historical = [{
    role: 'assistant',
    text: 'Прошлый ответ',
    runId: 'history-run',
    assistantMessageId: 'history-answer',
    steps: [{
      k: 'tool',
      text: 'Неизменяемое тело',
      input: { command: 'history' },
    }],
  }];

  await saveChat(w.app, id, { messages: historical });

  const view = await w.openWindow(id);
  const session = view.chat.session(id);

  await view.chat.send(id, 'Длинный ход с инструментами');
  await w.waitForRuns(1);

  let serverWrite = false;
  let writes = 0;
  const save = ChatHistoryStore.prototype.saveOne;

  t.mock.method(ChatHistoryStore.prototype, 'saveOne', async function (chat, archived, options) {
    if (chat.id === id && serverWrite) {
      serverWrite = false;
      writes += 1;

      // Обе операции используют настоящий per-chat lock того же экземпляра сервера.
      // Метрики становятся durable, пока клиент сохраняет законченный блок.
      const pending = this.patchExecution(id, () => ({ contextTokens: writes }));
      const [, result] = await Promise.all([pending, save.call(this, chat, archived, options)]);

      return result;
    }

    return save.call(this, chat, archived, options);
  });

  const start = view.transport.log.length;

  for (let index = 0; index < 20; index += 1) {
    w.runs[0].options.onStep({
      k: 'tool',
      text: `Инструмент ${index}`,
      at: Date.now(),
    });
    await w.runs[0].options.onAssistantMessage({
      assistantMessageId: `live-block-${String(index).padStart(8, '0')}`,
      text: `Завершённый блок ${index}`,
      sourceRevision: 1,
      complete: true,
    });
    await waitFor(() => session.messages.some((message) => message.text === `Завершённый блок ${index}`));
    serverWrite = true;
    await view.chat._writeChat(id);
  }

  const puts = view.transport.log.slice(start)
    .filter((entry) => entry.method === 'PUT' && entry.url !== '/api/chat/store/meta');
  const durations = puts.map((entry) => entry.ackMs).sort((left, right) => left - right);

  assert.equal(writes, 20);
  assert.ok(puts.length >= 20);
  assert.equal(puts.every((entry) => entry.url === '/api/chat/store/chat/step-reuse'), true);
  assert.equal(puts.every((entry) => entry.status === 200), true);
  assert.deepEqual((await serverChat(w.app, id)).messages[0].steps, historical[0].steps);
  t.diagnostic(`sparse ACK: n=${durations.length}, p95=${durations[Math.ceil(durations.length * 0.95) - 1]
    .toFixed(2)} мс, max=${durations.at(-1).toFixed(2)} мс`);

  w.runs[0].release('Итог');
  await waitFor(() => replies(view.chat, id).some((message) => message.text === 'Итог'));
});

test('F5 между записью реплики и приёмом: видно «не доставлено», запуск ровно один', async (t) => {
  const w = await world(t);

  await saveChat(w.app, 'f5-chat');

  const first = await w.openWindow('f5-chat');

  first.transport.net.cut = (method, url) => (method === 'POST' && url === '/api/chat' ? 'before' : null);

  await first.chat.send('f5-chat', 'Собери отчёт');

  const durable = await serverChat(w.app, 'f5-chat');
  const saved = durable.messages.at(-1);

  assert.equal(saved.role, 'user');
  assert.ok(saved.turnId, 'реплика уехала в историю вместе с устойчивым id хода');
  assert.equal(saved.delivery, 'sending', 'история честно помнит, что приём ещё не подтверждён');

  // F5: прежнее окно исчезло вместе со своими повторами.
  w.closeWindow(first);

  const reloaded = await w.openWindow('f5-chat');
  const session = reloaded.chat.session('f5-chat');

  assert.equal(session.sending, false, 'исполнителя нет — «думает…» не рисуем');
  assert.equal(reloaded.chat.deliveries[saved.turnId]?.state, 'lost',
    'окно после F5 показывает «не доставлено», а не голую реплику');
  assert.equal(w.runs.length, 0);

  await reloaded.chat.retryDelivery('f5-chat', saved.turnId);
  await w.waitForRuns(1);
  // Прежний запрос всё-таки долетел: тот же turnId повторно ничего не запускает.
  const late = await w.app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: {
      chatKey: 'f5-chat',
      turnId: saved.turnId,
      modelRef: durable.modelRef,
      message: 'Собери отчёт',
    },
  });

  assert.equal(late.json().duplicate, true);
  w.runs[0].release('Отчёт готов');

  await waitFor(() => replies(reloaded.chat, 'f5-chat').length === 1, { what: 'ответ в окне' });
  await settle();
  assert.equal(w.runs.length, 1, 'исполнитель запущен ровно один раз');
  assert.equal(replies(reloaded.chat, 'f5-chat').length, 1);

  const user = reloaded.chat.session('f5-chat').messages.find((m) => m.turnId === saved.turnId);

  assert.equal(user.delivery, undefined, 'после приёма отметка доставки снята');
  assert.equal(reloaded.chat.deliveries[saved.turnId], undefined);
  await waitFor(async () => replies(await serverChat(w.app, 'f5-chat')).length === 1, {
    what: 'ответ в устойчивой истории',
  });
});

test('потерянный ACK при оборванном SSE: повтор тем же turnId не запускает ход второй раз', async (t) => {
  const w = await world(t);

  await saveChat(w.app, 'ack-chat');

  const view = await w.openWindow('ack-chat');
  let posts = 0;
  const turnIds = [];

  view.transport.net.cut = (method, url, body) => {
    if (method !== 'POST' || url !== '/api/chat') {
      return null;
    }

    posts += 1;
    turnIds.push(body.turnId);

    return posts === 1 ? 'after' : null;
  };

  // Сеть моргнула целиком: ответ на приём потерян, событий SSE окно тоже не слышит.
  view.online = false;
  await view.chat.send('ack-chat', 'Проверь сборку');

  const message = view.chat.session('ack-chat').messages.at(-1);

  assert.equal(message.delivery, 'sending');
  assert.equal(view.chat.deliveries[message.turnId]?.state, 'retrying',
    'окно честно говорит, что подтверждения нет, и повторяет');
  assert.equal(view.chat.session('ack-chat').sending, false, 'до подтверждения «думает…» не рисуем');
  await w.waitForRuns(1);

  await waitFor(() => message.delivery === undefined, {
    timeoutMs: 4000,
    what: 'подтверждение приёма повтором',
  });
  await settle();
  assert.equal(posts, 2, 'автоматический повтор ушёл сам');
  assert.equal(turnIds[0], turnIds[1], 'повтор несёт тот же turnId, а не новый запуск');
  assert.equal(w.runs.length, 1, 'исполнитель не запущен второй раз');
  assert.equal(view.chat.session('ack-chat').sending, true, 'после подтверждения окно показывает работу');

  view.online = true;
  view.sse('hello', { at: Date.now(), bootId: 'boot-same-0001' });
  w.runs[0].release('Сборка зелёная');
  await waitFor(() => replies(view.chat, 'ack-chat').length === 1, { what: 'ответ' });
  await settle();
  assert.equal(replies(view.chat, 'ack-chat').length, 1);
  assert.equal(w.runs.length, 1);
});

test('потерянный ответ на приём при живом SSE: старт хода подтверждает приём без второго POST', async (t) => {
  const w = await world(t);

  await saveChat(w.app, 'ack-sse-chat');

  const view = await w.openWindow('ack-sse-chat');
  let posts = 0;

  view.transport.net.cut = (method, url) => {
    if (method !== 'POST' || url !== '/api/chat') {
      return null;
    }

    posts += 1;

    return 'after';
  };

  await view.chat.send('ack-sse-chat', 'Проверь сборку');

  const message = view.chat.session('ack-sse-chat').messages.at(-1);

  await waitFor(() => message.delivery === undefined, { what: 'подтверждение по chat-turn-start' });
  await new Promise((resolve) => {
    setTimeout(resolve, 1200);
  });
  assert.equal(posts, 1, 'сервер уже сказал, что ход идёт, — повторять нечего');
  assert.equal(view.chat.deliveries[message.turnId], undefined, 'таймер повтора снят');
  assert.equal(w.runs.length, 1);
  w.runs[0].release('Готово');
  await waitFor(() => replies(view.chat, 'ack-sse-chat').length === 1, { what: 'ответ' });
});

test('ход кончился при оборванном SSE: переподключение без F5 даёт ровно один ответ', async (t) => {
  const w = await world(t);

  await saveChat(w.app, 'sse-chat');

  const view = await w.openWindow('sse-chat');

  await view.chat.send('sse-chat', 'Длинная задача');
  await w.waitForRuns(1);
  await waitFor(() => view.chat.session('sse-chat').sending, { what: '«думает…» от начала хода' });

  view.online = false;
  w.runs[0].release('Сделано, пока тебя не было');
  await waitFor(async () => (await serverPending(w.app)).length === 1, { what: 'итог в pending' });
  assert.equal(replies(view.chat, 'sse-chat').length, 0, 'окно без связи ответа пока не видит');

  view.online = true;
  view.sse('hello', { at: Date.now(), bootId: 'boot-same-0001' });
  await waitFor(() => replies(view.chat, 'sse-chat').length === 1
    && !view.chat.session('sse-chat').sending, { what: 'ответ и завершение хода после переподключения' });
  view.sse('hello', { at: Date.now(), bootId: 'boot-same-0001' });
  view.sse('hello', { at: Date.now(), bootId: 'boot-same-0001' });
  await settle();
  await settle();

  assert.equal(replies(view.chat, 'sse-chat').length, 1, 'повторные hello не дублируют ответ');
  assert.equal(view.chat.session('sse-chat').sending, false, '«думает…» снято без F5');
  await waitFor(async () => (await serverPending(w.app)).length === 0, { what: 'pending подтверждён' });
  assert.equal(replies(await serverChat(w.app, 'sse-chat')).length, 1, 'в общей истории ответ один');

  const turnId = view.chat.session('sse-chat').messages.find((m) => m.role === 'user').turnId;
  const log = view.transport.log;
  const saved = log.findIndex((entry) => entry.method === 'PUT' && entry.replyIds.includes(turnId));
  const acked = log.findIndex((entry) => entry.method === 'DELETE'
    && entry.url === `/api/chat/pending/${turnId}`);

  assert.ok(saved >= 0 && acked > saved,
    'pending подтверждается только после записи ответа в историю');
});

test('несколько сообщений одного чата и второе окно: порядок и ровно один ответ на каждое', async (t) => {
  const w = await world(t);

  await saveChat(w.app, 'seq-chat');

  const left = await w.openWindow('seq-chat');
  const right = await w.openWindow('seq-chat');

  for (const text of ['раз', 'два', 'три']) {
    await left.chat.send('seq-chat', text);
  }

  const sent = left.chat.session('seq-chat').messages.filter((m) => m.role === 'user');

  assert.deepEqual(sent.map((m) => m.delivery), [undefined, undefined, undefined], 'все три приняты');
  assert.deepEqual(sent.map((m) => !!m.queued), [false, true, true], 'второе и третье честно ждут очереди');
  await w.waitForRuns(1);
  await waitFor(() => right.chat.session('seq-chat')?.sending, { what: 'второе окно видит работу' });

  await right.chat.send('seq-chat', 'четыре');

  for (let index = 0; index < 4; index += 1) {
    await w.waitForRuns(index + 1);
    assert.equal(w.runs.length, index + 1);
    w.runs[index].release(`Ответ ${index + 1}`);
  }

  for (const view of [left, right]) {
    await waitFor(() => replies(view.chat, 'seq-chat').length === 4
      && !view.chat.session('seq-chat').sending, { what: 'четыре ответа и завершение хода в окне' });
  }

  await settle();
  await settle();

  for (const view of [left, right]) {
    assert.deepEqual(
      replies(view.chat, 'seq-chat').map((m) => m.text),
      ['Ответ 1', 'Ответ 2', 'Ответ 3', 'Ответ 4'],
    );
    assert.equal(view.chat.session('seq-chat').sending, false);
  }

  await waitFor(async () => replies(await serverChat(w.app, 'seq-chat')).length === 4, {
    what: 'четыре ответа в истории',
  });
  assert.deepEqual(
    replies(await serverChat(w.app, 'seq-chat')).map((m) => m.text),
    ['Ответ 1', 'Ответ 2', 'Ответ 3', 'Ответ 4'],
  );
  assert.deepEqual(
    w.runs.map((run) => ['раз', 'два', 'три', 'четыре']
      .find((text) => run.message.includes(`${text}\n\n[Подсказка GrigDesk: картинки в ответе]`))),
    ['раз', 'два', 'три', 'четыре'],
    'исполнитель получил сообщения в порядке отправки',
  );
});
