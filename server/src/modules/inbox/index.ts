// HTTP/SSE граница общего Inbox. Provider credentials и native routes здесь не
// появляются: модуль знает только coordinator, mutation service и общий worker.
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { safeInboxSourceUrl } from '../../lib/inbox/draft.ts';

declare module 'fastify' {
  interface FastifyInstance {
    pluginEnabled(id: string): boolean;
    sse?: {
      broadcast?(name: string, payload?: unknown): unknown;
    };
  }
}

type Payload = Record<string, unknown>;

// Координатор и служба решений приходят из приложения. Здесь объявлено ровно то,
// что зовут маршруты: HTTP-слой не знает ни каналов, ни их учётных данных.
export interface InboxCoordinatorPort {
  list: (options: Payload) => Promise<Payload>;
  summary: (options: Payload) => Promise<unknown>;
  status: () => Promise<Payload>;
  activate: (channel: string, body: unknown) => Promise<unknown>;
  deactivate: (channel: string, body: unknown) => Promise<unknown>;
}

export interface InboxTaskServicePort {
  task: (ref: string, body: unknown) => Promise<unknown>;
  dismiss: (ref: string, body: unknown) => Promise<unknown>;
  reset: (ref: string, body: unknown) => Promise<unknown>;
}

// Автообработчик необязателен: без него раздел работает вручную, и его состояние
// просто отсутствует в ответе.
export interface InboxWorkerPort {
  publicStatus?: () => Promise<unknown>;
  status?: () => Promise<unknown> | unknown;
}

export interface InboxModuleOptions {
  coordinator?: InboxCoordinatorPort;
  taskService?: InboxTaskServicePort;
  worker?: InboxWorkerPort | null;
}

interface ChannelRoute {
  Params: {
    channel: string;
  };
  Body: unknown;
}

interface ItemRoute {
  Params: {
    ref: string;
  };
  Body: unknown;
}

interface ListRoute {
  Querystring: {
    limit?: unknown;
  };
}

function asRecord(value: unknown): Payload {
  return value !== null && typeof value === 'object' ? value as Payload : {};
}

const PUBLIC_MESSAGES = Object.freeze({
  invalid_request: 'Запрос Inbox не соответствует контракту.',
  invalid_revision: 'Revision имеет неверный формат.',
  invalid_selection: 'Выбраны некорректные сообщения.',
  invalid_item_ref: 'Ссылка на обращение некорректна.',
  invalid_limit: 'Параметр limit некорректен.',
  stale_item: 'Обращение изменилось; перечитайте Inbox.',
  stale_decision: 'Решение изменилось; перечитайте Inbox.',
  stale_activation: 'Состояние приёма канала изменилось; обновите страницу.',
  stale_policy: 'Правило или проект обращения изменились.',
  account_changed: 'Подключённый аккаунт канала изменился.',
  inbox_disabled: 'Плагин «Входящие» был выключен во время операции.',
  channel_disabled: 'Канал выключен.',
  channel_disconnected: 'Канал отключён; обращения доступны только для чтения.',
  unknown_channel: 'Канал Inbox не найден.',
  no_b24: 'Битрикс24 не подключён — задачу ставить негде.',
  b24_failed: 'Битрикс24 не принял задачу. Обращение осталось новым.',
  channel_materialize_failed: 'Канал не смог подготовить вложения.',
  attachments_skipped: 'Не все вложения удалось подготовить. Опишите их содержимое, чтобы поставить задачу.',
  attachment_analysis_required: 'Содержимое вложений разобрано не полностью. Опишите его, чтобы поставить задачу.',
  indeterminate_task_commit: 'B24-задача могла быть создана, но Inbox не подтвердил решение. Нужна сверка оператора.',
  inbox_failed: 'Inbox временно не смог выполнить операцию.',
});

const PUBLIC_CODE_ALIASES = Object.freeze({
  // Внутреннее имя поколения провайдера не является частью HTTP-контракта.
  stale_generation: 'account_changed',
});

