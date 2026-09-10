// Модуль routes — проекты и их маршруты.
// Маршрут живёт ТОЛЬКО опубликованным immutable-бандлом (`~/.factory/routes/<профиль>/`):
// ревизии по content-addressed хешу + указатель current.json. HTTP-поверхность — api.js.
//
// Редактируемого legacy-стора `routes/<проект>/<id>.json` больше нет. Он ничего не
// исполнял: движок читал profile.sh и graph.json, а apply у reseed был отключён ещё
// раньше — вторая «схема» рядом с бандлом только путала, чью правку увидит прогон.
// Проекты, заведённые в кокпите, держались подпапкой этого стора; теперь их реестр —
// prefs.projects, где и так лежат их пути репозиториев для плагина «Код».
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { listProjects, PROFILE_RE } from '../../lib/profiles.ts';
import type { ProjectsPrefsPort } from '../../lib/profiles.ts';
import { registerRoutesApi } from './api.ts';
import type { CockpitConfig } from '../../config.ts';

// Реестр проектов кокпита живёт в ещё нетипизированном сторе настроек: объявлено
// ровно то, что читает и пишет этот модуль.
export interface RoutesPrefsPort extends ProjectsPrefsPort {
  read: () => { projects?: Record<string, unknown> };
  write: (patch: { projects: Record<string, unknown> }) => unknown;
}

export interface RoutesModuleOptions {
  config: Pick<CockpitConfig, 'routesDir' | 'profilesDir'>;
  prefs: RoutesPrefsPort;
}

async function routesModule(fastify: FastifyInstance, opts: RoutesModuleOptions): Promise<void> {
  const { config, prefs } = opts;
  await registerRoutesApi(fastify, {
    baseDir: config.routesDir,
    profilesDir: config.profilesDir,
  });

  let mutationQueue: Promise<unknown> = Promise.resolve();
  const mutate = <Value>(operation: () => Promise<Value>): Promise<Value> => {
    const result = mutationQueue.then(operation, operation);
    mutationQueue = result.catch(() => {});
    return result;
  };

  // ── Проекты ──
  fastify.get('/api/profiles', async () => ({ profiles: await listProjects(config, prefs) }));

  // Новый проект кокпита — запись в реестре prefs; дальше ему задают пути репозиториев
  // («Проекты»), и его видит плагин «Код». Профиль фабрики так НЕ заводится: его
  // route-контракт создают вручную по PROFILE-CONTRACT/NEW-PROJECT, а кокпит не подделывает
  // локальный каталог profiles/.
  fastify.post('/api/profiles', async (
    req: FastifyRequest<{ Body: { id?: unknown } | null }>,
    reply,
  ) => {
    return mutate(async () => {
      const id = String(req.body?.id || '').trim();
      if (!PROFILE_RE.test(id)) {
        return reply.code(400).send({ error: 'bad_id', message: 'id: строчные латиница/цифры/-/_' });
      }
      const existing = await listProjects(config, prefs);
      if (existing.includes(id)) {
        return reply.code(409).send({ error: 'exists', message: `проект «${id}» уже есть` });
      }
      const saved = prefs.read().projects || {};
      prefs.write({ projects: { ...saved, [id]: { repos: [] } } });
      return { ok: true, profiles: await listProjects(config, prefs) };
    });
  });
}

export default fp(routesModule, { name: 'module-routes' });
