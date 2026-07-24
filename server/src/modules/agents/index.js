// Модуль agents — ГЛОБАЛЬНАЯ библиотека агентов: просмотр, правка, создание.
// Агенты не принадлежат проектам: это маршруты проектов ссылаются на агентов
// (один ко многим). Хранение: agents/<id>.md (frontmatter + промпт), папка
// самогитигнорится. Пустая библиотека засевается из ВСЕХ профилей фабрики,
// коллизии id разводятся суффиксом (см. seed.js).
import fp from 'fastify-plugin';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AgentsStore, ID_RE, defaults } from './store.js';
import { seedAgents } from './seed.js';
import { PROFILE_RE } from '../../lib/profiles.js';

/**
 * Миграция от прежней раскладки «по проектам» (agents/<профиль>/*.md).
 * Подпапки — это выход старого посева, кастомных правок в них движок не делает:
 * удаляем и даём глобальному посеву пересобрать библиотеку с картой переименований.
 * @returns {boolean} были ли подпапки (нужен пересев маршрутов)
 */
async function dropLegacyProfileDirs(agentsDir) {
  let dropped = false;
  let entries = [];
  try { entries = await fs.readdir(agentsDir, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    if (!e.isDirectory() || !PROFILE_RE.test(e.name)) continue;
    await fs.rm(path.join(agentsDir, e.name), { recursive: true, force: true });
    dropped = true;
  }
  return dropped;
}

async function agentsModule(fastify, opts) {
  const { config } = opts;
  const store = new AgentsStore(config.agentsDir);

  // Миграция со схемы «агенты по проектам» + автопосев пустой библиотеки.
  const hadLegacy = await dropLegacyProfileDirs(config.agentsDir);
  if (hadLegacy || await store.isEmpty()) {
    try {
      const { n } = await seedAgents(store, config.factoryHome, fastify.log);
      fastify.log.info({ n }, 'библиотека агентов засеяна из фабрики');
      // Маршруты ссылались на старые id — просигналим модулю routes пересеять их.
      if (hadLegacy) fastify.decorate('agentsMigrated', true);
    } catch (e) {
      fastify.log.warn({ err: e.message }, 'посев библиотеки агентов не удался — база пустая');
    }
  }

  fastify.get('/api/agents', async () => ({ agents: await store.list() }));

  fastify.get('/api/agents/:id', async (req, reply) => {
    try { return await store.get(req.params.id); }
    catch { return reply.code(404).send({ error: 'not_found' }); }
  });

  // Тело create/update: метаданные + промпт. Неизвестные поля игнорируются.
  function fromBody(body) {
    return { ...defaults(), ...Object.fromEntries(Object.entries(body || {}).filter(([k]) => k in defaults())) };
  }

  fastify.post('/api/agents', async (req, reply) => {
    const id = String(req.body?.id || '').trim();
    if (!ID_RE.test(id)) return reply.code(400).send({ error: 'bad_id', message: 'id: строчные латиница/цифры/-/_' });
    if (await store.exists(id)) return reply.code(409).send({ error: 'exists', message: `агент «${id}» уже есть` });
    await store.save(id, fromBody(req.body));
    return store.get(id);
  });

  fastify.put('/api/agents/:id', async (req, reply) => {
    const { id } = req.params;
    if (!(await store.exists(id))) return reply.code(404).send({ error: 'not_found' });
    await store.save(id, fromBody(req.body));
    return store.get(id);
  });

  fastify.delete('/api/agents/:id', async (req, reply) => {
    try { await store.remove(req.params.id); return { ok: true }; }
    catch { return reply.code(404).send({ error: 'not_found' }); }
  });

  // Пересев библиотеки из фабрики по явной просьбе (перетирает файлы стадий, кастомных не трогает).
  fastify.post('/api/agents/reseed', async () => {
    const { n } = await seedAgents(store, config.factoryHome, fastify.log);
    return { ok: true, n };
  });
}

export default fp(agentsModule, { name: 'module-agents' });
