import type { MobileApp } from '../mobileServer.ts';
import { decodeChat, decodeChats, decodeContract } from '../contract.ts';
import type { ChatProvider, ChatSummary, MobileMessage } from '../contract.ts';
import { getProviderAdapters } from '../../executors/index.ts';
import { MobileChatTurns } from '../chatTurns.ts';
import { MobileInputError } from '../errors.ts';
import { count, paginate, record, resourceId, text, upstream } from './common.ts';
import type { FacadeDeps, Payload } from './common.ts';
import { collectMedia, splitMessageParts } from './messageParts.ts';
import { chatActivity } from './chatActivity.ts';
import { chatSettings } from './chatControls.ts';
import { normalizeModelRef } from '../../chat/modelRef.ts';

/**
 * Времена внутренних записей могут быть числом или ISO-строкой старой истории.
 * Недостоверное значение не превращается в NaN мобильного JSON.
 */
function timestamp(value: unknown): number {
  const time = typeof value === 'number' ? value : Date.parse(String(value || ''));

  return Number.isSafeInteger(time) && time >= 0 ? time : 0;
}

/**
 * Состояние вычисляется по реальному active и queued; ожидания считаются отдельно.
 * Архивный чат остаётся доступен для чтения, его параметры берутся из durable store.
 */
function summary(
  chat: Payload,
  active: Payload,
  waiting: Payload,
  providers: Map<string, ChatProvider>,
): ChatSummary {
  const id = resourceId(chat.id);
  const runs = Array.isArray(active.active) ? active.active.map(record) : [];
  const queued = Array.isArray(active.queued) ? active.queued.map(record) : [];
  const pending = Array.isArray(waiting.waiting) ? waiting.waiting.map(record) : [];
  const provider = providers.get(String(record(chat.modelRef).provider || ''));

  return {
    id,
    title: text(chat.title || (chat.purpose === 'companion' ? 'Компаньон' : 'Разговор'), 800),
    updatedAt: timestamp(chat.updatedAt),
    taskId: chat.taskId == null ? null : String(chat.taskId),
    model: text(chat.model || record(chat.modelRef).model, 200),
    ...(normalizeModelRef(chat.modelRef) ? { modelRef: normalizeModelRef(chat.modelRef)! } : {}),
    unread: chat.unread === true,
    state: runs.some((run) => run.chatKey === id)
      ? 'running'
      : queued.some((turn) => turn.chatKey === id)
        ? 'queued'
        : 'idle',
    waiting: pending.filter((item) => item.chatKey === id).length,
    ...(provider ? { provider } : {}),
    ...(typeof chat.preview === 'string' ? { preview: text(chat.preview, 300) } : {}),
    ...(chat.archived ? { archived: true } : {}),
    ...(chat.purpose ? { purpose: String(chat.purpose) } : {}),
  };
}

/**
 * Общий Компаньон без задачи уже есть и не в архиве: ensure для списка не нужен.
 * Архив, отсутствие или чужая задача оставляют создание/восстановление серверному ensure.
 */
function isLiveCompanion(chat: Payload) {
  return chat.purpose === 'companion' && !chat.archived && chat.taskId == null;
}

/**
 * Ответ ограничивается по размеру целой страницы, сохраняя индекс первого показанного сообщения.
 * Стабильный id назначает server-owned port; позиция массива не является identity реплики.
 */
function messagePage(chat: Payload, query: Payload) {
  const revision = Number(chat.revision || 0);
  const all = Array.isArray(chat.messages) ? chat.messages.map(record) : [];
  const before = count(query.before, all.length, all.length);
  const limit = count(query.limit, 30);

  if (!limit) {
    throw new MobileInputError('bad_request', 'Размер страницы должен быть от 1 до 100.');
  }
  if (
    query.before !== undefined &&
    count(query.revision, -1, Number.MAX_SAFE_INTEGER) !== revision
  ) {
    throw new MobileInputError(
      'history_changed',
      'История изменилась; перечитайте последние сообщения.',
      409,
    );
  }

  const messages: MobileMessage[] = [];
  let index = before;
  let bytes = 160 * 1024;

  while (index > 0 && messages.length < limit) {
    const source = all[index - 1]!;
    const message: MobileMessage = {
      index: index - 1,
      id: text(source.mobileId || source.assistantMessageId || source.turnId || source.pid, 200),
      role: source.role === 'user' ? 'user' : 'assistant',
      turnId: source.turnId ? text(source.turnId, 80) : null,
      clientId: source.clientId ? text(source.clientId, 80) : null,
      at: timestamp(source.sentAt ?? source.at),
      stopped: source.stopped === true,
      error: source.role === 'error' || source.error === true || Boolean(source.interruptedBy),
      parts: splitMessageParts(typeof source.text === 'string' ? source.text : ''),
      media: collectMedia(source),
      ...(Array.isArray(source.steps) ? { activity: chatActivity(source.steps) } : {}),
    };
    const size = Buffer.byteLength(JSON.stringify(message));

    if (bytes + size > 2 * 1024 * 1024) {
      break;
    }

    bytes += size;
    messages.unshift(message);
    index -= 1;
  }

  return {
    messages,
    hasMore: index > 0,
    nextBefore: index > 0 ? index : null,
  };
}

/**
 * Чтение истории сперва материализует принятые ходы и общий in-turn журнал.
 * CAS стопа выполняется chat owner под admission lock, а не между двумя запросами фасада.
 */
