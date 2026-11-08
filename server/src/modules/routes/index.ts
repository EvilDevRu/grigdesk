// Модуль routes — проекты и их маршруты.
// Маршрут живёт ТОЛЬКО опубликованным immutable-бандлом
// (`factory/routes/<профиль>/` в папке данных):
// ревизии по content-addressed хешу + указатель current.json. HTTP-поверхность — api.js.
//
// Редактируемого legacy-стора `routes/<проект>/<id>.json` больше нет. Он ничего не
// исполнял: движок читал profile.sh и graph.json, а apply у reseed был отключён ещё
// раньше — вторая «схема» рядом с бандлом только путала, чью правку увидит прогон.
// Проекты, заведённые в GrigDesk, держались подпапкой этого стора; теперь их реестр —
// prefs.projects, где и так лежат их пути репозиториев для плагина «Код».
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { listProjects } from '../../lib/profiles.ts';
import type { ProjectsPrefsPort } from '../../lib/profiles.ts';
import { PrefsCorruptedError } from '../../lib/prefsStore.ts';
import { ProjectsError } from '../projects/errors.ts';
import { registerRoutesApi } from './api.ts';
import { registerRoutesEditorApi } from './editorApi.ts';
import { CatalogObserver } from './catalogObserver.ts';
import type { CatalogObserverScheduler } from './catalogObserver.ts';
import { RoutesStore } from './store.ts';
import type { GrigDeskConfig } from '../../config.ts';

// Реестр проектов GrigDesk живёт в ещё нетипизированном сторе настроек: объявлено
// ровно то, что читает и пишет этот модуль.
export interface RoutesPrefsPort extends ProjectsPrefsPort {
  read: () => { projects?: Record<string, unknown> };
  write: (patch: { projects: Record<string, unknown> }) => unknown;
}

export interface RoutesModuleOptions {
  config: Pick<GrigDeskConfig, 'routesDir' | 'profilesDir'> & {
    routesAuthoringDir?: string;
    pipelineSampleDir?: string;
  };
  prefs: RoutesPrefsPort;
  catalogScheduler?: CatalogObserverScheduler;
}

async function routesModule(fastify: FastifyInstance, opts: RoutesModuleOptions): Promise<void> {
  const { config, prefs } = opts;
  const store = new RoutesStore({ baseDir: config.routesDir });
  const observer = new CatalogObserver(store, (profile, snapshot) => {
    fastify.sse?.broadcast?.('routes-catalog-changed', { profile, ...snapshot });
  }, {
    scheduler: opts.catalogScheduler,
    onError: (error) => fastify.log.warn({ err: error }, 'routes observer: проверка current'),
  });
  fastify.addHook('onClose', async () => observer.close());
  await registerRoutesApi(fastify, {
    store,
    observer,
    profilesDir: config.profilesDir,
  });
  await registerRoutesEditorApi(fastify, {
    routesStore: store,
    observer,
    authoringDir: config.routesAuthoringDir ?? `${config.routesDir}.authoring`,
    profilesDir: config.profilesDir,
    prefs,
    pipelineSampleDir: config.pipelineSampleDir,
  });

  // ── Проекты ──
  fastify.get('/api/profiles', async () => ({ profiles: await listProjects(config, prefs) }));

  // Новый проект GrigDesk — запись реестра паспортов; дальше ему задают пути репозиториев
  // («Проекты»), и его видит плагин «Код». Заводит её сервис раздела «Проекты»: у реестра
  // одна очередь мутаций, одна ревизия и одно событие на оба входа, а своя очередь здесь
  // означала бы две независимые записи в тот же файл настроек.
  // Профиль фабрики так НЕ заводится: его route-контракт создают вручную по
  // PROFILE-CONTRACT/NEW-PROJECT, а GrigDesk не подделывает локальный каталог profiles/.
  fastify.post('/api/profiles', async (
    req: FastifyRequest<{ Body: { id?: unknown } | null }>,
    reply,
  ) => {
    const projects = fastify.projects;

    if (!projects) {
      throw new Error('module-projects не зарегистрирован: POST /api/profiles без него не работает');
    }

    const id = String(req.body?.id || '').trim();

    try {
      await projects.create({
        id,
        title: id,
        description: '',
        tags: [],
        repos: [],
        defaultRepoKey: null,
      });
    } catch (err) {
      if (err instanceof ProjectsError) {
        return reply.code(err.status).send({ error: err.code, message: err.message });
      }
      if (err instanceof PrefsCorruptedError) {
        return reply.code(500).send({ error: 'prefs_corrupted', message: err.message });
      }
      throw err;
    }

    return { ok: true, profiles: await listProjects(config, prefs) };
  });
}

export default fp(routesModule, { name: 'module-routes' });
