import type { FastifyInstance, FastifyReply } from 'fastify';

import { graphCommand, GraphCommandError, type GraphCommand, type GraphCommandConfig } from '../../lib/graphWorkflows.ts';
import { GraphWorkflowWorkers } from '../../lib/graphWorkflowWorkers.ts';
import { createGraphModelCatalog, type WorkflowModelCatalog } from '../../lib/graphWorkflowCatalog.ts';
import { runGraphModelJob } from '../../lib/graphWorkflowModelHelper.ts';
import type { AccessConfig } from '../../lib/accessProfiles/types.ts';
import type { GraphModelJob, GraphModelResult } from '../../lib/graphWorkflowExecutor.ts';
import type { WorkflowModelRef } from '../../../../shared/pipeline/graphWorkflowContracts.ts';

/** Выдача worker несёт идентификаторы поверх модельного job: фикстуры и helper читают их. */
export type GraphClaimJob = GraphModelJob & {
  id: string;
  nodeId: string;
  generation: number;
  claimId: string;
  expiresAt: number;
};

export interface GraphWorkflowModuleOptions {
  config: GraphCommandConfig & AccessConfig & { modelsPath: string };
  providerSettings?: () => Record<string, Record<string, unknown>>;
  modelCatalog?: WorkflowModelCatalog;
  runModel?: (job: GraphClaimJob, signal: AbortSignal) => Promise<GraphModelResult>;
  autoWork?: boolean;
}

interface StartBody {
  id: string;
  templateId: string;
  expectedRevision: string;
  files: { name: string; text: string }[];
  modelRef: WorkflowModelRef;
}

interface GraphClaim {
  job: GraphClaimJob | null;
  changed: { id: string; revision?: number }[];
  pending: boolean;
  nextWakeAt?: number;
}

const START_KEYS = ['id', 'templateId', 'expectedRevision', 'files', 'modelRef'];
const SAVE_KEYS = ['id', 'expectedRevision', 'document'];
const ACTION_KEYS = ['expectedRevision', 'nodeId', 'generation', 'action', 'target', 'comment'];

