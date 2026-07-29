// Модуль agents — ГЛОБАЛЬНАЯ библиотека ШАБЛОНОВ агентов: просмотр, правка, создание.
// Агент — переиспользуемая роль: метаданные + заготовка промпта. Боевой промпт
// каждого этапа принадлежит схеме (модуль routes, сайдкары в папке маршрута) —
// при добавлении узла заготовка копируется туда и живёт своей жизнью.
// Хранение: agents/<id>.md (frontmatter + промпт), папка самогитигнорится.
// Пустая библиотека засевается из ВСЕХ профилей фабрики; один id = один шаблон
// (см. seed.js).
import fp from 'fastify-plugin';
import { AgentsStore, ID_RE, defaults } from './store.js';
import { seedAgents } from './seed.js';

async function agentsModule(fastify, opts) {
  const { config } = opts;
  const store = new AgentsStore(config.agentsDir);

  // Автопосев пустой библиотеки из профилей фабрики.
  if (await store.isEmpty()) {
    try {
      const { n } = await seedAgents(store, config, fastify.log);
      fastify.log.info({ n }, 'библиотека агентов засеяна из фабрики');
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
    const { n } = await seedAgents(store, config, fastify.log);
    return { ok: true, n };
  });
}

export default fp(agentsModule, { name: 'module-agents' });
