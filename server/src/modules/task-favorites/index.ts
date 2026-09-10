// Локальное избранное B24-задач. Мутации меняют только state Cockpit и не пишут в B24.
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { TaskFavoritesService } from '../../lib/taskFavoritesService.ts';
import { normalizeFavoriteTaskId } from '../../lib/taskFavoritesStore.ts';

/** Код отказа наружу: внутренние коды хранилища человеку ничего не говорят. */
function publicError(reply: FastifyReply, error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;

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

async function taskFavoritesModule(
  fastify: FastifyInstance,
  opts: { favorites: TaskFavoritesService },
): Promise<void> {
  const { favorites } = opts;

  const run = (
    operation: (request: FastifyRequest<{ Params: { taskId: string } }>) => Promise<unknown>,
  ) => async (
    request: FastifyRequest<{ Params: { taskId: string } }>,
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

  fastify.get('/api/b24/task-favorites', run(() => favorites.list()));
  fastify.put('/api/b24/task-favorites/:taskId', run((request) => {
    const taskId = normalizeFavoriteTaskId(request.params.taskId);
    return favorites.add(taskId);
  }));
  fastify.delete('/api/b24/task-favorites/:taskId', run((request) => {
    const taskId = normalizeFavoriteTaskId(request.params.taskId);
    return favorites.remove(taskId);
  }));
}

export default fp(taskFavoritesModule, { name: 'module-task-favorites' });
