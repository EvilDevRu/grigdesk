// Модуль routes — маршруты конвейера ПО ПРОЕКТАМ + сами проекты.
// Маршрут = упорядоченная цепочка агентов из ГЛОБАЛЬНОЙ библиотеки шаблонов
// + возвраты + СВОИ промпты этапов. Промпт — свойство места в схеме, а не агента:
// при добавлении узла заготовка копируется из шаблона и дальше живёт в схеме.
// Хранение: routes/<проект>/<id>.json (цепочка) + routes/<проект>/<id>/<этап>.md
// (промпты узлов сайдкарами — длинные тексты не раздувают json и читаемо диффятся).
// Папка самогитигнорится. Пустая база проекта засевается из его graph.json,
// промпты этапов — из bash-профиля фабрики.
import fp from 'fastify-plugin';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { listFactoryProfiles, listProjects, PROFILE_RE } from '../../lib/profiles.js';
import { extractProfilePrompts } from '../agents/seed.js';

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;

function normalize(body) {
  const stages = Array.isArray(body?.stages) ? body.stages.map(String) : [];
  const rawPrompts = body?.prompts && typeof body.prompts === 'object' ? body.prompts : {};
  // Промпты держим только для этапов цепочки — убранный узел уносит и свой текст.
  const prompts = {};
  for (const s of stages) {
    const t = String(rawPrompts[s] ?? '').trim();
    if (t) prompts[s] = t;
  }
  return {
    title: String(body?.title || ''),
    stages,
    returns: (Array.isArray(body?.returns) ? body.returns : [])
      .map((r) => ({ from: String(r.from || ''), to: String(r.to || ''), label: String(r.label || '') }))
      .filter((r) => r.from && r.to),
    prompts,
  };
}

