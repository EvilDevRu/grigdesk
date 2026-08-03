// Локальное избранное B24-задач. Мутации меняют только state Cockpit и не пишут в B24.
import fp from 'fastify-plugin';
import { normalizeFavoriteTaskId } from '../../lib/task-favorites-store.js';

function publicError(reply, error) {
  if (error?.code === 'BAD_FAVORITE_TASK_ID') {
    return reply.code(400).send({
      error: 'bad_task_id',
      message: 'Некорректный номер задачи.',
    });
  }
  if (error?.code === 'B24_IDENTITY_UNAVAILABLE') {
    return reply.code(503).send({
      error: 'b24_identity_unavailable',
      message: 'Не удалось определить текущего пользователя Битрикс24.',
    });
  }
  if (['TASK_FAVORITES_CORRUPT', 'TASK_FAVORITES_UNAVAILABLE'].includes(error?.code)) {
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

async function taskFavoritesModule(fastify, opts) {
  const { favorites } = opts;

  const run = (operation) => async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      return await operation(request);
    } catch (error) {
      request.log?.error?.({ code: error?.code }, 'Ошибка избранного задач');
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
