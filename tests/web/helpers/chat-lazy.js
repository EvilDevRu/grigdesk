import assert from 'node:assert/strict';

import { chatStoreFixture, sseOf } from './chat-store.js';
import { memoryStorage } from './chat-load.js';
import { listFixture, sampleChat } from '../../server/helpers/chat-list.js';

export const DETAIL = '/api/chat/store/chat/';
export const CATALOG = '/api/chat/store/list';

/**
 * Управляемая голова следует отдельному web-протоколу, без messages и defaults полной сессии.
 * Версия произвольна: это непрозрачное значение, которое клиент обязан передать обратно.
 */
export function headOf(chat, version = 'version-one') {
  return {
    id: chat.id,
    title: chat.title,
    model: chat.model,
    modelRef: chat.modelRef,
    taskId: chat.taskId ?? null,
    purpose: chat.purpose ?? '',
    logicalIdentity: chat.logicalIdentity,
    archived: !!chat.archived,
    unread: !!chat.unread,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    revision: chat.revision,
    closedAt: chat.closedAt,
    previewSource: 'Ответ',
    hasDraft: !!chat.draft,
    hasContent: true,
    pendingDelivery: (chat.messages || []).some((message) => message.delivery === 'sending'),
    lastReply: null,
    version,
  };
}

/**
 * Строит корректную оболочку отдельного web-каталога.
 * Ни одна голова не содержит messages или подтверждения полной ленты.
 */
export function catalog(chats) {
  return {
    listProtocol: 1,
    sessions: chats.filter((chat) => !chat.archived).map((chat) => headOf(chat)),
    archived: chats.filter((chat) => chat.archived).map((chat) => headOf(chat)),
    activeId: chats[0]?.id ?? null,
    turnProtocol: 1,
    inTurnProtocol: 1,
    historyStepReuseProtocol: 1,
  };
}

/**
 * API-double удерживает только управляемый detail; служебные ответы имеют настоящую оболочку.
 * Старый full endpoint тоже отвечает: RED доказывает выбор протокола, а не поломку сети.
 */
export async function lazyWindow(t, {
  chats = [sampleChat()], detail = null, onCall = null, storage = true,
} = {}) {
  if (storage) {
    memoryStorage(t);
  }

  const calls = [];

  const responses = [];

  const data = catalog(chats);

  /**
   * Маршрутизирует запросы только внутри офлайн-фикстуры.
   * Пользовательская подмена может удержать ответ или вернуть HTTP-ошибку.
   */
  async function call(method, url, body, options) {
    calls.push({
      method,
      url,
      body,
      options,
    });

    const custom = await onCall?.({
      method,
      url,
      body,
      options,
    });

    if (custom !== undefined) {
      return custom;
    }
    if (url === CATALOG) {
      return structuredClone(data);
    }
    if (url === '/api/chat/store') {
      return {
        ...data,
        sessions: structuredClone(chats.filter((chat) => !chat.archived)),
        archived: structuredClone(chats.filter((chat) => chat.archived)),
      };
    }
    if (url.startsWith(DETAIL) && method === 'GET') {

      const id = decodeURIComponent(url.slice(DETAIL.length));

      const chat = chats.find((entry) => entry.id === id);

      const result = detail ? await detail(id, options) : {
        chat: structuredClone(chat),
        version: 'version-one',
      };

      responses.push(result);

      return result;
    }
    if (url.startsWith('/api/chat/store/head/')) {
      return { head: headOf(chats.find((chat) => url.endsWith(chat.id))) };
    }
    if (url === '/api/chat/store/changes') {
      return {
        ...data,
        sessions: [],
        archived: [],
        gone: [],
      };
    }
    if (url === '/api/chat/store/reconcile') {
      return {
        pending: [],
        heads: [],
        gone: [],
        deliveries: [],
      };
    }
    if (url === '/api/chat/pending') {
      return { pending: [] };
    }
    if (url.includes('waiting')) {
      return { waiting: [] };
    }

    return {
      active: [],
      ok: true,
    };
  }

  const api = {
    get: (url, options) => call('GET', url, undefined, options),
    post: (url, body, options) => call('POST', url, body, options),
    put: (url, body) => call('PUT', url, body),
    patch: (url, body) => call('PATCH', url, body),
    del: (url) => call('DELETE', url),
  };

  const chat = await chatStoreFixture({}, {
    api,
    fromServer: true,
  });

  t.after(() => {
    chat.loaded = false;
    chat.$dispose();
  });

  return {
    chat,
    calls,
    api,
    data,
    responses,
    sse: sseOf(chat),
  };
}

/**
 * Настоящий HTTP-контракт через inject: журнал хранит и запрос, и полученный ответ.
 * Ошибки статуса превращаются в отказ API, чтобы тест не принял 404 за успешную пустоту.
 */
export function windowApi(app) {

  const calls = [];

  /**
   * Выполняет запрос через настоящий Fastify без сетевого сервиса.
   * Журнал сохраняет результат до преобразования HTTP-ошибки в исключение.
   */
  async function call(method, url, body) {

    const entry = {
      method,
      url,
      body,
    };

    calls.push(entry);

    try {
      const response = await app.inject({
        method,
        url,
        ...(body === undefined ? {} : { payload: body }),
      });

      const data = response.json();

      entry.response = data;

      if (response.statusCode >= 400) {
        throw Object.assign(new Error(data.message || data.error || response.body), {
          name: 'ApiError',
          status: response.statusCode,
          data,
        });
      }

      return data;
    } finally {
      entry.done = true;
    }
  }

  return {
    calls,
    api: {
      get: (url) => call('GET', url),
      post: (url, body) => call('POST', url, body),
      put: (url, body) => call('PUT', url, body),
      patch: (url, body) => call('PATCH', url, body),
      del: (url) => call('DELETE', url),
    },
  };
}

/**
 * Каждое окно владеет своим store и транспортом поверх одного временного сервера.
 * Cleanup сначала останавливает все окна, лишь затем закрывает сервер и удаляет файлы.
 */
export async function serverWorld(t, chats, options = {}) {
  memoryStorage(t);

  const cleanup = [];

  const windows = [];

  const fixture = await listFixture({ after: (fn) => cleanup.push(fn) }, chats, options);

  t.after(async () => {
    for (const view of windows) {
      view.chat.loaded = false;
      view.chat.$dispose();
    }

    for (const fn of cleanup) {
      await fn();
    }
  });

  /**
   * Загружает отдельное окно и сохраняет его для упорядоченной уборки.
   * Полнота не выставляется тестом вручную, её определяет настоящий store.
   */
  async function open(network = windowApi(fixture.app)) {

    const chat = await chatStoreFixture({}, {
      api: network.api,
      fromServer: true,
    });

    const view = {
      ...network,
      chat,
      sse: sseOf(chat),
    };

    windows.push(view);
    assert.equal(chat.loaded, true, 'серверная фикстура загрузила каталог');

    return view;
  }

  return {
    ...fixture,
    open,
  };
}

/**
 * Выбирает только адресные чтения полной ленты нужного чата.
 * Чтения головы и общей меты в этот счётчик не входят.
 */
export function detailReads(calls, id) {
  return calls.filter((call) => call.method === 'GET' && call.url === `${DETAIL}${id}`);
}

/**
 * Вызывает предусмотренный планом публичный барьер загрузки.
 * Отсутствие барьера даёт понятный RED до запуска зависимого сценария.
 */
export async function ensureMessages(chat, id) {
  assert.equal(typeof chat.ensureChatMessages, 'function',
    'адресная загрузка ленты предусмотрена контрактом');

  return chat.ensureChatMessages(id);
}