function exactBody(value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);

  return required.every((key) => keys.includes(key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}

/**
 * Графовые маршруты: один приватный транспорт Go и общая лента инвалидаций.
 * Модуль инкапсулирован; session-only проверка действует и на чтение исходников.
 */
async function graphWorkflowsModule(fastify: FastifyInstance, opts: GraphWorkflowModuleOptions): Promise<void> {
  const config = opts.config;
  const autoWork = opts.autoWork !== false;
  const invoke = (command: GraphCommand, request: Record<string, unknown>) => graphCommand(config, command, request);
  const catalog = opts.modelCatalog ?? createGraphModelCatalog(config);

  fastify.addHook('onRequest', async (request, reply) => {
    if (request.authKind === 'session') {
      return;
    }

    return reply.header('Cache-Control', 'no-store').code(403).send({ error: 'session_required' });
  });

  const announce = (data: unknown): void => {
    try {
      fastify.sse?.broadcast?.('graph-workflow-change', data);
    } catch {
      // Инвалидация не роняет принятый ответ; клиент сверяется по hello и GET.
    }
  };

  const workers = new GraphWorkflowWorkers({
    claim: () => invoke('claim', {}) as Promise<GraphClaim>,
    settle: (job, result) => invoke('settle', {
      id: job.id, nodeId: job.nodeId, generation: job.generation, claimId: job.claimId, ...result,
    }) as Promise<{ id: string; revision?: number }>,
    run: opts.runModel ?? ((job, signal) => runGraphModelJob(job, signal, config, opts.providerSettings?.() ?? {}, { catalog })),
    announce: (update) => announce(update),
    unavailable: (error) => {
      const code = error instanceof GraphCommandError ? error.code : 'graph_worker_failed';

      fastify.log.warn({ code }, 'графовый worker: отказ транспорта');
    },
    invalidateRuns: () => announce({ scope: 'runs' }),
  });

  const fail = (reply: FastifyReply, error: unknown) => {
    if (error instanceof GraphCommandError) {
      const body: Record<string, unknown> = { error: error.code };

      if (error.field) {
        body.field = error.field;
      }
      if (error.retryAt) {
        body.retryAt = error.retryAt;
      }
      return reply.header('Cache-Control', 'no-store').code(error.status).send(body);
    }
    return reply.header('Cache-Control', 'no-store').code(503).send({ error: 'workflow_store_unavailable' });
  };

  fastify.get('/api/graph-workflows/templates', async (request, reply) => {
    const query = request.query as { cursor?: string };

    try {
      return await invoke('templates', { cursor: query.cursor ?? '' });
    } catch (error) {
      return fail(reply, error);
    }
  });

  fastify.get('/api/graph-workflows/templates/:id', async (request, reply) => {
    const params = request.params as { id: string };

    try {
      return await invoke('template', { id: params.id });
    } catch (error) {
      return fail(reply, error);
    }
  });

  fastify.post('/api/graph-workflows/templates/save', { bodyLimit: 2 * 1024 * 1024 }, async (request, reply) => {
    const body = request.body;

    if (!exactBody(body, SAVE_KEYS)) {
      return reply.code(422).send({ error: 'request_invalid' });
    }
    try {
      const saved = await invoke('template-save', body);

      announce({ templateId: (body as { id: string }).id });
      return saved;
    } catch (error) {
      return fail(reply, error);
    }
  });

  fastify.get('/api/graph-workflows/runs', async (request, reply) => {
    const query = request.query as { cursor?: string };

    try {
      return await invoke('runs', { cursor: query.cursor ?? '', limit: 30 });
    } catch (error) {
      return fail(reply, error);
    }
  });

  fastify.post('/api/graph-workflows/runs', { bodyLimit: 2 * 1024 * 1024 }, async (request, reply) => {
    const body = request.body;

    if (!exactBody(body, START_KEYS)) {
      return reply.code(422).send({ error: 'request_invalid' });
    }
    const start = body as unknown as StartBody;

    if (!Array.isArray(start.files) || start.files.length < 1 || start.files.length > 20
      || start.files.some((file) => typeof file?.name !== 'string' || typeof file?.text !== 'string')) {
      return reply.code(422).send({ error: 'request_invalid', field: 'files' });
    }
    let mutating = false;

    try {
      const check = await invoke('start-check', body) as { found: boolean };

      let resolved: WorkflowModelRef | undefined;

      if (!check.found) {
        const template = await invoke('template', { id: start.templateId }) as {
          requiresModel: boolean;
          revision: string;
        };

        if (template.revision !== start.expectedRevision) {
          return reply.code(409).send({ error: 'conflict' });
        }
        if (template.requiresModel) {
          if (process.platform === 'win32') {
            return reply.code(422).send({ error: 'workflow_model_unsupported' });
          }

          resolved = (await catalog.resolve(start.modelRef)) ?? undefined;
          if (!resolved) {
            return reply.code(422).send({ error: 'model_unavailable', field: 'modelRef' });
          }
        }
      }
      mutating = true;
      const started = await invoke('start', { ...body, resolvedModelRef: resolved });

      return reply.code(202).send(started);
    } catch (error) {
      return fail(reply, error);
    } finally {
      if (mutating) {
        announce({ id: start.id });
        if (autoWork) {
          workers.wake();
        }
      }
    }
  });

  fastify.get('/api/graph-workflows/runs/:id', async (request, reply) => {
    const params = request.params as { id: string };

    try {
      return await reply.header('Cache-Control', 'no-store').send(await invoke('read', { id: params.id }));
    } catch (error) {
      return fail(reply, error);
    }
  });

  fastify.get('/api/graph-workflows/runs/:id/result', async (request, reply) => {
    const params = request.params as { id: string };
    const query = request.query as { cursor?: string };

    try {
      const result = await invoke('result', { id: params.id, cursor: query.cursor ?? '' });

      return reply.header('Cache-Control', 'no-store').send(result);
    } catch (error) {
      return fail(reply, error);
    }
  });

  fastify.get('/api/graph-workflows/runs/:id/nodes/:nodeId', async (request, reply) => {
    const params = request.params as { id: string; nodeId: string };

    try {
      const node = await invoke('node', { id: params.id, nodeId: params.nodeId });

      return reply.header('Cache-Control', 'no-store').send(node);
    } catch (error) {
      return fail(reply, error);
    }
  });

  fastify.get('/api/graph-workflows/runs/:id/inputs/:inputKey', async (request, reply) => {
    const params = request.params as { id: string; inputKey: string };

    try {
      const input = await invoke('input', { id: params.id, inputKey: params.inputKey });

      return reply.header('Cache-Control', 'no-store').send(input);
    } catch (error) {
      return fail(reply, error);
    }
  });

  fastify.post('/api/graph-workflows/runs/:id/action', { bodyLimit: 2 * 1024 * 1024 }, async (request, reply) => {
    const params = request.params as { id: string };
    const body = request.body;
    const required = (body as { action?: string } | null)?.action === 'pause'
      || (body as { action?: string } | null)?.action === 'resume'
      ? ['expectedRevision', 'action']
      : ['expectedRevision', 'nodeId', 'generation', 'action'];

    if (!exactBody(body, required, ACTION_KEYS)) {
      return reply.code(422).send({ error: 'request_invalid' });
    }
    let mutating = false;

    try {
      mutating = true;
      const updated = await invoke('action', { ...(body as Record<string, unknown>), id: params.id });

      return updated;
    } catch (error) {
      return fail(reply, error);
    } finally {
      if (mutating) {
        announce({ id: params.id });
        if (autoWork) {
          workers.wake();
        }
      }
    }
  });

  fastify.get('/api/graph-workflows/models', async (_request, reply) => {
    try {
      return { models: await catalog.list() };
    } catch {
      return reply.code(503).send({ error: 'workflow_store_unavailable' });
    }
  });

  fastify.addHook('onReady', async () => {
    if (autoWork) {
      workers.wake();
    }
  });

  fastify.addHook('onClose', async () => {
    await workers.close();
  });
}

export default graphWorkflowsModule;