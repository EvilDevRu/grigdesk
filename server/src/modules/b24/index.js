// Модуль b24 — доска «Рабочего стола» (read-only на этом этапе).
// Мутации (взять в работу, направить на конвейер) добавятся отдельно — у них реальные
// побочные эффекты (таймер B24, запуск фабрики).
import fp from 'fastify-plugin';

async function b24Module(fastify, opts) {
  const { b24 } = opts;

  // Полный дашборд: задачи + на контроле + я поставил + показатели + графики.
  fastify.get('/api/b24/dashboard', async (request, reply) => {
    try {
      return await b24.getDashboard();
    } catch (err) {
      const notConfigured = /не настроен/i.test(err.message);
      return reply.code(notConfigured ? 400 : 502).send({ error: 'b24_error', message: err.message });
    }
  });

  // Детали одной задачи.
  fastify.get('/api/b24/task/:id', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });
    try {
      return await b24.taskDetail(id);
    } catch (err) {
      return reply.code(502).send({ error: 'b24_error', message: err.message });
    }
  });

  // Поиск пользователей (для выбора исполнителя).
  fastify.get('/api/b24/users', async (request, reply) => {
    try {
      return { users: await b24.findUsers(request.query.q || '') };
    } catch (err) {
      return reply.code(502).send({ error: 'b24_error', message: err.message });
    }
  });

  // --- Действия (мутации; требуют токен, если задан). ---
  const wrap = (fn) => async (request, reply) => {
    try { return await fn(request); }
    catch (err) { return reply.code(502).send({ error: 'b24_error', message: err.message }); }
  };
  const taskId = (request) => String(request.params.id).replace(/[^0-9]/g, '');

  fastify.post('/api/b24/tasks', wrap((r) => b24.createTask(r.body || {})));
  fastify.post('/api/b24/task/:id/comment', wrap((r) => b24.addComment(taskId(r), (r.body || {}).text || '')));
  // Комментарии задачи (для таба в модалке): без системных, свежие снизу.
  fastify.get('/api/b24/task/:id/comments', wrap(async (r) => {
    const page = await b24.taskPageData(taskId(r));
    return { comments: (page.comments || []).filter((c) => !c.isSystem) };
  }));
  fastify.post('/api/b24/task/:id/timer/:action', wrap((r) => {
    const a = r.params.action;
    if (!['start', 'pause', 'stop'].includes(a)) throw new Error(`неизвестное действие таймера: ${a}`);
    return b24.timer(a, taskId(r));
  }));
  fastify.post('/api/b24/task/:id/complete', wrap((r) => b24.completeTask(taskId(r))));
  fastify.post('/api/b24/task/:id/renew', wrap((r) => b24.renewTask(taskId(r))));
}

export default fp(b24Module, { name: 'module-b24' });
