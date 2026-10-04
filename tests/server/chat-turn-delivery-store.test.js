// Доставка хода от окна до исполнителя и обратно: НАСТОЯЩИЙ стор чата (как в браузере)
// разговаривает с НАСТОЯЩИМ модулем чата через inject, события SSE раздаёт тест.
// Проверяются исходы, которые раньше давали «реплику без исполнителя» или двойной
// запуск: F5 до приёма, потерянный ответ на приём, обрыв SSE на конце хода, очередь
// одного чата и второе окно.
import assert from 'node:assert/strict';
import test from 'node:test';
import { withChatImageHint } from '../../server/src/lib/chat/imageHint.ts';

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

    log.push({
      method,
      url,
      verdict,
      replyIds,
    });

    if (verdict === 'before') {
      throw new TypeError('Failed to fetch');
    }

    let response;

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
  async function openWindow() {
    const transport = windowApi(fixture.app);
    const chat = await chatStoreFixture({}, { api: transport.api, fromServer: true });
    const view = {
      chat,
      transport,
      online: true,
      sse: sseOf(chat),
    };

    windows.add(view);

    return view;
  }

  return {
    ...fixture,
    ...control,
    openWindow,
    closeWindow(view) {
      windows.delete(view);
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

test('F5 между записью реплики и приёмом: видно «не доставлено», запуск ровно один', async (t) => {
  const w = await world(t);

  await saveChat(w.app, 'f5-chat');

  const first = await w.openWindow();

  first.transport.net.cut = (method, url) => (method === 'POST' && url === '/api/chat' ? 'before' : null);

  await first.chat.send('f5-chat', 'Собери отчёт');

  const durable = await serverChat(w.app, 'f5-chat');
  const saved = durable.messages.at(-1);

  assert.equal(saved.role, 'user');
  assert.ok(saved.turnId, 'реплика уехала в историю вместе с устойчивым id хода');
  assert.equal(saved.delivery, 'sending', 'история честно помнит, что приём ещё не подтверждён');

  // F5: прежнее окно исчезло вместе со своими повторами.
  w.closeWindow(first);

  const reloaded = await w.openWindow();
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

  const view = await w.openWindow();
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

  const view = await w.openWindow();
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

  const view = await w.openWindow();

  await view.chat.send('sse-chat', 'Длинная задача');
  await w.waitForRuns(1);
  await waitFor(() => view.chat.session('sse-chat').sending, { what: '«думает…» от начала хода' });

  view.online = false;
  w.runs[0].release('Сделано, пока тебя не было');
  await waitFor(async () => (await serverPending(w.app)).length === 1, { what: 'итог в pending' });
  assert.equal(replies(view.chat, 'sse-chat').length, 0, 'окно без связи ответа пока не видит');

  view.online = true;
  view.sse('hello', { at: Date.now(), bootId: 'boot-same-0001' });
  await waitFor(() => replies(view.chat, 'sse-chat').length === 1, { what: 'ответ после переподключения' });
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

  const left = await w.openWindow();
  const right = await w.openWindow();

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
    await waitFor(() => replies(view.chat, 'seq-chat').length === 4, { what: 'четыре ответа в окне' });
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
      .find((text) => run.message.endsWith(withChatImageHint(text)))),
    ['раз', 'два', 'три', 'четыре'],
    'исполнитель получил сообщения в порядке отправки',
  );
});
