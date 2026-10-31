// Модуль b24 — доска «Рабочего стола», детали задач и управляемые мутации портала.
// Все действия проходят через единый сериализованный B24Adapter с общей сессией.
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { B24Adapter } from '../../adapters/b24.ts';
import type { B24ReadOptions } from '../../lib/b24/readOperations.ts';
import { withB24RequestRead } from '../../lib/b24/requestRead.ts';
import {
  B24ValidationError,
  normalizeTaskUpdateFields,
} from '../../lib/b24/client.ts';

export interface B24ModuleOptions {
  b24: B24Adapter;
}

// Свободная запись портала: форму задают ответы Битрикса.
type Payload = Record<string, unknown>;

// Маршруты этого модуля: у всех задачных ручек один и тот же параметр адреса.
type TaskRoute = {
  Params: { id: string; action?: string };
  Querystring: { q?: string };
  Body: unknown;
};

/** Текст отказа портала: до сюда доезжают и ошибки сети, и брошенные строки. */
function failureText(error: unknown): string {
  return String((error as { message?: unknown } | null)?.message || error);
}

async function b24Module(fastify: FastifyInstance, opts: B24ModuleOptions): Promise<void> {
  const { b24 } = opts;

  /**
   * Дополняет неизменённые данные портала разрешёнными Telegram-обсуждениями.
   * Одна функция обслуживает чтение и ответ после редактирования, чтобы DTO не расходились.
   */
  const taskWithDiscussion = async (id: string, options: B24ReadOptions = {}): Promise<unknown> => {
    const task = await b24.taskDetail(id, options) as Payload | null;

    if (typeof fastify.telegramDiscussion !== 'function' || !task) return task;

    const text = [task.title, task.description].filter(Boolean).join('\n');
    const telegram = await fastify.telegramDiscussion(text) as { links?: unknown[] };

    return telegram?.links?.length ? { ...task, telegram } : task;
  };

  // Полный дашборд: задачи + на контроле + я поставил + показатели + графики.
  fastify.get('/api/b24/dashboard', async (request, reply) => {
    try {
      return await withB24RequestRead(request, reply,
        (options) => b24.getDashboard(options));
    } catch (err) {
      const message = failureText(err);
      const notConfigured = /не настроен/i.test(message);

      return reply.code(notConfigured ? 400 : 502).send({ error: 'b24_error', message });
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
  fastify.get<TaskRoute>('/api/b24/task/:id', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });

    try {
      return await withB24RequestRead(request, reply,
        (options) => taskWithDiscussion(id, options));
    } catch (err) {
      return reply.code(502).send({ error: 'b24_error', message: failureText(err) });
    }
  });

  // Поиск пользователей (для выбора исполнителя).
  fastify.get<TaskRoute>('/api/b24/users', async (request, reply) => {
    try {
      const users = await withB24RequestRead(request, reply,
        (options) => b24.findUsers(request.query.q || '', options));

      return { users };
    } catch (err) {
      return reply.code(502).send({ error: 'b24_error', message: failureText(err) });
    }
  });

  // Доступные текущему пользователю проекты/рабочие группы для поля GROUP_ID задачи.
  fastify.get('/api/b24/groups', async (request, reply) => {
    try {
      const groups = await withB24RequestRead(request, reply,
        (options) => b24.listGroups(options));

      return { groups };
    } catch (err) {
      return reply.code(502).send({ error: 'b24_error', message: failureText(err) });
    }
  });

  // --- Действия (мутации; требуют токен, если задан). ---
  const wrap = (
    fn: (request: FastifyRequest<TaskRoute>) => Promise<unknown> | unknown,
  ) => async (request: FastifyRequest<TaskRoute>, reply: FastifyReply) => {
    try {
      return await fn(request);
    } catch (err) {
      const badRequest = err instanceof B24ValidationError;

      return reply.code(badRequest ? 400 : 502).send({
        error: badRequest ? err.code : 'b24_error',
        message: failureText(err),
      });
    }
  };
  const taskId = (request: FastifyRequest<TaskRoute>) => (
    String(request.params.id).replace(/[^0-9]/g, '')
  );

  // Создание задачи. `frames` — кадры записи из раздела «Видео»: браузер присылает
  // ИМЯ кадра, а путь на диске подставляет сам media (декоратор `mediaFramePath`).
  // Принимать путь от клиента здесь нельзя: это ручка, которая грузит файлы на портал,
  // и произвольный путь означал бы «залей туда что скажу». Ссылка ленивая — модуль
  // media регистрируется отдельно, а при выключенном плагине кадров просто нет.
  fastify.post<TaskRoute>('/api/b24/tasks', wrap((r) => {
    const body = { ...((r.body || {}) as Payload) };
    const names = Array.isArray(body.frames) ? body.frames : [];
    const clips = Array.isArray(body.clips) ? body.clips : [];
    delete body.frames;
    delete body.clips;
    // Фрагмент записи — такое же вложение по ИМЕНИ, что и кадр, и путь ему так же
    // подставляет сам media. На портал уезжает только вырезанный кусок вокруг места
    // задачи: сама встреча остаётся в GrigDesk, и «залей запись целиком» этот путь не
    // умеет — длину куска ограничивает нарезка, а имя проверяется буквально.
    if (clips.length && typeof fastify.mediaClipPath === 'function') {
      const paths = clips
        .map((name) => fastify.mediaClipPath?.(String(name)))
        .filter((value): value is string => Boolean(value));
      const files = paths.map((path, i) => ({
        path,
        name: i ? `фрагмент-${i + 1}.mp4` : 'фрагмент.mp4',
      }));
      if (files.length) body.images = [...(Array.isArray(body.images) ? body.images : []), ...files];
    }
    if (names.length && typeof fastify.mediaFramePath === 'function') {
      const paths = names
        .map((name) => fastify.mediaFramePath?.(String(name)))
        .filter((value): value is string => Boolean(value));
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

  fastify.put<TaskRoute>('/api/b24/task/:id', wrap(async (r) => {
    const id = taskId(r);
    if (!id) {
      throw new B24ValidationError('Некорректный номер задачи');
    }

    const fields = normalizeTaskUpdateFields(r.body);
    await b24.updateTask(id, fields);
    return taskWithDiscussion(id);
  }));
  fastify.post<TaskRoute>('/api/b24/task/:id/comment', wrap((r) => b24.addComment(
    taskId(r),
    ((r.body || {}) as Payload).text || '',
  )));

  // Комментарии задачи (для таба в модалке): без системных, свежие снизу.
  fastify.get<TaskRoute>('/api/b24/task/:id/comments', async (request, reply) => {
    try {
      const page = await withB24RequestRead(request, reply,
        (options) => b24.taskPageData(taskId(request), options)) as Payload;
      const comments = Array.isArray(page.comments) ? page.comments as Payload[] : [];

      return { comments: comments.filter((comment) => !comment.isSystem) };
    } catch (error) {
      return reply.code(502).send({ error: 'b24_error', message: failureText(error) });
    }
  });

  fastify.post<TaskRoute>('/api/b24/task/:id/timer/:action', wrap((r) => {
    const a = String(r.params.action ?? '');

    if (!['start', 'pause', 'stop'].includes(a)) {
      throw new Error(`неизвестное действие таймера: ${a}`);
    }

    return b24.timer(a, taskId(r));
  }));

  fastify.post<TaskRoute>('/api/b24/task/:id/complete', wrap((r) => b24.completeTask(taskId(r))));
  fastify.post<TaskRoute>('/api/b24/task/:id/renew', wrap((r) => b24.renewTask(taskId(r))));
}

export default fp(b24Module, { name: 'module-b24' });
