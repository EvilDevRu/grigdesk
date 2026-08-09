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
  //
  // Плюс разворот телеграм-ссылок из текста задачи — ОТДЕЛЬНЫМ полем `telegram`.
  // Тело задачи при этом не меняется ни на байт: человек читает описание из
  // портала, а не нашу версию описания. Нашлось нечего — поля нет вовсе, чтобы
  // ответ обычной задачи остался прежним.
  //
  // Ссылка на декоратор ленивая (проверка в момент запроса): модуль telegram
  // регистрируется ПОЗЖЕ b24, а к первому запросу он уже на месте. Выключенный
  // плагин, сломанный архив или молчащий Телеграм отдают пустоту — карточка
  // задачи открывается в любом случае (см. modules/telegram).
  fastify.get('/api/b24/task/:id', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });
    let task;
    try {
      task = await b24.taskDetail(id);
    } catch (err) {
      return reply.code(502).send({ error: 'b24_error', message: err.message });
    }

    if (typeof fastify.telegramDiscussion !== 'function' || !task) return task;
    const telegram = await fastify.telegramDiscussion([task.title, task.description].filter(Boolean).join('\n'));
    return telegram.links.length ? { ...task, telegram } : task;
  });

  // Поиск пользователей (для выбора исполнителя).
  fastify.get('/api/b24/users', async (request, reply) => {
    try {
      return { users: await b24.findUsers(request.query.q || '') };
    } catch (err) {
      return reply.code(502).send({ error: 'b24_error', message: err.message });
    }
  });

  // Доступные текущему пользователю проекты/рабочие группы для поля GROUP_ID задачи.
  fastify.get('/api/b24/groups', async (request, reply) => {
    try {
      return { groups: await b24.listGroups() };
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
