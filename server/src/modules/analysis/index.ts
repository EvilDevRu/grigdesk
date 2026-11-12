// Модуль analysis — триаж задач: оценка сложности/рисков разведкой кода без стенда.
// Очередь и раннер — в lib/analysis/analyzer.ts; здесь только HTTP-обвязка.
import type { TrackerFacade } from '../../lib/trackers/facade.ts';
import { resolveTaskTarget, taskSource } from '../../lib/trackers/taskTarget.ts';
import { TrackerError } from '../../lib/trackers/contract.ts';

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { objectOrEmpty } from '../../../../shared/lib/objects.ts';

import type { Analyzer } from '../../lib/analysis/analyzer.ts';
import type { AnalysisArbiter } from '../../lib/analysis/arbiter.ts';
import type { AnalysisClarifications } from '../../../../shared/pipeline/analysisContracts.ts';

export interface AnalysisModuleOptions {
  analyzer: Analyzer;
  tracker?: TrackerFacade;
  arbiter?: AnalysisArbiter | null;
}

interface AnalysisRoute {
  Params: {
    id: string;
  };
  Body: unknown;
  Querystring: { source?: string; sources?: string };
}

/**
 * HTTP принимает полный источник и сохраняет числовую совместимость старых клиентов.
 * Проверка цели предшествует очереди, а ошибки адресации сохраняют свой HTTP-код.
 */
async function analysisModule(
  fastify: FastifyInstance,
  opts: AnalysisModuleOptions,
): Promise<void> {
  const { analyzer, arbiter = null } = opts;

  const targetError = (error: Error, _request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof TrackerError) {
      return reply.code(error.status).send({ error: error.code, message: error.message });
    }

    return reply.send(error);
  };

  const gate = async (_request: FastifyRequest, reply: FastifyReply) => {
    if (fastify.pluginEnabled?.('analysis') !== true) {
      return reply.code(404).send({ error: 'plugin_disabled' });
    }
  };

  // Поставить задачу в очередь триажа. Дедуп внутри анализатора.
  fastify.post<AnalysisRoute>('/api/tasks/:id/analyze', {
    preHandler: gate,
    errorHandler: targetError,
  }, async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });

    const body = objectOrEmpty(request.body);

    if (body.source !== undefined && body.taskSource !== undefined && body.source !== body.taskSource) {
      return reply.code(400).send({ error: 'bad_task_source' });
    }

    const source = taskSource(Object.hasOwn(body, 'source') ? body.source : body.taskSource);
    const header = request.headers['x-grigdesk-tracker-generation'];

    const generation = header === undefined ? undefined : Number(header);

    if (source !== undefined) {
      await resolveTaskTarget(analyzer.config, opts.tracker || analyzer.tracker, id, { source, generation });
    }

    return analyzer.enqueue(id, { source, generation });
  });

  // Сводка всех анализов (бейджи доски): [{task, analysis?, status?}].
  fastify.get<{ Querystring: { sources?: string } }>('/api/analysis', {
    preHandler: gate,
    errorHandler: targetError,
  }, async (request) => analyzer.list({ sources: request.query.sources === '1' }));

  // Деталь: оценки + разведнота + статус.
  fastify.get<AnalysisRoute>('/api/analysis/:id', {
    preHandler: gate,
    errorHandler: targetError,
  }, async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });

    return analyzer.get(id, { source: taskSource(request.query.source) });
  });

  // Локальные уточнения к задаче (НЕ комментарии B24 — заказчик их не видит).
  // Копятся в t<id>.clarify.md; их читают триаж и запуск конвейера.
  fastify.get<AnalysisRoute>('/api/tasks/:id/clarifications', {
    preHandler: gate,
    errorHandler: targetError,
  }, async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });

    const clarifications: AnalysisClarifications = {
      text: await analyzer.readClarifications(id, { source: taskSource(request.query.source) }),
      entries: typeof analyzer.readClarificationEntries === 'function'
        ? await analyzer.readClarificationEntries(id, { source: taskSource(request.query.source) })
        : [],
    };

    return clarifications;
  });

  fastify.post<AnalysisRoute>('/api/tasks/:id/clarifications', {
    preHandler: gate,
    errorHandler: targetError,
  }, async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });

    const body = objectOrEmpty(request.body);
    const answers = body.answers;

    if (Array.isArray(answers)) {
      const result = await analyzer.appendClarificationBatch(id, answers, {
        actor: 'human',
        source: taskSource(request.query.source),
      });
      if (!result.ok) {
        return reply.code(400).send({ error: result.error });
      }
      return { text: result.text, entries: result.entries };
    }
    const text = String(body.text || '').trim();
    if (!text) return reply.code(400).send({ error: 'empty_text' });

    return {
      text: await analyzer.appendClarification(id, text, { source: taskSource(request.query.source) }),
    };
  });

  // Скрыть прерванный/упавший статус (человек решил не перезапускать).
  fastify.delete<AnalysisRoute>('/api/analysis/:id/status', {
    preHandler: gate,
    errorHandler: targetError,
  }, async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });

    return analyzer.dismiss(id, { source: taskSource(request.query.source) });
  });

  fastify.post<AnalysisRoute>(
    '/api/tasks/:id/analysis/arbitrate',
    {
      preHandler: gate,
      errorHandler: targetError,
    },
    async (request, reply) => {
      const id = String(request.params.id).replace(/[^0-9]/g, '');
      if (!id) return reply.code(400).send({ error: 'bad_task_id' });

      if (!arbiter) return reply.code(503).send({ error: 'analysis_arbiter_unavailable' });

      return arbiter.arbitrate(id, { automatic: false, source: taskSource(request.query.source) });
    },
  );
}

export default fp(analysisModule, { name: 'module-analysis' });
