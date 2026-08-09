// Просмотренные B24-задачи. Метки живут только в state кокпита и в B24 не пишутся.
import fp from 'fastify-plugin';
import { normalizeSeenTaskId } from '../../lib/task-seen-store.js';

// Потолок одного запроса: доска шлёт базовую линию списком, отдельный просмотр — одной
// задачей. Всё, что больше, — не наш клиент.
const MAX_TASK_IDS_PER_REQUEST = 1000;

class TaskSeenRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TaskSeenRequestError';
    this.code = 'BAD_SEEN_REQUEST';
  }
}

function parseMarkBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new TaskSeenRequestError('Тело запроса должно быть объектом');
  }
  const { taskIds, baseline } = body;
  if (!Array.isArray(taskIds) || taskIds.length > MAX_TASK_IDS_PER_REQUEST) {
    throw new TaskSeenRequestError('taskIds должен быть массивом номеров задач');
  }
  if (baseline !== undefined && typeof baseline !== 'boolean') {
    throw new TaskSeenRequestError('baseline должен быть булевым');
  }
  return { taskIds: taskIds.map(normalizeSeenTaskId), baseline: !!baseline };
}

function publicError(reply, error) {
  if (error?.code === 'BAD_SEEN_TASK_ID') {
    return reply.code(400).send({
      error: 'bad_task_id',
      message: 'Некорректный номер задачи.',
    });
  }
  if (error?.code === 'BAD_SEEN_REQUEST') {
    return reply.code(400).send({
      error: 'bad_request',
      message: 'Некорректный запрос отметки просмотра.',
    });
  }
  if (error?.code === 'B24_IDENTITY_UNAVAILABLE') {
    return reply.code(503).send({
      error: 'b24_identity_unavailable',
      message: 'Не удалось определить текущего пользователя Битрикс24.',
    });
  }
  if (['TASK_SEEN_CORRUPT', 'TASK_SEEN_UNAVAILABLE'].includes(error?.code)) {
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

async function taskSeenModule(fastify, opts) {
  const { seen } = opts;

  const run = (operation) => async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      return await operation(request);
    } catch (error) {
      request.log?.error?.({ code: error?.code }, 'Ошибка отметок просмотра задач');
      return publicError(reply, error);
    }
  };

  fastify.get('/api/b24/task-seen', run(() => seen.list()));
  fastify.post('/api/b24/task-seen', run((request) => {
    const { taskIds, baseline } = parseMarkBody(request.body);
    return seen.markSeen(taskIds, { baseline });
  }));
}

export default fp(taskSeenModule, { name: 'module-task-seen' });
