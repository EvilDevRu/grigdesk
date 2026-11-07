import { historyWindow, historyPrefixHash } from '../../../server/src/lib/chat/historyWindow.ts';
import { createHash } from 'node:crypto';

/**
 * Фикстура передаёт только поля каталога, без сообщений и шагов полной истории.
 * Версия зависит от содержимого: одна и та же запись имеет одну версию в list и detail.
 */
export function protocolHead(chat) {
  const messages = chat.messages || [];
  const last = messages.at(-1);
  const head = {
    id: chat.id,
    version: createHash('sha256').update(JSON.stringify(chat)).digest('hex'),
    previewSource: String(chat.draft || last?.text || '').slice(0, 1024),
    hasDraft: !!chat.draft || !!chat.draftAttachments?.length,
    hasContent: !!messages.length || !!chat.draft || !!chat.draftAttachments?.length,
    pendingDelivery: messages.some((message) => message.delivery === 'sending'),
    lastReply: null,
  };

  for (const key of ['title', 'purpose', 'taskId', 'logicalIdentity', 'model', 'modelRef',
    'unread', 'archived', 'createdAt', 'updatedAt', 'closedAt', 'revision']) {
    if (chat[key] !== undefined) {
      head[key] = chat[key];
    }
  }

  return head;
}

/**
 * Прежние полные данные сценария становятся отдельным лёгким каталогом.
 * Невалидные контейнеры сохраняются для проверок ошибок decoder.
 */
export function protocolList(value) {
  if (!value || !Array.isArray(value.sessions) || !Array.isArray(value.archived)) {
    return value;
  }

  return {
    ...value,
    listProtocol: 1,
    sessions: value.sessions.map(protocolHead),
    archived: value.archived.map((chat) => ({ ...protocolHead(chat), archived: true })),
  };
}

/**
 * Полные pending доступны только для явно загруженных лент, как в серверном reconcile.
 * Неверная очередь не исправляется фикстурой и остаётся входом проверки decoder.
 */
export function protocolReconcile(value = { pending: [] }, loadedIds = []) {
  return {
    heads: [],
    gone: [],
    deliveries: [],
    ...value,
    pending: Array.isArray(value.pending)
      ? value.pending.filter((entry) => loadedIds.includes(entry.chatKey)) : value.pending,
  };
}

/**
 * Дельта сравнивает непрозрачные версии, переданные окном, с тем же каталогом.
 * Исчезновение возвращается только для известных id, как в серверном контракте.
 */
export function protocolChanges(store, known = {}, onlyKnown = false) {
  const catalog = protocolList(store);
  const heads = [...catalog.sessions, ...catalog.archived];

  return {
    ...catalog,
    sessions: catalog.sessions.filter((head) => (!onlyKnown || head.id in known)
      && known[head.id] !== head.version),
    archived: catalog.archived.filter((head) => (!onlyKnown || head.id in known)
      && known[head.id] !== head.version),
    summary: protocolSummary(store),
    gone: Object.keys(known).filter((id) => !heads.some((head) => head.id === id)),
  };
}

/**
 * Барьер хранит прежнюю управляемую очередь, а транспорт выполняет настоящий POST reconcile.
 * Остальные POST проходят в исходную подмену, порядок PUT и DELETE остаётся наблюдаемым.
 */
export function reconcileWith(post, readPending) {
  return async (url, body, options) => {
    if (url === '/api/chat/store/reconcile') {
      return protocolReconcile(await readPending('/api/chat/pending'), body.loadedIds);
    }

    return post(url, body, options);
  };
}

/**
 * Браузерные фикстуры обслуживают каталог и адресные чтения из одной синтетической истории.
 * Набор маршрутов не отправляет полные сообщения при входе или сверке.
 */
