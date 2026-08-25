// Модуль b24 — доска «Рабочего стола», детали задач и управляемые мутации портала.
// Все действия проходят через единый сериализованный B24Adapter с общей сессией.
import fp from 'fastify-plugin';
import {
  B24ValidationError,
  normalizeTaskUpdateFields,
} from '../../lib/b24/b24-client.js';

async function b24Module(fastify, opts) {
  const { b24 } = opts;

  /**
   * Дополняет неизменённые данные портала разрешёнными Telegram-обсуждениями.
   * Одна функция обслуживает чтение и ответ после редактирования, чтобы DTO не расходились.
   */
  const taskWithDiscussion = async (id) => {
    const task = await b24.taskDetail(id);
    if (typeof fastify.telegramDiscussion !== 'function' || !task) return task;

    const text = [task.title, task.description].filter(Boolean).join('\n');
    const telegram = await fastify.telegramDiscussion(text);
    return telegram.links.length ? { ...task, telegram } : task;
  };

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
    try {
      return await taskWithDiscussion(id);
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
    catch (err) {
      const badRequest = err instanceof B24ValidationError;
      return reply.code(badRequest ? 400 : 502).send({
        error: badRequest ? err.code : 'b24_error',
        message: err.message,
      });
    }
  };
  const taskId = (request) => String(request.params.id).replace(/[^0-9]/g, '');

  // Создание задачи. `frames` — кадры записи из раздела «Видео»: браузер присылает
  // ИМЯ кадра, а путь на диске подставляет сам media (декоратор `mediaFramePath`).
  // Принимать путь от клиента здесь нельзя: это ручка, которая грузит файлы на портал,
  // и произвольный путь означал бы «залей туда что скажу». Ссылка ленивая — модуль
  // media регистрируется отдельно, а при выключенном плагине кадров просто нет.
  fastify.post('/api/b24/tasks', wrap((r) => {
    const body = { ...(r.body || {}) };
    const names = Array.isArray(body.frames) ? body.frames : [];
    const clips = Array.isArray(body.clips) ? body.clips : [];
    delete body.frames;
    delete body.clips;
    // Фрагмент записи — такое же вложение по ИМЕНИ, что и кадр, и путь ему так же
    // подставляет сам media. На портал уезжает только вырезанный кусок вокруг места
    // задачи: сама встреча остаётся в кокпите, и «залей запись целиком» этот путь не
    // умеет — длину куска ограничивает нарезка, а имя проверяется буквально.
    if (clips.length && typeof fastify.mediaClipPath === 'function') {
      const paths = clips.map((name) => fastify.mediaClipPath(name)).filter(Boolean);
      const files = paths.map((path, i) => ({
        path,
        name: i ? `фрагмент-${i + 1}.mp4` : 'фрагмент.mp4',
      }));
      if (files.length) body.images = [...(Array.isArray(body.images) ? body.images : []), ...files];
    }
    if (names.length && typeof fastify.mediaFramePath === 'function') {
      const paths = names.map((name) => fastify.mediaFramePath(name)).filter(Boolean);
      // На портале у вложения видно ИМЯ, а служебное `p0-00272s.jpg` читается мусором.
      // Таймкод в него не кладём: имя кадра несёт локальную секунду своей части, а в
      // описании задачи стоит сквозная — два разных числа сбивали бы с толку сильнее,
      // чем их отсутствие.
      const files = paths.map((path, i) => ({ path, name: i ? `запись-${i + 1}.jpg` : 'запись.jpg' }));
      // Исчезнувший кадр (истёк TTL, сменился разбор) задачу не отменяет: описание с
      // таймкодом на месте, и терять из-за картинки уже готовую постановку незачем.
      if (files.length) body.images = [...(Array.isArray(body.images) ? body.images : []), ...files];
    }
    return b24.createTask(body);
  }));
  fastify.put('/api/b24/task/:id', wrap(async (r) => {
    const id = taskId(r);
    if (!id) {
      throw new B24ValidationError('Некорректный номер задачи');
    }

    const fields = normalizeTaskUpdateFields(r.body);
    await b24.updateTask(id, fields);
    return taskWithDiscussion(id);
  }));
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