export function registerChatRoutes(app: MobileApp, deps: FacadeDeps) {
  app.get<{ Querystring: Payload }>('/api/mobile/v1/chats', async (request) => {
    let heads = await deps.chat.heads();

    if (!heads.some((chat) => isLiveCompanion(chat))) {
      await upstream(deps, 'POST', '/api/chat/store/ensure', {
        purpose: 'companion',
        taskId: null,
        origin: `mobile:${request.mobileDevice!.id}`,
      });
      heads = await deps.chat.heads();
    }

    const active = await upstream(deps, 'GET', '/api/chat/active');
    const waiting = await upstream(deps, 'GET', '/api/chat/waiting');
    const providers = await chatProviders();
    const chats = heads
      .map((chat) => summary(record(chat), active, waiting, providers))
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    const page = paginate(chats, request.query);

    return decodeChats({
      chats: page.items,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
    });
  });
  app.get<{
    Params: { id: string };
    Querystring: Payload;
  }>('/api/mobile/v1/chats/:id', async (request) => {
    const id = resourceId(request.params.id);
    const chat = await deps.chat.read(id);

    if (!chat) {
      throw new MobileInputError('chat_not_found', 'Чат не найден.', 404);
    }

    const active = await upstream(deps, 'GET', '/api/chat/active');
    const waiting = await upstream(deps, 'GET', '/api/chat/waiting');
    const run = (Array.isArray(active.active) ? active.active.map(record) : []).find(
      (item) => item.chatKey === id,
    );
    const queued = (Array.isArray(active.queued) ? active.queued.map(record) : [])
      .filter((item) => item.chatKey === id)
      .map((item) => String(item.turnId))
      .sort();
    const actions: Record<string, string> = {};
    const providers = await chatProviders();

    if (run || queued.length) {
      actions.stop = deps.tokens.issue(request.mobileDevice!.id, `chat:${id}`, 'stop', {
        runId: run?.runId ?? null,
        queued,
      });
    }
    if (deps.chat.controls) {
      if (!run && !queued.length) {
        actions.configure = deps.tokens.issue(request.mobileDevice!.id, `chat:${id}`, 'configure', {
          revision: Number(chat.revision || 0),
        });
      }
      if (chat.unread === true) {
        actions.read = deps.tokens.issue(request.mobileDevice!.id, `chat:${id}`, 'read', {
          revision: Number(chat.revision || 0),
        });
      }
    }

    return decodeChat({
      chat: {
        ...summary(chat, active, waiting, providers),
        effort: text(chat.effort, 200),
        revision: Number(chat.revision || 0),
        settings: chatSettings(chat, run, deps),
        actions,
      },
      ...messagePage(chat, request.query),
      ...(run ? { activity: chatActivity(run.steps, true) } : {}),
    });
  });
  app.post<{
    Params: { id: string };
    Body: { actionToken?: unknown };
  }>('/api/mobile/v1/chats/:id/stop', async (request) => {
    const id = resourceId(request.params.id);
    const expected = deps.tokens.take(
      request.mobileDevice!.id,
      `chat:${id}`,
      'stop',
      request.body?.actionToken,
    );

    try {
      return decodeContract(
        'stop',
        await upstream(deps, 'POST', '/api/chat/stop', {
          chatKey: id,
          expected,
        }),
      );
    } catch (error) {
      if (error instanceof MobileInputError && error.code === 'upstream_409') {
        throw new MobileInputError('state_changed', 'Запуск изменился; обновите чат.', 409);
      }

      throw error;
    }
  });
}

/**
 * Имя и цвет берутся из адаптеров Кокпита без запуска probe, auth или discovery моделей.
 * Мобильный интерфейс не угадывает исполнителя по строке названия модели.
 */
async function chatProviders(): Promise<Map<string, ChatProvider>> {
  const adapters = await getProviderAdapters();

  return new Map([...adapters].map(([id, adapter]) => [id, {
    id,
    name: text(adapter.name, 200),
    color: /^#[a-f\d]{6}$/i.test(String(adapter.color)) ? String(adapter.color) : '#58a6ff',
  }]));
}

/**
 * Все сообщения проходят общий admission с устойчивым turnId, включая задачу и Компаньона.
 * Delivery не создаёт ход и не раскрывает записи чужого устройства.
 */
export function registerMessageRoutes(app: MobileApp, deps: Pick<FacadeDeps, 'chat'>) {
  const turns = new MobileChatTurns(deps.chat);

  app.post<{
    Params: { id: string };
    Body: {
      text: string;
      clientId: string;
    };
  }>('/api/mobile/v1/chats/:id/messages', async (request, reply) => {
    const result = await turns.send({
      deviceId: request.mobileDevice!.id,
      chatId: resourceId(request.params.id),
      text: request.body?.text,
      clientId: request.body?.clientId,
    });

    return reply.code(result.status).send(result.body);
  });
  app.get<{
    Params: { id: string };
    Querystring: Payload;
  }>('/api/mobile/v1/chats/:id/deliveries', async (request) => {
    const id = resourceId(request.params.id);
    const ids = typeof request.query.ids === 'string' ? request.query.ids.split(',') : [];

    if (
      !ids.length ||
      ids.length > 50 ||
      ids.some((value) => !/^[A-Za-z0-9_-]{8,80}$/.test(value))
    ) {
      throw new MobileInputError('bad_request', 'Передайте от 1 до 50 идентификаторов отправки.');
    }

    return decodeContract('deliveries', {
      deliveries: await deps.chat.deliveries(request.mobileDevice!.id, id, ids),
    });
  });
}
