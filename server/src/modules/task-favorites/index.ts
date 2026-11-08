import { trackerPersonalRequestOptions } from '../../lib/taskPersonalScope.ts';
import { withTrackerRequestRead } from '../../lib/trackers/requestRead.ts';
// Локальное избранное B24-задач. Мутации меняют только state GrigDesk и не пишут в B24.
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { TaskFavoritesService } from '../../lib/taskFavoritesService.ts';
import { normalizeFavoriteTaskId } from '../../lib/taskFavoritesStore.ts';

/**
 * Публичная ошибка сохраняет статус отказа источника и не раскрывает личную identity.
 * Повреждение хранилища остаётся недоступностью, а смена поколения — конфликтом.
 */
function publicError(reply: FastifyReply, error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;

  const status = (error as { status?: number }).status
    ?? (String(code).startsWith('grigdesk_tasks_') ? 503 : undefined);

  if (status && [400, 404, 409, 503].includes(status)) {
    return reply.code(status).send({ error: code, message: (error as Error).message });
  }
  if (code === 'BAD_FAVORITE_TASK_ID') {
    return reply.code(400).send({
      error: 'bad_task_id',
      message: 'Некорректный номер задачи.',
    });
  }
  if (code === 'B24_IDENTITY_UNAVAILABLE') {
    return reply.code(503).send({
      error: 'b24_identity_unavailable',
      message: 'Не удалось определить текущего пользователя Битрикс24.',
    });
  }
  if (['TASK_FAVORITES_CORRUPT', 'TASK_FAVORITES_UNAVAILABLE'].includes(String(code))) {
    return reply.code(503).send({
      error: 'task_favorites_unavailable',
      message: 'Избранное временно недоступно. Сохранённые данные не изменены.',
    });
  }
  return reply.code(500).send({
    error: 'task_favorites_failed',
    message: 'Не удалось обработать избранное.',
  });
}

type FavoriteRequest = { Params: { taskId: string; driverId?: string } };

async function taskFavoritesModule(
  fastify: FastifyInstance,
  opts: { favorites: TaskFavoritesService },
): Promise<void> {
  const { favorites } = opts;

  const run = (
    operation: (request: FastifyRequest<FavoriteRequest>) => Promise<unknown>,
  ) => async (
    request: FastifyRequest<FavoriteRequest>,
    reply: FastifyReply,
  ) => {
    reply.header('Cache-Control', 'no-store');
    try {
      return await operation(request);
    } catch (error) {
      request.log?.error?.({ code: (error as { code?: unknown } | null)?.code }, 'Ошибка избранного задач');
      return publicError(reply, error);
    }
  };



  for (const prefix of ['/api/tracker', '/api/tracker/:driverId']) {
    fastify.get<FavoriteRequest>(`${prefix}/task-favorites`, (request, reply) =>
      withTrackerRequestRead(request, reply, (options) =>
        run(() => favorites.list(options, {
          driverId: (request.params as { driverId?: string }).driverId,
        }))(request, reply)));
    fastify.put(`${prefix}/task-favorites/:taskId`, run((request) => {
      const taskId = normalizeFavoriteTaskId(request.params.taskId);

      return favorites.add(taskId, trackerPersonalRequestOptions(request.headers,
        (request.params as { driverId?: string }).driverId));
    }));
    fastify.delete(`${prefix}/task-favorites/:taskId`, run((request) => {
      const taskId = normalizeFavoriteTaskId(request.params.taskId);

      return favorites.remove(taskId, trackerPersonalRequestOptions(request.headers,
        (request.params as { driverId?: string }).driverId));
    }));
  }

  fastify.get<FavoriteRequest>('/api/grigdesk-tasks/task-favorites', (request, reply) =>
    withTrackerRequestRead(request, reply, (options) =>
      run(() => favorites.list(options, { source: 'grigdesk' }))(request, reply)));
  fastify.put('/api/grigdesk-tasks/task-favorites/:taskId', run((request) => {
    const taskId = normalizeFavoriteTaskId(request.params.taskId);

    return favorites.add(taskId, { source: 'grigdesk' });
  }));
  fastify.delete('/api/grigdesk-tasks/task-favorites/:taskId', run((request) => {
    const taskId = normalizeFavoriteTaskId(request.params.taskId);

    return favorites.remove(taskId, { source: 'grigdesk' });
  }));
}

export default fp(taskFavoritesModule, { name: 'module-task-favorites' });
