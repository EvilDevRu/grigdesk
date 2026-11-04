// Модуль трекера — доска «Рабочего стола», детали задач и управляемые мутации портала.
// Все действия проходят через единый сериализованный фасад трекера с общей сессией.
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { TrackerFacade } from '../../lib/trackers/facade.ts';
import { TrackerError } from '../../lib/trackers/contract.ts';
import type { TrackerReadOptions } from '../../lib/trackers/contract.ts';
import { withTrackerRequestRead } from '../../lib/trackers/requestRead.ts';
import {
  TrackerValidationError,
  normalizeTaskUpdateFields,
  checklistItemId,
  normalizeChecklistAdd,
  normalizeChecklistUpdate,
  normalizeTaskTags,
} from '../../lib/trackers/taskFields.ts';

export interface TrackerModuleOptions {
  tracker: TrackerFacade;
}

// Свободная запись портала: форму задаёт внешний драйвер.
type Payload = Record<string, unknown>;

// Маршруты этого модуля: у всех задачных ручек один и тот же параметр адреса.
type TaskRoute = {
  Params: {
    id: string;
    action?: string;
    itemId?: string;
  };
  Querystring: { q?: string };
  Body: unknown;
};

/** Текст отказа портала: до сюда доезжают и ошибки сети, и брошенные строки. */
function failureText(error: unknown): string {
  return String((error as { message?: unknown } | null)?.message || error);
}

/**
 * Прежние HTTP-пути делегируют операции общему фасаду выбранного трекера.
 * Сервер сохраняет разрешение media-имён и проверку поколения новых клиентов.
 */