export function protocolRoutes(store) {
  const complete = { archived: [], ...store };
  const catalog = protocolList(complete);
  const routes = {
    '/api/chat/store/list': catalog,
    '/api/chat/store/list?page=1&archived=0&limit=40': protocolPage(complete),
    '/api/chat/store/changes': {
      ...catalog,
      sessions: [],
      archived: [],
      gone: [],
    },
    '/api/chat/store/reconcile': protocolReconcile(),
  };

  for (const chat of [...complete.sessions, ...complete.archived]) {
    const head = protocolHead(chat);

    routes[`/api/chat/store/head/${chat.id}`] = { head };
    routes[`/api/chat/store/chat/${chat.id}`] = { chat, version: head.version };
    routes[`/api/chat/store/chat/${chat.id}?window=1`] = protocolWindow(chat, `http://fixture?window=1`);
  }

  return routes;
}

/**
 * Поиск браузерной фикстуры читает ту же синтетическую историю, что detail и каталог.
 * Сохраняется исходное окно текста вокруг совпадения, без обращения к живому серверу.
 */
export function protocolSearch(store, query, archived) {
  const matches = [];
  const chats = archived ? store.archived || [] : store.sessions;
  const value = query.trim().toLowerCase();

  for (const chat of chats) {
    const message = (chat.messages || []).find((entry) => (
      String(entry.text || '').toLowerCase().includes(value)
    ));

    if (message) {
      const text = String(message.text || '');
      const index = text.toLowerCase().indexOf(value);

      matches.push({
        id: chat.id,
        snippetSource: (index > 24 ? '…' : '') + text.slice(Math.max(0, index - 24), index + 72),
      });
    } else if (String(chat.title || '').toLowerCase().includes(value)) {
      matches.push({ id: chat.id, snippetSource: '' });
    }
  }

  return { matches };
}

/**
 * Новая выдача ограничивает карточки одним scope и отдельным cursor.
 * Полная история остаётся только в синтетическом серверном источнике.
 */
export function protocolPage(store, url = '/api/chat/store/list?page=1&archived=0&limit=40') {
  if (!store || !Array.isArray(store.sessions) || !Array.isArray(store.archived)) {
    return store;
  }

  const params = new URL(url, 'http://fixture').searchParams;
  const archived = params.get('archived') === '1';
  const query = params.get('q') || '';
  const matches = protocolSearch(store, query, archived).matches;
  const allowed = new Set(matches.map((match) => match.id));
  const source = archived ? store.archived : store.sessions;
  const filtered = query ? source.filter((chat) => allowed.has(chat.id)) : source;
  const offset = Number(params.get('cursor') || 0);
  const heads = filtered.slice(offset, offset + 40).map(protocolHead);

  return {
    ...store,
    sessions: archived ? [] : heads,
    archived: archived ? heads : [],
    listProtocol: 2,
    historyWindowProtocol: 1,
    page: {
      nextCursor: offset + 40 < filtered.length ? String(offset + 40) : null,
      hasMore: offset + 40 < filtered.length,
    },
    summary: protocolSummary(store),
    matches: query ? matches.filter((match) => heads.some((head) => head.id === match.id)) : [],
  };
}

/**
 * Агрегат относится ко всему каталогу, независимо от размера страницы.
 * Версия фикстуры меняется вместе с содержимым синтетических записей.
 */
export function protocolSummary(store) {
  return {
    active: store.sessions.length,
    archived: store.archived.length,
    unread: [...store.sessions, ...store.archived].filter((chat) => chat.unread).length,
    waiting: 0,
    epoch: 'fixture',
    sequence: 0,
  };
}

/**
 * Detail использует настоящий алгоритм ограниченного окна.
 * Версия остаётся общей с карточкой того же исходного разговора.
 */
export function protocolWindow(chat, url) {
  const params = new URL(url, 'http://fixture').searchParams;

  return {
    ...historyWindow(chat, params.get('before') || ''),
    version: protocolHead(chat).version,
  };
}

/**
 * Синтетический writer подтверждает ровно отправленное окно и его границу.
 * Фикстура не имитирует потерю ACK, пока сценарий явно её не задаст.
 */
export function protocolWindowAck(body) {
  if (!body.window) {
    return { ok: true };
  }

  return {
    ok: true,
    window: {
      ...body.window,
      baseEnd: body.window.offset + body.chat.messages.length,
      baseHash: historyPrefixHash(body.chat.messages, body.chat.messages.length),
      before: null,
      hasOlder: false,
    },
  };
}
