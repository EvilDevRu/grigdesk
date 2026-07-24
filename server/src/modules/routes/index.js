// Модуль routes — маршруты конвейера ПО ПРОЕКТАМ + сами проекты.
// Маршрут = упорядоченная цепочка агентов из ГЛОБАЛЬНОЙ библиотеки + возвраты
// (проект → агенты: один ко многим). Хранение: routes/<проект>/<id>.json,
// папка самогитигнорится. Пустая база проекта засевается из его graph.json;
// ссылки на агентов подменяются по карте переименований посева библиотеки
// (agents/.remap.json) — коллизии id между профилями разведены суффиксами.
import fp from 'fastify-plugin';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { listFactoryProfiles, listProjects, PROFILE_RE } from '../../lib/profiles.js';
import { readRemap } from '../agents/seed.js';

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;

function normalize(body) {
  return {
    title: String(body?.title || ''),
    stages: Array.isArray(body?.stages) ? body.stages.map(String) : [],
    returns: (Array.isArray(body?.returns) ? body.returns : [])
      .map((r) => ({ from: String(r.from || ''), to: String(r.to || ''), label: String(r.label || '') }))
      .filter((r) => r.from && r.to),
  };
}

async function routesModule(fastify, opts) {
  const { config } = opts;
  const baseDir = config.routesDir;

  const dirOf = (profile) => path.join(baseDir, profile);
  const fileOf = (profile, id) => path.join(dirOf(profile), `${id}.json`);

  async function ensureDir(profile) {
    await fs.mkdir(dirOf(profile), { recursive: true });
    const gi = path.join(baseDir, '.gitignore');
    try { await fs.access(gi); } catch { await fs.writeFile(gi, '*\n!.gitignore\n'); }
  }

  async function list(profile) {
    await ensureDir(profile);
    const out = [];
    for (const f of await fs.readdir(dirOf(profile))) {
      if (!f.endsWith('.json')) continue;
      try {
        out.push({ id: f.slice(0, -5), ...normalize(JSON.parse(await fs.readFile(path.join(dirOf(profile), f), 'utf8'))) });
      } catch { /* битый файл одного маршрута не валит список */ }
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
  }

  async function save(profile, id, route) {
    await ensureDir(profile);
    const tmp = `${fileOf(profile, id)}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(route, null, 2)}\n`);
    await fs.rename(tmp, fileOf(profile, id));
  }

  // Человеческие названия известных маршрутов — только НАЧАЛЬНОЕ значение посева:
  // дальше живут в файле маршрута и правятся полем «Название» в редакторе.
  const SEED_TITLES = {
    feature: 'Новая функциональность',
    debug: 'Багфикс: сначала пойми, потом чини',
    trivial: 'Мелкая правка',
    dev: 'Разработка через варианты',
    quick: 'Быстрая правка',
  };

  /**
   * Посев проекта из его graph.json: цепочка = порядок узлов, возвраты = fail-рёбра.
   * Ссылки на агентов идут через карту переименований библиотеки (agents/.remap.json).
   */
  async function seed(profile) {
    const p = path.join(config.factoryHome, 'profiles', `${profile}.graph.json`);
    const g = JSON.parse(await fs.readFile(p, 'utf8'));
    const remap = (await readRemap(config.agentsDir))[profile] || {};
    const mapId = (id) => remap[id] || id;
    let n = 0;
    for (const [name, r] of Object.entries(g.routes || {})) {
      // sandbox — инфраструктура (стенд), не этап цепочки: в редакторе не участвует.
      const stages = Object.keys(r.pos || {}).filter((s) => s !== 'sandbox').map(mapId);
      const returns = (r.edges || [])
        .filter(([, , , cls]) => cls === 'fail')
        .map(([from, to, label]) => ({ from: mapId(from), to: mapId(to), label: label || '' }));
      await save(profile, name, { title: SEED_TITLES[name] || '', stages, returns });
      n++;
    }
    return n;
  }

  // Автопосев: пустые базы проектов фабрики; после миграции библиотеки агентов
  // (id агентов поменялись) — принудительный пересев всех фабричных проектов.
  const force = !!fastify.agentsMigrated;
  for (const profile of await listFactoryProfiles(config.factoryHome)) {
    await ensureDir(profile);
    if (force || !(await fs.readdir(dirOf(profile))).some((f) => f.endsWith('.json'))) {
      try {
        const n = await seed(profile);
        fastify.log.info({ n, profile, force }, 'база маршрутов засеяна из фабрики');
      } catch (e) {
        fastify.log.warn({ err: e.message, profile }, 'посев базы маршрутов не удался — база пустая');
      }
    }
  }

  // ── Проекты ──
  fastify.get('/api/profiles', async () => ({ profiles: await listProjects(config) }));

  // Новый проект: пустая база маршрутов (агенты — общая библиотека).
  fastify.post('/api/profiles', async (req, reply) => {
    const id = String(req.body?.id || '').trim();
    if (!PROFILE_RE.test(id)) return reply.code(400).send({ error: 'bad_id', message: 'id: строчные латиница/цифры/-/_' });
    const existing = await listProjects(config);
    if (existing.includes(id)) return reply.code(409).send({ error: 'exists', message: `проект «${id}» уже есть` });
    await ensureDir(id);
    return { ok: true, profiles: await listProjects(config) };
  });

  function badProfile(reply, profile) {
    if (!PROFILE_RE.test(profile)) { reply.code(400).send({ error: 'bad_profile' }); return true; }
    return false;
  }

  // ── Маршруты проекта ──
  fastify.get('/api/routes/:profile', async (req, reply) => {
    if (badProfile(reply, req.params.profile)) return reply;
    return { routes: await list(req.params.profile) };
  });

  fastify.post('/api/routes/:profile', async (req, reply) => {
    const { profile } = req.params;
    if (badProfile(reply, profile)) return reply;
    const id = String(req.body?.id || '').trim();
    if (!ID_RE.test(id)) return reply.code(400).send({ error: 'bad_id', message: 'id: строчные латиница/цифры/-/_' });
    try { await fs.access(fileOf(profile, id)); return reply.code(409).send({ error: 'exists', message: `маршрут «${id}» уже есть` }); } catch { /* свободен */ }
    await save(profile, id, normalize(req.body));
    return { id, ...normalize(req.body) };
  });

  fastify.put('/api/routes/:profile/:id', async (req, reply) => {
    const { profile, id } = req.params;
    if (badProfile(reply, profile)) return reply;
    try { await fs.access(fileOf(profile, id)); } catch { return reply.code(404).send({ error: 'not_found' }); }
    await save(profile, id, normalize(req.body));
    return { id, ...normalize(req.body) };
  });

  fastify.delete('/api/routes/:profile/:id', async (req, reply) => {
    if (badProfile(reply, req.params.profile)) return reply;
    try { await fs.unlink(fileOf(req.params.profile, req.params.id)); return { ok: true }; }
    catch { return reply.code(404).send({ error: 'not_found' }); }
  });

  fastify.post('/api/routes/:profile/reseed', async (req, reply) => {
    if (badProfile(reply, req.params.profile)) return reply;
    return { ok: true, n: await seed(req.params.profile) };
  });
}

export default fp(routesModule, { name: 'module-routes' });