async function routesModule(fastify, opts) {
  const { config } = opts;
  const baseDir = config.routesDir;

  const dirOf = (profile) => path.join(baseDir, profile);
  const fileOf = (profile, id) => path.join(dirOf(profile), `${id}.json`);
  // Папка промптов узлов данного маршрута.
  const promptsDirOf = (profile, id) => path.join(dirOf(profile), id);

  async function ensureDir(profile) {
    await fs.mkdir(dirOf(profile), { recursive: true });
    const gi = path.join(baseDir, '.gitignore');
    try { await fs.access(gi); } catch { await fs.writeFile(gi, '*\n!.gitignore\n'); }
  }

  /** Промпты узлов маршрута из сайдкаров: { <этап>: текст }. */
  async function readPrompts(profile, id) {
    const prompts = {};
    let files = [];
    try { files = await fs.readdir(promptsDirOf(profile, id)); } catch { return prompts; }
    for (const f of files) {
      if (!f.endsWith('.md')) continue;
      try {
        const text = (await fs.readFile(path.join(promptsDirOf(profile, id), f), 'utf8')).trim();
        if (text) prompts[f.slice(0, -3)] = text;
      } catch { /* битый сайдкар — узел останется без промпта */ }
    }
    return prompts;
  }

  /** Синхронизация сайдкаров с сохраняемым маршрутом: пишем нужные, удаляем осиротевшие. */
  async function writePrompts(profile, id, prompts) {
    const dir = promptsDirOf(profile, id);
    const keep = new Set(Object.keys(prompts).map((s) => `${s}.md`));
    if (keep.size) await fs.mkdir(dir, { recursive: true });
    let existing = [];
    try { existing = await fs.readdir(dir); } catch { /* папки ещё нет */ }
    for (const f of existing) {
      if (f.endsWith('.md') && !keep.has(f)) await fs.rm(path.join(dir, f), { force: true });
    }
    for (const [stage, text] of Object.entries(prompts)) {
      if (!ID_RE.test(stage)) continue;
      const p = path.join(dir, `${stage}.md`);
      await fs.writeFile(`${p}.tmp`, `${text.trim()}\n`);
      await fs.rename(`${p}.tmp`, p);
    }
    if (!keep.size) await fs.rm(dir, { recursive: true, force: true });
  }

  async function list(profile) {
    await ensureDir(profile);
    const out = [];
    for (const f of await fs.readdir(dirOf(profile))) {
      if (!f.endsWith('.json')) continue;
      const id = f.slice(0, -5);
      try {
        const route = normalize(JSON.parse(await fs.readFile(path.join(dirOf(profile), f), 'utf8')));
        // Промпты в json не живут — их источник всегда сайдкары.
        route.prompts = await readPrompts(profile, id);
        out.push({ id, ...route });
      } catch { /* битый файл одного маршрута не валит список */ }
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
  }

  async function save(profile, id, route) {
    await ensureDir(profile);
    const { prompts, ...json } = route;
    const tmp = `${fileOf(profile, id)}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(json, null, 2)}\n`);
    await fs.rename(tmp, fileOf(profile, id));
    await writePrompts(profile, id, prompts || {});
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
   * Посев проекта из его graph.json: цепочка = порядок узлов, возвраты = fail-рёбра,
   * промпты узлов — из bash-профиля фабрики (сайдкарами в папку каждой схемы).
   */
  async function seed(profile) {
    const p = path.join(config.factoryHome, 'profiles', `${profile}.graph.json`);
    const g = JSON.parse(await fs.readFile(p, 'utf8'));
    let profilePrompts = {};
    try { profilePrompts = await extractProfilePrompts(config.factoryHome, profile); }
    catch (e) { fastify.log.warn({ err: e.message, profile }, 'посев маршрутов: промпты профиля не извлеклись'); }
    let n = 0;
    for (const [name, r] of Object.entries(g.routes || {})) {
      // sandbox — инфраструктура (стенд), не этап цепочки: в редакторе не участвует.
      const stages = Object.keys(r.pos || {}).filter((s) => s !== 'sandbox');
      const returns = (r.edges || [])
        .filter(([, , , cls]) => cls === 'fail')
        .map(([from, to, label]) => ({ from, to, label: label || '' }));
      const prompts = Object.fromEntries(stages
        .filter((s) => (profilePrompts[s] || '').trim())
        .map((s) => [s, profilePrompts[s].trim()]));
      await save(profile, name, { title: SEED_TITLES[name] || '', stages, returns, prompts });
      n++;
    }
    return n;
  }

  // Автопосев пустых баз проектов фабрики.
  for (const profile of await listFactoryProfiles(config.factoryHome)) {
    await ensureDir(profile);
    if (!(await fs.readdir(dirOf(profile))).some((f) => f.endsWith('.json'))) {
      try {
        const n = await seed(profile);
        fastify.log.info({ n, profile }, 'база маршрутов засеяна из фабрики');
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
    const route = normalize(req.body);
    await save(profile, id, route);
    return { id, ...route };
  });

  fastify.put('/api/routes/:profile/:id', async (req, reply) => {
    const { profile, id } = req.params;
    if (badProfile(reply, profile)) return reply;
    try { await fs.access(fileOf(profile, id)); } catch { return reply.code(404).send({ error: 'not_found' }); }
    const route = normalize(req.body);
    await save(profile, id, route);
    return { id, ...route };
  });

  fastify.delete('/api/routes/:profile/:id', async (req, reply) => {
    const { profile, id } = req.params;
    if (badProfile(reply, profile)) return reply;
    try { await fs.unlink(fileOf(profile, id)); } catch { return reply.code(404).send({ error: 'not_found' }); }
    await fs.rm(promptsDirOf(profile, id), { recursive: true, force: true });
    return { ok: true };
  });

  fastify.post('/api/routes/:profile/reseed', async (req, reply) => {
    if (badProfile(reply, req.params.profile)) return reply;
    return { ok: true, n: await seed(req.params.profile) };
  });
}

export default fp(routesModule, { name: 'module-routes' });
