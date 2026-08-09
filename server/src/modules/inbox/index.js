// HTTP/SSE граница общего Inbox. Provider credentials и native routes здесь не
// появляются: модуль знает только coordinator, mutation service и общий worker.
import fp from 'fastify-plugin';
import { safeInboxSourceUrl } from '../../lib/inbox/draft.js';

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
  attachments_skipped: 'Не все вложения удалось подготовить; обращение осталось новым.',
  attachment_analysis_required: 'Не удалось полностью разобрать содержимое вложений. Обращение осталось новым.',
  indeterminate_task_commit: 'B24-задача могла быть создана, но Inbox не подтвердил решение. Нужна сверка оператора.',
  inbox_failed: 'Inbox временно не смог выполнить операцию.',
});

const PUBLIC_CODE_ALIASES = Object.freeze({
  // Внутреннее имя поколения провайдера не является частью HTTP-контракта.
  stale_generation: 'account_changed',
});

function safeTaskId(value) {
  if (typeof value !== 'string'
      || !value
      || Buffer.byteLength(value, 'utf8') > 512
      || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  return value;
}

function safeTaskUrl(value) {
  try { return safeInboxSourceUrl(value) || ''; } catch { return ''; }
}

function publicFailure(reply, error) {
  const status = Number.isInteger(error?.statusCode)
    && error.statusCode >= 400
    && error.statusCode <= 599
    ? error.statusCode
    : 500;
  const rawCode = typeof error?.code === 'string' ? error.code : 'inbox_failed';
  const fallbackCode = status < 500 ? 'invalid_request' : 'inbox_failed';
  const publicCode = PUBLIC_CODE_ALIASES[rawCode] || rawCode;
  const code = Object.hasOwn(PUBLIC_MESSAGES, publicCode) ? publicCode : fallbackCode;
  const payload = { error: code, message: PUBLIC_MESSAGES[code] };
  if (code === 'indeterminate_task_commit') {
    payload.retryable = false;
    payload.taskId = safeTaskId(error?.details?.taskId);
    payload.taskUrl = safeTaskUrl(error?.details?.taskUrl);
  }
  return reply.code(status).send(payload);
}

async function inboxModule(fastify, opts) {
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

  const gate = (reply) => (fastify.pluginEnabled('inbox') ? null
    : reply.code(404).send({
      error: 'plugin_disabled',
      message: 'Плагин «Входящие» выключен.',
    }));

  const run = (operation) => async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (gate(reply)) return reply;
    try {
      return await operation(request, reply);
    } catch (error) {
      request.log?.error?.({ code: error?.code }, 'inbox: HTTP operation failed');
      return publicFailure(reply, error);
    }
  };

  const listOptions = (request) => {
    const raw = request.query?.limit;
    return raw === undefined ? {} : { limit: Number(raw) };
  };
  const changed = (payload) => {
    try {
      const result = fastify.sse?.broadcast?.('inbox-changed', payload);
      Promise.resolve(result).catch(() => {
        fastify.log.warn('inbox: activation commit выполнен, но SSE не отправлен');
      });
    } catch {
      fastify.log.warn('inbox: activation commit выполнен, но SSE не отправлен');
    }
  };

  const workerStatus = async () => {
    if (!worker) return null;
    try {
      if (typeof worker.publicStatus === 'function') return await worker.publicStatus();
      return typeof worker.status === 'function' ? await worker.status() : null;
    } catch {
      fastify.log.warn('inbox: состояние автообработчика временно недоступно');
      return { running: false, readiness: 'unavailable' };
    }
  };

  fastify.get('/api/inbox', run(async (request) => ({
    ...(await coordinator.list(listOptions(request))),
    worker: await workerStatus(),
  })));
  fastify.get('/api/inbox/summary', run((request) => coordinator.summary(listOptions(request))));
  fastify.get('/api/inbox/status', run(async () => ({
    ...(await coordinator.status()),
    worker: await workerStatus(),
  })));

  fastify.post('/api/inbox/channels/:channel/activate', run(async (request) => {
    const result = await coordinator.activate(request.params.channel, request.body);
    changed({ itemRef: null, channel: request.params.channel, status: 'activated', taskId: null });
    return result;
  }));
  fastify.post('/api/inbox/channels/:channel/deactivate', run(async (request) => {
    const result = await coordinator.deactivate(request.params.channel, request.body);
    changed({ itemRef: null, channel: request.params.channel, status: 'deactivated', taskId: null });
    return result;
  }));

  fastify.post('/api/inbox/items/:ref/task', run((request) => (
    taskService.task(request.params.ref, request.body)
  )));
  fastify.post('/api/inbox/items/:ref/dismiss', run((request) => (
    taskService.dismiss(request.params.ref, request.body)
  )));
  fastify.post('/api/inbox/items/:ref/reset', run((request) => (
    taskService.reset(request.params.ref, request.body)
  )));
}

export default fp(inboxModule, { name: 'module-inbox' });
