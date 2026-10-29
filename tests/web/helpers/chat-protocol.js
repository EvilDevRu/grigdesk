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
export function protocolChanges(store, known = {}) {
  const catalog = protocolList(store);
  const heads = [...catalog.sessions, ...catalog.archived];

  return {
    ...catalog,
    sessions: catalog.sessions.filter((head) => known[head.id] !== head.version),
    archived: catalog.archived.filter((head) => known[head.id] !== head.version),
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
