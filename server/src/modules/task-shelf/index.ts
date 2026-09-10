// Account-scoped полка B24-задач. Роуты меняют только state Cockpit и живо
// закрываются гейтом системного плагина; общий auth guard уже закрывает весь /api.
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { normalizeShelfTaskId } from '../../lib/taskShelfStore.ts';
import type { TaskShelfResult, TaskShelfService } from '../../lib/taskShelfService.ts';

export interface TaskShelfModuleOptions {
  shelf: TaskShelfService;
}

interface TaskShelfRoute {
  Params: {
    taskId: string;
  };
  Body: unknown;
}

function failureCode(error: unknown): string {
  const code = error !== null && typeof error === 'object'
    ? (error as { code?: unknown }).code
    : undefined;

  return typeof code === 'string' ? code : '';
}

function publicError(reply: FastifyReply, error: unknown): FastifyReply {
  const code = failureCode(error);
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
      request.log?.error?.({ code: failureCode(error) }, 'Ошибка полки задач');
      return publicError(reply, error);
    }
  };

  fastify.get<TaskShelfRoute>('/api/b24/task-shelf', run(() => shelf.list()));
  fastify.put<TaskShelfRoute>('/api/b24/task-shelf/:taskId', run((request) => {
    const taskId = normalizeShelfTaskId(request.params.taskId);
    return shelf.put(taskId, request.body);
  }, { mutation: true }));
  fastify.delete<TaskShelfRoute>('/api/b24/task-shelf/:taskId', run((request) => {
    const taskId = normalizeShelfTaskId(request.params.taskId);
    return shelf.remove(taskId);
  }, { mutation: true }));
}

export default fp(taskShelfModule, { name: 'module-task-shelf' });
