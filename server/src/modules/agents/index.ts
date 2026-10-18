// Модуль agents — ГЛОБАЛЬНАЯ библиотека ШАБЛОНОВ агентов: просмотр, правка, создание.
// Агент — переиспользуемая роль: метаданные + заготовка промпта. Боевой промпт
// каждого этапа принадлежит схеме (модуль routes, сайдкары в папке маршрута) —
// при добавлении узла заготовка копируется туда и живёт своей жизнью.
// Хранение: agents/<id>.md (frontmatter + промпт), папка самогитигнорится.
// Стандартный набор доустанавливается из версионируемого server/seed/agents
// (POST /api/agents/install, create-only). Посев из профилей фабрики доступен как
// read-only preview; legacy apply отключён до атомарного хранилища.
// Startup никогда не переписывает библиотеку.
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { AgentsStore, ID_RE, defaults } from './store.ts';
import type { AgentRecord } from './store.ts';
import { installAgents } from './install.ts';
import { seedAgents } from './seed.ts';
import type { SeedPreview } from './seed.ts';
import type { GrigDeskConfig } from '../../config.ts';

export interface AgentsModuleOptions {
  config: Pick<GrigDeskConfig, 'agentsDir' | 'agentsSeedDir' | 'profilesDir'>;
}

// Запрос с id агента в адресе: сам id всё равно сверяется с ID_RE.
type IdRequest = FastifyRequest<{ Params: { id: string } }>;

// Тело create/update приходит из сети: каждое поле недоверенное.
type AgentBody = Record<string, unknown> | null;
type BodyRequest = FastifyRequest<{ Body: AgentBody }>;
type IdBodyRequest = FastifyRequest<{ Params: { id: string }; Body: AgentBody }>;

const errorCode = (error: unknown) => (error as { code?: unknown } | null)?.code;
const errorPreview = (error: unknown) => (error as { preview?: SeedPreview } | null)?.preview;

async function agentsModule(fastify: FastifyInstance, opts: AgentsModuleOptions): Promise<void> {
  const { config } = opts;
  const store = new AgentsStore(config.agentsDir);
  let mutationQueue: Promise<unknown> = Promise.resolve();
  const mutate = <Value>(operation: () => Promise<Value>): Promise<Value> => {
    const result = mutationQueue.then(operation, operation);
    mutationQueue = result.catch(() => {});
    return result;
  };

  function storeFailure(reply: FastifyReply, error: unknown, { missing = false } = {}): unknown {
    const code = errorCode(error);

    if (missing && code === 'ENOENT') {
      return reply.code(404).send({ error: 'not_found' });
    }
    if ([
      'unsafe_agents_root',
      'unsafe_agent_file',
      'agent_file_changed',
      'agent_store_locked',
      'agent_store_lock_lost',
    ].includes(String(code))) {
      return reply.code(409).send({ error: code });
    }
    if (code === 'invalid_agent_metadata') {
      return reply.code(400).send({ error: code, message: (error as Error).message });
    }
    throw error;
  }

  fastify.get('/api/agents', async (_req, reply) => {
    try { return { agents: await store.list() }; }
    catch (error) { return storeFailure(reply, error); }
  });

  fastify.get('/api/agents/:id', async (req: IdRequest, reply) => {
    if (!ID_RE.test(req.params.id)) {
      return reply.code(400).send({ error: 'bad_id' });
    }
    try { return await store.get(req.params.id); }
    catch (error) { return storeFailure(reply, error, { missing: true }); }
  });

  // Тело create/update: метаданные + промпт. Неизвестные поля игнорируются.
  function fromBody(body: Record<string, unknown> | null | undefined): AgentRecord {
    const known = Object.entries(body || {}).filter(([k]) => k in defaults());

    return { ...defaults(), ...Object.fromEntries(known) };
  }

  fastify.post('/api/agents', async (req: BodyRequest, reply) => {
    return mutate(async () => {
      try {
        const id = String(req.body?.id || '').trim();
        if (!ID_RE.test(id)) return reply.code(400).send({ error: 'bad_id', message: 'id: строчные латиница/цифры/-/_' });
        if (await store.exists(id)) return reply.code(409).send({ error: 'exists', message: `агент «${id}» уже есть` });
        await store.save(id, fromBody(req.body));
        return store.get(id);
      } catch (error) {
        return storeFailure(reply, error);
      }
    });
  });

  fastify.put('/api/agents/:id', async (req: IdBodyRequest, reply) => {
    return mutate(async () => {
      try {
        const { id } = req.params;
        if (!ID_RE.test(id)) return reply.code(400).send({ error: 'bad_id' });
        if (!(await store.exists(id))) return reply.code(404).send({ error: 'not_found' });
        await store.save(id, fromBody(req.body));
        return store.get(id);
      } catch (error) {
        return storeFailure(reply, error, { missing: true });
      }
    });
  });

  fastify.delete('/api/agents/:id', async (req: IdRequest, reply) => {
    return mutate(async () => {
      if (!ID_RE.test(req.params.id)) return reply.code(400).send({ error: 'bad_id' });
      try { await store.remove(req.params.id); return { ok: true }; }
      catch (error) { return storeFailure(reply, error, { missing: true }); }
    });
  });

  // Установка стандартного набора из версионируемого посева (server/seed/agents).
  // Create-only и идемпотентно: существующие агенты не перезаписываются.
  fastify.post('/api/agents/install', async (_req, reply) => {
    return mutate(async () => {
      try {
        const { created, skipped } = await installAgents(store, config.agentsSeedDir);
        return { ok: true, created, skipped };
      } catch (error) {
        if (errorCode(error) === 'agents_seed_missing') {
          return reply.code(500).send({
            error: errorCode(error),
            message: (error as Error).message,
          });
        }
        return storeFailure(reply, error);
      }
    });
  });

  // Reseed — read-only до immutable-хранилища. Preview получает digest snapshot;
  // confirm проверяет stale token, но даже актуальный snapshot не применяет.
  fastify.post('/api/agents/reseed', async (req: BodyRequest, reply) => {
    return mutate(async () => {
      const apply = req.body?.confirm === true;
      const expectedToken = String(req.body?.previewToken || '');
      if (apply && !/^[a-f0-9]{64}$/.test(expectedToken)) {
        return reply.code(409).send({
          error: 'preview_required',
          message: 'Сначала запросите preview и подтвердите его previewToken.',
        });
      }
      try {
        const result = await seedAgents(store, config, fastify.log, { apply, expectedToken });
        const changed = result.diff.create.length + result.diff.update.length;
        return {
          ok: true,
          preview: !apply,
          confirmationRequired: false,
          reviewRequired: changed > 0,
          ...result,
        };
      } catch (error) {
        const code = String(errorCode(error));

        if (['unsafe_agents_root', 'unsafe_agent_file', 'agent_file_changed'].includes(code)) {
          return storeFailure(reply, error);
        }
        if (code === 'stale_preview') {
          return reply.code(409).send({
            ok: false,
            error: 'stale_preview',
            message: 'Данные изменились после preview; проверьте новый diff.',
            preview: true,
            confirmationRequired: false,
            reviewRequired: true,
            ...errorPreview(error),
          });
        }
        if (code === 'reseed_apply_unsupported') {
          return reply.code(409).send({
            ok: false,
            error: 'reseed_apply_unsupported',
            message: 'Применение legacy reseed отключено до атомарного immutable-хранилища.',
            preview: true,
            confirmationRequired: false,
            reviewRequired: true,
            ...errorPreview(error),
          });
        }
        throw error;
      }
    });
  });
}

export default fp(agentsModule, { name: 'module-agents' });
