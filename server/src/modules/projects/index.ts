// Модуль projects — раздел «Проекты»: паспорта проектов и пути их репозиториев на диске.
//
// Вся логика живёт в сервисе (`service.ts`): здесь только HTTP-поверхность §1.3 —
// разбор пути и тела, вызов сервиса и превращение его отказа в код ответа. Сервис
// декорируется на экземпляр (`fastify.projects`): им же пользуется модуль routes,
// заводя проект через POST /api/profiles.
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { PrefsCorruptedError } from '../../lib/prefsStore.ts';
import { createProjectsService } from './service.ts';
import { ProjectsError } from './errors.ts';
import type { PrefsStore } from '../../lib/prefsStore.ts';
import type { ProjectsService, ProjectsServiceConfig } from './service.ts';

export interface ProjectsModuleOptions {
  config: ProjectsServiceConfig;
  prefs: PrefsStore;
  // Готовый сервис передаёт сборка приложения (B1.3): ей нужен bootstrap до регистрации.
  service?: ProjectsService;
}

interface ProjectParams {
  Params: { id: string };
}

/** Отказ раздела в форме §1.2: код для машины, текст для человека и подробности формы. */
function failure(reply: FastifyReply, err: unknown): unknown {
  if (err instanceof ProjectsError) {
    return reply.code(err.status).send({
      error: err.code,
      message: err.message,
      ...(err.fieldErrors ? { fieldErrors: err.fieldErrors } : {}),
      ...(err.currentRevision === undefined ? {} : { currentRevision: err.currentRevision }),
    });
  }
  // Файл настроек не читается — запись отклонена целиком: клиенту нужен не «внутренний
  // сбой», а понятная причина, по которой паспорт не сохранён.
  if (err instanceof PrefsCorruptedError) {
    return reply.code(500).send({ error: 'prefs_corrupted', message: err.message });
  }

  throw err;
}

async function projectsModule(
  fastify: FastifyInstance,
  opts: ProjectsModuleOptions,
): Promise<void> {
  const { config, prefs } = opts;
  const service = opts.service ?? createProjectsService({
    config,
    prefs,
    broadcast: (event, data) => fastify.sse?.broadcast?.(event, data),
  });

  fastify.decorate('projects', service);

  fastify.get('/api/projects', async (_request, reply) => {
    try {
      return { projects: await service.list() };
    } catch (err) {
      return failure(reply, err);
    }
  });

  fastify.get<ProjectParams>('/api/projects/:id', async (request, reply) => {
    try {
      return await service.read(request.params.id);
    } catch (err) {
      return failure(reply, err);
    }
  });

  fastify.post('/api/projects', async (request: FastifyRequest, reply) => {
    try {
      return await reply.code(201).send(await service.create(request.body));
    } catch (err) {
      return failure(reply, err);
    }
  });

  fastify.put<ProjectParams>('/api/projects/:id', async (request, reply) => {
    const body = (request.body ?? {}) as { expectedRevision?: unknown };

    try {
      return await service.update(request.params.id, request.body, body.expectedRevision);
    } catch (err) {
      return failure(reply, err);
    }
  });

  fastify.delete<ProjectParams>('/api/projects/:id', async (request, reply) => {
    const body = (request.body ?? {}) as { expectedRevision?: unknown };

    try {
      await service.remove(request.params.id, body.expectedRevision);

      return reply.code(204).send();
    } catch (err) {
      return failure(reply, err);
    }
  });

  // Связи проекта: форма показывает их перед архивом, чтобы человек видел, что мешает.
  fastify.get<ProjectParams>('/api/projects/:id/dependencies', async (request, reply) => {
    try {
      return await service.dependencies(request.params.id);
    } catch (err) {
      return failure(reply, err);
    }
  });

  fastify.post<ProjectParams>('/api/projects/:id/archive', async (request, reply) => {
    const body = (request.body ?? {}) as { expectedRevision?: unknown };

    try {
      return await service.archive(request.params.id, body.expectedRevision);
    } catch (err) {
      return failure(reply, err);
    }
  });

  fastify.post<ProjectParams>('/api/projects/:id/restore', async (request, reply) => {
    const body = (request.body ?? {}) as { expectedRevision?: unknown };

    try {
      return await service.restore(request.params.id, body.expectedRevision);
    } catch (err) {
      return failure(reply, err);
    }
  });

  // Проверка путей без сохранения: форма спрашивает по каждому репозиторию отдельно,
  // а паспорт при этом не меняется. Ограничение параллельности — в библиотеке.
  fastify.post('/api/project-tools/repositories/check', async (request: FastifyRequest, reply) => {
    const body = (request.body ?? {}) as { repos?: unknown };
    const rows = Array.isArray(body.repos) ? body.repos : null;

    if (rows === null) {
      return reply.code(400).send({
        error: 'bad_request',
        message: 'Ожидался список репозиториев: { repos: [{ dir }] }.',
      });
    }

    const dirs: string[] = [];

    for (const row of rows) {
      const dir = typeof (row as { dir?: unknown })?.dir === 'string'
        ? String((row as { dir: string }).dir).trim()
        : '';

      // Абсолютность проверяется здесь же, до диска: относительный путь означал бы
      // проверку «относительно чего-то», а такого понятия у паспорта нет.
      if (!dir.startsWith('/') || dir.includes('\u0000')) {
        return reply.code(400).send({
          error: 'bad_dir',
          message: `Путь «${dir}» должен быть абсолютным.`,
        });
      }

      dirs.push(dir);
    }

    return { results: await service.checkRepositories(dirs) };
  });
}

export default fp(projectsModule, { name: 'module-projects' });