function safeTaskId(value: unknown): string | null {
  if (typeof value !== 'string'
      || !value
      || Buffer.byteLength(value, 'utf8') > 512
      || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  return value;
}

function safeTaskUrl(value: unknown): string {
  try { return safeInboxSourceUrl(value) || ''; } catch { return ''; }
}

const MAX_FAILED_ATTACHMENTS = 12;
const safeLine = (value: unknown, limit: number) => String(value ?? '')
  .replace(/[\u0000-\u001f\u007f]/gu, ' ')
  .replace(/\s+/gu, ' ')
  .trim()
  .slice(0, limit);

/**
 * Почему обращение нельзя поставить задачей без пояснения человека.
 *
 * Один код отказа этого не объясняет: «не разобралось» одинаково выглядит и у
 * файла сверх потолка Bot API, и у временного сбоя. Подписи те же, что уже
 * показаны в карточке, а причину формулирует сам кокпит.
 */
function safeFailedAttachments(value: unknown) {
  if (!Array.isArray(value)) return [];

  return (value as Payload[]).slice(0, MAX_FAILED_ATTACHMENTS).map((entry) => ({
    label: safeLine(entry?.label, 200) || 'вложение',
    reason: safeLine(entry?.reason, 240),
  }));
}

// Наружу уходит только объявленный машинный код и его готовый текст. Сообщение
// самой ошибки не публикуется: в нём бывают и адреса, и ответы провайдера.
function publicFailure(reply: FastifyReply, source: unknown) {
  const error = asRecord(source);
  const statusCode = Number(error.statusCode);
  const status = Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599
    ? statusCode
    : 500;
  const rawCode = typeof error.code === 'string' ? error.code : 'inbox_failed';
  const fallbackCode = status < 500 ? 'invalid_request' : 'inbox_failed';
  const aliases = PUBLIC_CODE_ALIASES as Record<string, string>;
  const messages = PUBLIC_MESSAGES as Record<string, string>;
  const publicCode = aliases[rawCode] || rawCode;
  const code = Object.hasOwn(PUBLIC_MESSAGES, publicCode) ? publicCode : fallbackCode;
  const details = asRecord(error.details);
  const payload: Payload = { error: code, message: messages[code] };

  if (code === 'attachment_analysis_required' || code === 'attachments_skipped') {
    payload.attachments = safeFailedAttachments(details.attachments);
  }
  if (code === 'indeterminate_task_commit') {
    payload.retryable = false;
    payload.taskId = safeTaskId(details.taskId);
    payload.taskUrl = safeTaskUrl(details.taskUrl);
  }

  return reply.code(status).send(payload);
}

async function inboxModule(fastify: FastifyInstance, opts: InboxModuleOptions): Promise<void> {
  const { coordinator, taskService, worker = null } = opts;
  if (!coordinator || typeof coordinator.list !== 'function'
      || typeof coordinator.summary !== 'function'
      || typeof coordinator.status !== 'function'
      || typeof coordinator.activate !== 'function'
      || typeof coordinator.deactivate !== 'function') {
    throw new Error('module-inbox: coordinator обязателен');
  }
  if (!taskService || typeof taskService.task !== 'function'
      || typeof taskService.dismiss !== 'function'
      || typeof taskService.reset !== 'function') {
    throw new Error('module-inbox: taskService обязателен');
  }

  const gate = (reply: FastifyReply) => (fastify.pluginEnabled('inbox') ? null
    : reply.code(404).send({
      error: 'plugin_disabled',
      message: 'Плагин «Входящие» выключен.',
    }));

  // Общая обвязка маршрута: живой флаг плагина, запрет кеша и один разбор отказа на
  // всех. Параметры пути объявляет сам маршрут — обвязка их только пропускает.
  const run = <Params = unknown>(
    operation: (request: FastifyRequest & { params: Params }, reply: FastifyReply) => unknown,
  ) => async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('Cache-Control', 'no-store');
    if (gate(reply)) return reply;
    try {
      return await operation(request as FastifyRequest & { params: Params }, reply);
    } catch (error) {
      request.log?.error?.({ code: asRecord(error).code }, 'inbox: HTTP operation failed');
      return publicFailure(reply, error);
    }
  };

  const listOptions = (request: FastifyRequest): Payload => {
    const raw = (request.query as ListRoute['Querystring'] | undefined)?.limit;

    return raw === undefined ? {} : { limit: Number(raw) };
  };
  const changed = (payload: Payload) => {
    try {
      const result = fastify.sse?.broadcast?.('inbox-changed', payload);
      Promise.resolve(result).catch(() => {
        fastify.log.warn('inbox: activation commit выполнен, но SSE не отправлен');
      });
    } catch {
      fastify.log.warn('inbox: activation commit выполнен, но SSE не отправлен');
    }
  };

  const workerStatus = async (): Promise<unknown> => {
    if (!worker) return null;
    try {
      if (typeof worker.publicStatus === 'function') return await worker.publicStatus();
      return typeof worker.status === 'function' ? await worker.status() : null;
    } catch {
      fastify.log.warn('inbox: состояние автообработчика временно недоступно');
      return { running: false, readiness: 'unavailable' };
    }
  };

  fastify.get<ListRoute>('/api/inbox', run(async (request) => ({
    ...(await coordinator.list(listOptions(request))),
    worker: await workerStatus(),
  })));
  fastify.get<ListRoute>(
    '/api/inbox/summary',
    run((request) => coordinator.summary(listOptions(request))),
  );
  fastify.get('/api/inbox/status', run(async () => ({
    ...(await coordinator.status()),
    worker: await workerStatus(),
  })));

  fastify.post<ChannelRoute>('/api/inbox/channels/:channel/activate', run<ChannelRoute['Params']>(async (request) => {
    const result = await coordinator.activate(request.params.channel, request.body);
    changed({ itemRef: null, channel: request.params.channel, status: 'activated', taskId: null });
    return result;
  }));
  fastify.post<ChannelRoute>('/api/inbox/channels/:channel/deactivate', run<ChannelRoute['Params']>(async (request) => {
    const result = await coordinator.deactivate(request.params.channel, request.body);
    changed({ itemRef: null, channel: request.params.channel, status: 'deactivated', taskId: null });
    return result;
  }));

  fastify.post<ItemRoute>('/api/inbox/items/:ref/task', run<ItemRoute['Params']>((request) => (
    taskService.task(request.params.ref, request.body)
  )));
  fastify.post<ItemRoute>('/api/inbox/items/:ref/dismiss', run<ItemRoute['Params']>((request) => (
    taskService.dismiss(request.params.ref, request.body)
  )));
  fastify.post<ItemRoute>('/api/inbox/items/:ref/reset', run<ItemRoute['Params']>((request) => (
    taskService.reset(request.params.ref, request.body)
  )));
}

export default fp(inboxModule, { name: 'module-inbox' });
