import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply } from 'fastify';

import {
  createGrigdeskTasksService, GrigdeskTaskInputError,
} from '../../lib/grigdeskTasks/service.ts';
import type { GrigdeskTasksServiceOptions } from '../../lib/grigdeskTasks/service.ts';
import { GrigdeskTaskStoreError } from '../../lib/grigdeskTasks/store.ts';

/**
 * Ошибки хранилища остаются отказом, а не отсутствующей задачей портала.
 * Только точный not-found ниже разрешает клиенту прежнее чтение Б24.
 */
function publicError(reply: FastifyReply, error: unknown) {
  if (error instanceof GrigdeskTaskInputError) {
    return reply.code(error.status).send({ error: error.code, message: error.message });
  }

  const code = error instanceof GrigdeskTaskStoreError ? error.code : 'grigdesk_tasks_unavailable';

  return reply.code(503).send({ error: code, message: 'Задачи GrigDesk временно недоступны' });
}

/**
 * Все маршруты наследуют общий auth guard и не используют внутренний inject.
 * Создание публикует событие только после записи документа, без автоматической оценки.
 */
async function grigdeskTasksModule(fastify: FastifyInstance, options: GrigdeskTasksServiceOptions & {
  service?: ReturnType<typeof createGrigdeskTasksService>;
}) {
  const service = options.service ?? createGrigdeskTasksService(options);
  const run = (operation: () => Promise<unknown>) => async (_request: unknown, reply: FastifyReply) => {
    reply.header('Cache-Control', 'no-store');

    try {
      return await operation();
    } catch (error) {
      return publicError(reply, error);
    }
  };

  fastify.get('/api/grigdesk-tasks', run(() => service.list()));
  fastify.get('/api/grigdesk-tasks/projects', run(() => service.listProjects()));
  fastify.get<{ Params: { id: string } }>('/api/grigdesk-tasks/:id', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');

    if (!/^[1-9]\d{0,14}$/.test(request.params.id)) {
      return reply.code(400).send({ error: 'bad_task_id' });
    }

    try {
      const task = await service.get(request.params.id);

      return task || reply.code(404).send({ error: 'grigdesk_task_not_found' });
    } catch (error) {
      return publicError(reply, error);
    }
  });
  fastify.post<{ Querystring: { sources?: string } }>('/api/grigdesk-tasks', async (request, reply) => {
    try {
      const result = await service.create(request.body, { sources: request.query.sources === '1' });

      try {
        await fastify.sse?.broadcast?.('grigdesk-tasks-changed', { revision: result.revision });
      } catch (error) {
        request.log.warn({ err: error }, 'Не удалось разослать изменение задач GrigDesk');
      }

      return reply.code(201).send(result);
    } catch (error) {
      return publicError(reply, error);
    }
  });
}

export default fp(grigdeskTasksModule, { name: 'module-grigdesk-tasks' });