async function trackerModule(fastify: FastifyInstance, opts: TrackerModuleOptions): Promise<void> {
  const { tracker } = opts;

  // Новые клиенты фиксируют поколение при подготовке мутации.
  // Legacy HTTP и CLI без заголовка продолжают обращаться к текущему выбору.
  const assertGeneration = (request: FastifyRequest) => {
    if (!request.url.startsWith('/api/tracker/')) {
      return;
    }

    const generation = request.headers['x-grigdesk-tracker-generation'];

    if (generation !== undefined) {
      if (typeof generation !== 'string' || !/^\d+$/.test(generation)) {
        throw new TrackerError('tracker_context_changed', 'Некорректное поколение трекера', 409);
      }

      (tracker as TrackerFacade).assertContext?.(Number(generation));
    }
  };

  /**
   * Дополняет неизменённые данные портала разрешёнными Telegram-обсуждениями.
   * Одна функция обслуживает чтение и ответ после редактирования, чтобы DTO не расходились.
   */
  const taskWithDiscussion = async (id: string, options: TrackerReadOptions = {}): Promise<unknown> => {
    const task = await tracker.taskDetail(id, options) as Payload | null;

    if (typeof fastify.telegramDiscussion !== 'function' || !task) {
      return task;
    }

    const text = [task.title, task.description].filter(Boolean).join('\n');
    const telegram = await fastify.telegramDiscussion(text) as { links?: unknown[] };

    return telegram?.links?.length ? { ...task, telegram } : task;
  };

  // Полный дашборд: задачи + на контроле + я поставил + показатели + графики.
  fastify.get('/api/tracker/dashboard', async (request, reply) => {
    try {
      return await withTrackerRequestRead(request, reply,
        (options) => tracker.getDashboard(options));
    } catch (err) {
      const message = failureText(err);
      const known = err instanceof TrackerError;

      return reply.code(known ? err.status : 502).send({
        error: known ? err.code : 'tracker_error',
        message,
      });
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
  // регистрируется ПОЗЖЕ tracker, а к первому запросу он уже на месте. Выключенный
  // плагин, сломанный архив или молчащий Телеграм отдают пустоту — карточка
  // задачи открывается в любом случае (см. modules/telegram).
  fastify.get<TaskRoute>('/api/tracker/task/:id', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');

    if (!id) {
      return reply.code(400).send({ error: 'bad_task_id' });
    }

    try {
      assertGeneration(request);

      const context = (tracker as TrackerFacade).captureContext?.();
      const result = await withTrackerRequestRead(request, reply,
        (options) => taskWithDiscussion(id, options));

      if (context) {
        (tracker as TrackerFacade).assertContext(context);
      }

      return result;
    } catch (err) {
      if (err instanceof TrackerError && err.status === 409) {
        return reply.code(409).send({ error: err.code, message: err.message });
      }

      return reply.code(502).send({ error: 'tracker_error', message: failureText(err) });
    }
  });

  // Поиск пользователей (для выбора исполнителя).
  fastify.get<TaskRoute>('/api/tracker/users', async (request, reply) => {
    try {
      const users = await withTrackerRequestRead(request, reply,
        (options) => tracker.findUsers(request.query.q || '', options));

      return { users };
    } catch (err) {
      return reply.code(502).send({ error: 'tracker_error', message: failureText(err) });
    }
  });

  // Доступные текущему пользователю проекты/рабочие группы для поля GROUP_ID задачи.
  fastify.get('/api/tracker/groups', async (request, reply) => {
    try {
      const groups = await withTrackerRequestRead(request, reply,
        (options) => tracker.listGroups(options));

      return { groups };
    } catch (err) {
      return reply.code(502).send({ error: 'tracker_error', message: failureText(err) });
    }
  });

  // --- Действия (мутации; требуют токен, если задан). ---
  const wrap = (
    fn: (request: FastifyRequest<TaskRoute>) => Promise<unknown> | unknown,
  ) => async (request: FastifyRequest<TaskRoute>, reply: FastifyReply) => {
    try {
      assertGeneration(request);

      return await fn(request);
    } catch (err) {
      const badRequest = err instanceof TrackerValidationError;
      const trackerError = err instanceof TrackerError;

      return reply.code(trackerError ? err.status : badRequest ? 400 : 502).send({
        error: trackerError || badRequest ? err.code : 'tracker_error',
        message: failureText(err),
      });
    }
  };
  const taskId = (request: FastifyRequest<TaskRoute>) => (
    String(request.params.id).replace(/[^0-9]/g, '')
  );

  /**
   * Новые мутации не превращают повреждённый адрес в номер другой задачи.
   * Прежняя очистка legacy-путей остаётся в их существующем обработчике.
   */
  const mutationTaskId = (request: FastifyRequest<TaskRoute>) => {
    const id = request.params.id;

    if (!/^\d+$/u.test(id)) {
      throw new TrackerValidationError('Некорректный номер задачи');
    }

    return id;
  };

  // Создание задачи. `frames` — кадры записи из раздела «Видео»: браузер присылает
  // ИМЯ кадра, а путь на диске подставляет сам media (декоратор `mediaFramePath`).
  // Принимать путь от клиента здесь нельзя: это ручка, которая грузит файлы на портал,
  // и произвольный путь означал бы «залей туда что скажу». Ссылка ленивая — модуль
  // media регистрируется отдельно, а при выключенном плагине кадров просто нет.
  fastify.post<TaskRoute>('/api/tracker/tasks', wrap((r) => {
    const body = { ...((r.body || {}) as Payload) };

    (tracker as TrackerFacade).assertAttachments?.(body);

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

      if (files.length) {
        body.images = [...(Array.isArray(body.images) ? body.images : []), ...files];
      }
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
      if (files.length) {
        body.images = [...(Array.isArray(body.images) ? body.images : []), ...files];
      }
    }

    return tracker.createTask(body);
  }));

  fastify.put<TaskRoute>('/api/tracker/task/:id', wrap(async (r) => {
    const id = taskId(r);

    if (!id) {
      throw new TrackerValidationError('Некорректный номер задачи');
    }

    const fields = normalizeTaskUpdateFields(r.body);
    const context = (tracker as TrackerFacade).captureContext?.();

    await tracker.updateTask(id, fields);

    if (context) {
      (tracker as TrackerFacade).assertContext(context);
    }

    return taskWithDiscussion(id);
  }));
  fastify.post<TaskRoute>('/api/tracker/task/:id/comment', wrap((r) => tracker.addComment(
    taskId(r),
    ((r.body || {}) as Payload).text || '',
  )));

  // Комментарии задачи (для таба в модалке): без системных, свежие снизу.
  fastify.get<TaskRoute>('/api/tracker/task/:id/comments', async (request, reply) => {
    try {
      const page = await withTrackerRequestRead(request, reply,
        (options) => tracker.taskPageData(taskId(request), options)) as Payload;
      const comments = Array.isArray(page.comments) ? page.comments as Payload[] : [];

      return {
        comments: comments.filter((comment) => !comment.isSystem),
        ...(Array.isArray(page.tags) ? { tags: page.tags } : {}),
        ...(Array.isArray(page.subtasks) ? { subtasks: page.subtasks } : {}),
      };
    } catch (error) {
      return reply.code(502).send({ error: 'tracker_error', message: failureText(error) });
    }
  });

  fastify.post<TaskRoute>('/api/tracker/task/:id/timer/:action', wrap((r) => {
    const a = String(r.params.action ?? '');

    if (!['start', 'pause', 'stop'].includes(a)) {
      throw new Error(`неизвестное действие таймера: ${a}`);
    }

    return tracker.timer(a, taskId(r));
  }));

  fastify.delete<TaskRoute>('/api/tracker/task/:id', wrap(async (r) => {
    const id = taskId(r);

    if (!id) {
      throw new TrackerValidationError('Некорректный номер задачи');
    }

    await tracker.deleteTask(id);

    return { ok: true };
  }));

  fastify.post<TaskRoute>('/api/tracker/task/:id/complete', wrap((r) => tracker.completeTask(taskId(r))));
  fastify.post<TaskRoute>('/api/tracker/task/:id/renew', wrap((r) => tracker.renewTask(taskId(r))));

  fastify.post<TaskRoute>('/api/tracker/task/:id/checklist', wrap((r) => (
    tracker.addChecklistItem(mutationTaskId(r), normalizeChecklistAdd(r.body))
  )));
  fastify.put<TaskRoute>('/api/tracker/task/:id/checklist/:itemId', wrap((r) => (
    tracker.updateChecklistItem(mutationTaskId(r), checklistItemId(r.params.itemId),
      normalizeChecklistUpdate(r.body))
  )));
  fastify.delete<TaskRoute>('/api/tracker/task/:id/checklist/:itemId', wrap((r) => (
    tracker.deleteChecklistItem(mutationTaskId(r), checklistItemId(r.params.itemId))
  )));
  fastify.put<TaskRoute>('/api/tracker/task/:id/tags', wrap((r) => (
    tracker.updateTaskTags(mutationTaskId(r), normalizeTaskTags(r.body))
  )));
  fastify.post<TaskRoute>('/api/tracker/task/:id/approve', wrap((r) => (
    tracker.approveTask(mutationTaskId(r))
  )));
  fastify.post<TaskRoute>('/api/tracker/task/:id/disapprove', wrap((r) => (
    tracker.disapproveTask(mutationTaskId(r))
  )));
}

export default fp(trackerModule, { name: 'module-tracker' });
