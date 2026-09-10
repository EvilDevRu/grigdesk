// Модуль projects — раздел «Проекты»: реестр проектов и пути их репозиториев на диске.
// Сам список проектов и их схемы уже живут в базе маршрутов (modules/routes); здесь —
// только «паспорт»: где лежит код. Для проектов фабрики пути читаются из bash-профиля
// (единственный источник правды), для кокпитных — редактируются здесь и живут в prefs.
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import { PROFILE_RE, listFactoryProfiles, listProjects } from '../../lib/profiles.ts';
import { projectsOverview } from '../../lib/projects.ts';
import type { PrefsStore } from '../../lib/prefsStore.ts';

// Серверный config в объёме, который читает раздел. Полная форма — в config.ts.
type ProjectsModuleConfig = {
  profilesDir: string;
  routesDir: string;
  factoryHome?: string;
};

export interface ProjectsModuleOptions {
  config: ProjectsModuleConfig;
  prefs: PrefsStore;
}

// Паспорт проекта правится по его id; тело — список репозиториев проекта.
interface ProjectRoute {
  Params: { id: string };
  Body: { repos?: unknown };
}

// Метка репозитория («be», «fe»…) — тот же формат, что префиксы PROFILE_TRIAGE_REPOS.
const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,15}$/;

async function projectsModule(
  fastify: FastifyInstance,
  opts: ProjectsModuleOptions,
): Promise<void> {
  const { config, prefs } = opts;

  fastify.get('/api/projects', async () => ({ projects: await projectsOverview({ config, prefs }) }));

  // Пути репозиториев КОКПИТНОГО проекта. Фабричному с заданными в профиле путями
  // отказываем: второй источник правды разъедется с профилем — правится профиль.
  fastify.put<ProjectRoute>('/api/projects/:id', async (req, reply) => {
    const id = String(req.params.id);
    if (!PROFILE_RE.test(id)) return reply.code(400).send({ error: 'bad_id' });
    if (!(await listProjects(config, prefs)).includes(id)) return reply.code(404).send({ error: 'not_found' });
    if ((await listFactoryProfiles(config.profilesDir)).includes(id)) {
      const { loadTriageProfile } = await import('../../lib/analysis/profile.ts');
      const { repos } = await loadTriageProfile(config, id);
      if (repos.length) {
        return reply.code(409).send({
          error: 'factory_project',
          message: 'Пути этого проекта задаёт профиль фабрики (PROFILE_TRIAGE_REPOS) — правь их там.',
        });
      }
    }
    const repos: Array<{ key: string; dir: string }> = [];
    const requested = (Array.isArray(req.body?.repos) ? req.body.repos : []) as Array<{
      key?: unknown;
      dir?: unknown;
    }>;
    for (const r of requested) {
      const key = String(r?.key || '').trim();
      const dir = String(r?.dir || '').trim();
      if (!KEY_RE.test(key)) return reply.code(400).send({ error: 'bad_key', message: `метка «${key}»: строчные латиница/цифры/-/_` });
      if (!path.isAbsolute(dir)) return reply.code(400).send({ error: 'bad_dir', message: `путь «${dir}» должен быть абсолютным` });
      if (repos.some((x) => x.key === key)) return reply.code(400).send({ error: 'dup_key', message: `метка «${key}» повторяется` });
      // Несуществующий путь не отклоняем: репозиторий мог ещё не клонироваться —
      // раздел честно покажет красную точку «нет на диске».
      repos.push({ key, dir: path.normalize(dir) });
    }
    const p = prefs.read();
    prefs.write({ projects: { ...(p.projects || {}), [id]: { repos } } });
    return { ok: true, repos };
  });
}

export default fp(projectsModule, { name: 'module-projects' });
