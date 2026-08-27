// Account-scoped полка B24-задач. Роуты меняют только state Cockpit и живо
// закрываются гейтом системного плагина; общий auth guard уже закрывает весь /api.
import fp from 'fastify-plugin';
import { normalizeShelfTaskId } from '../../lib/task-shelf-store.js';

function publicError(reply, error) {
  if (error?.code === 'BAD_SHELF_TASK_ID') {
    return reply.code(400).send({ error: 'bad_task_id', message: 'Некорректный номер задачи.' });
  }
  if (error?.code === 'BAD_SHELF_REQUEST') {
    return reply.code(400).send({ error: 'bad_request', message: 'Некорректная запись полки.' });
  }
  if (error?.code === 'B24_IDENTITY_UNAVAILABLE') {
    return reply.code(503).send({
      error: 'b24_identity_unavailable',
      message: 'Не удалось определить текущего пользователя Битрикс24.',
    });
  }
  if (['TASK_SHELF_CORRUPT', 'TASK_SHELF_UNAVAILABLE'].includes(error?.code)) {
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

async function taskShelfModule(fastify, opts) {
  const { shelf } = opts;

  const run = (operation, { mutation = false } = {}) => async (request, reply) => {
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
      request.log?.error?.({ code: error?.code }, 'Ошибка полки задач');
      return publicError(reply, error);
    }
  };

  fastify.get('/api/b24/task-shelf', run(() => shelf.list()));
  fastify.put('/api/b24/task-shelf/:taskId', run((request) => {
    const taskId = normalizeShelfTaskId(request.params.taskId);
    return shelf.put(taskId, request.body);
  }, { mutation: true }));
  fastify.delete('/api/b24/task-shelf/:taskId', run((request) => {
    const taskId = normalizeShelfTaskId(request.params.taskId);
    return shelf.remove(taskId);
  }, { mutation: true }));
}

export default fp(taskShelfModule, { name: 'module-task-shelf' });
