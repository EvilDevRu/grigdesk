import { trackerPersonalRequestOptions } from '../../lib/taskPersonalScope.ts';
import { withTrackerRequestRead } from '../../lib/trackers/requestRead.ts';
// Account-scoped полка B24-задач. Роуты меняют только state GrigDesk и живо
// закрываются гейтом системного плагина; общий auth guard уже закрывает весь /api.
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { errorCode } from '../../../../shared/lib/errors.ts';

import { normalizeShelfTaskId } from '../../lib/taskShelfStore.ts';
import type { TaskShelfResult, TaskShelfService } from '../../lib/taskShelfService.ts';

export interface TaskShelfModuleOptions {
  shelf: TaskShelfService;
}

interface TaskShelfRoute {
  Params: {
    taskId: string; driverId?: string;
  };
  Body: unknown;
}

/**
 * Публичная ошибка сохраняет статус источника без раскрытия личной identity.
 * Повреждение хранилища не превращается в пустую успешную полку.
 */
function publicError(reply: FastifyReply, error: unknown): FastifyReply {
  const code = errorCode(error);
  const status = (error as { status?: number }).status
    ?? (String(code).startsWith('grigdesk_tasks_') ? 503 : undefined);

  if (status && [400, 404, 409, 503].includes(status)) {
    return reply.code(status).send({ error: code, message: (error as Error).message });
  }
  if (code === 'BAD_SHELF_TASK_ID') {
    return reply.code(400).send({ error: 'bad_task_id', message: 'Некорректный номер задачи.' });
  }
  if (code === 'BAD_SHELF_REQUEST') {
    return reply.code(400).send({ error: 'bad_request', message: 'Некорректная запись полки.' });
  }
  if (code === 'B24_IDENTITY_UNAVAILABLE') {
    return reply.code(503).send({
      error: 'b24_identity_unavailable',
      message: 'Не удалось определить текущего пользователя Битрикс24.',
    });
  }
  if (['TASK_SHELF_CORRUPT', 'TASK_SHELF_UNAVAILABLE'].includes(code)) {
    return reply.code(503).send({
      error: 'task_shelf_unavailable',
      message: 'Полка временно недоступна. Сохранённые данные не изменены.',
    });
  }
  return reply.code(500).send({
    error: 'task_shelf_failed',
    message: 'Не удалось обработать полку.',
  });
}

async function taskShelfModule(
  fastify: FastifyInstance,
  opts: TaskShelfModuleOptions,
): Promise<void> {
  const { shelf } = opts;

  const run = (
    operation: (request: FastifyRequest<TaskShelfRoute>) => Promise<TaskShelfResult>,
    { mutation = false } = {},
  ) => async (
    request: FastifyRequest<TaskShelfRoute>,
    reply: FastifyReply,
  ): Promise<TaskShelfResult | FastifyReply> => {
    reply.header('Cache-Control', 'no-store');
    if (!fastify.pluginEnabled('shelf')) {
      return reply.code(404).send({
        error: 'plugin_disabled',
        message: 'Плагин «Полка» выключен.',
      });
    }

    try {
      const result = await operation(request);
      if (mutation && result.changed) {
        try {
          await fastify.sse?.broadcast?.('task-shelf-changed');
        } catch (error) {
          request.log?.warn?.({ err: error }, 'Не удалось разослать изменение полки');
        }
      }
      return result;
    } catch (error) {
      request.log?.error?.({ code: errorCode(error) }, 'Ошибка полки задач');
      return publicError(reply, error);
    }
  };



  for (const prefix of ['/api/tracker', '/api/tracker/:driverId']) {
    fastify.get<TaskShelfRoute>(`${prefix}/task-shelf`, (request, reply) =>
      withTrackerRequestRead(request, reply, (options) =>
        run(() => shelf.list(options, {
          driverId: (request.params as { driverId?: string }).driverId,
        }))(request, reply)));
    fastify.put<TaskShelfRoute>(`${prefix}/task-shelf/:taskId`, run((request) => {
      const taskId = normalizeShelfTaskId(request.params.taskId);

      return shelf.put(taskId, request.body, trackerPersonalRequestOptions(request.headers,
        (request.params as { driverId?: string }).driverId));
    }, { mutation: true }));
    fastify.delete<TaskShelfRoute>(`${prefix}/task-shelf/:taskId`, run((request) => {
      const taskId = normalizeShelfTaskId(request.params.taskId);

      return shelf.remove(taskId, trackerPersonalRequestOptions(request.headers,
        (request.params as { driverId?: string }).driverId));
    }, { mutation: true }));
  }

  fastify.get<TaskShelfRoute>('/api/grigdesk-tasks/task-shelf', (request, reply) =>
    withTrackerRequestRead(request, reply, (options) =>
      run(() => shelf.list(options, { source: 'grigdesk' }))(request, reply)));
  fastify.put<TaskShelfRoute>('/api/grigdesk-tasks/task-shelf/:taskId', run((request) => {
    const taskId = normalizeShelfTaskId(request.params.taskId);

    return shelf.put(taskId, request.body, { source: 'grigdesk' });
  }, { mutation: true }));
  fastify.delete<TaskShelfRoute>('/api/grigdesk-tasks/task-shelf/:taskId', run((request) => {
    const taskId = normalizeShelfTaskId(request.params.taskId);

    return shelf.remove(taskId, { source: 'grigdesk' });
  }, { mutation: true }));
}

export default fp(taskShelfModule, { name: 'module-task-shelf' });
