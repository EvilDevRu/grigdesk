import { trackerPersonalRequestOptions } from '../../lib/taskPersonalScope.ts';
import { withTrackerRequestRead } from '../../lib/trackers/requestRead.ts';
// Просмотренные B24-задачи. Метки живут только в state GrigDesk и в B24 не пишутся.
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { TaskSeenService } from '../../lib/taskSeenService.ts';
import { normalizeSeenTaskId } from '../../lib/taskSeenStore.ts';

// Потолок одного запроса: доска шлёт базовую линию списком, отдельный просмотр — одной
// задачей. Всё, что больше, — не наш клиент.
const MAX_TASK_IDS_PER_REQUEST = 1000;

class TaskSeenRequestError extends Error {
  readonly code = 'BAD_SEEN_REQUEST';

  constructor(message: string) {
    super(message);
    this.name = 'TaskSeenRequestError';
  }
}

/**
 * Отдельный просмотр и порции базовой линии используют один проверенный контракт.
 * Лимит batch сохраняется, служебный ключ связывает части одной инициализации.
 */
function parseMarkBody(body: unknown): {
  taskIds: string[];
  baseline: boolean;
  baselineId?: string
} {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new TaskSeenRequestError('Тело запроса должно быть объектом');
  }

  const { taskIds, baseline, baselineId } = body as {
    taskIds?: unknown;
    baseline?: unknown;
    baselineId?: unknown
  };
  if (!Array.isArray(taskIds) || taskIds.length > MAX_TASK_IDS_PER_REQUEST) {
    throw new TaskSeenRequestError('taskIds должен быть массивом номеров задач');
  }
  if (baseline !== undefined && typeof baseline !== 'boolean') {
    throw new TaskSeenRequestError('baseline должен быть булевым');
  }
  if (baselineId !== undefined
    && (typeof baselineId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(baselineId))) {
    throw new TaskSeenRequestError('Некорректный ключ baseline');
  }

  return {
    taskIds: taskIds.map(normalizeSeenTaskId),
    baseline: !!baseline,
    ...(typeof baselineId === 'string' ? { baselineId } : {})
  };
}

/**
 * Публичная ошибка сохраняет статус отказа источника и не раскрывает личную identity.
 * Повреждение хранилища остаётся недоступностью, а смена поколения — конфликтом.
 */
function publicError(reply: FastifyReply, error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  const status = (error as { status?: number }).status;

  if (status && [400, 404, 409, 503].includes(status)) {
    return reply.code(status).send({ error: code, message: (error as Error).message });
  }
  if (code === 'BAD_SEEN_TASK_ID') {
    return reply.code(400).send({
      error: 'bad_task_id',
      message: 'Некорректный номер задачи.',
    });
  }
  if (code === 'BAD_SEEN_REQUEST') {
    return reply.code(400).send({
      error: 'bad_request',
      message: 'Некорректный запрос отметки просмотра.',
    });
  }
  if (code === 'B24_IDENTITY_UNAVAILABLE') {
    return reply.code(503).send({
      error: 'b24_identity_unavailable',
      message: 'Не удалось определить текущего пользователя Битрикс24.',
    });
  }
  if (['TASK_SEEN_CORRUPT', 'TASK_SEEN_UNAVAILABLE'].includes(String(code))) {
    return reply.code(503).send({
      error: 'task_seen_unavailable',
      message: 'Отметки просмотра временно недоступны. Сохранённые данные не изменены.',
    });
  }
  return reply.code(500).send({
    error: 'task_seen_failed',
    message: 'Не удалось обработать отметки просмотра.',
  });
}

async function taskSeenModule(
  fastify: FastifyInstance,
  opts: { seen: TaskSeenService },
): Promise<void> {
  const { seen } = opts;

  const run = (
    operation: (request: FastifyRequest) => Promise<unknown>,
  ) => async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      return await operation(request);
    } catch (error) {
      request.log?.error?.(
        { code: (error as { code?: unknown } | null)?.code },
        'Ошибка отметок просмотра задач',
      );
      return publicError(reply, error);
    }
  };



  for (const prefix of ['/api/tracker', '/api/tracker/:driverId']) {
    fastify.get(`${prefix}/task-seen`, (request, reply) =>
      withTrackerRequestRead(request, reply, (options) =>
        run(() => seen.list(options, {
          driverId: (request.params as { driverId?: string }).driverId,
        }))(request, reply)));
    fastify.post(`${prefix}/task-seen`, run((request) => {
      const { taskIds, baseline } = parseMarkBody(request.body);

      return seen.markSeen(taskIds, { baseline, ...trackerPersonalRequestOptions(request.headers,
        (request.params as { driverId?: string }).driverId) });
    }));
  }


}

export default fp(taskSeenModule, { name: 'module-task-seen' });
