// Модуль analysis — триаж задач: оценка сложности/рисков разведкой кода без стенда.
// Очередь и раннер — в lib/analysis/analyzer.ts; здесь только HTTP-обвязка.
import type { TrackerFacade } from '../../lib/trackers/facade.ts';
import { trackerAccountScope } from '../../lib/trackers/accountScope.ts';

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
}

async function analysisModule(
  fastify: FastifyInstance,
  opts: AnalysisModuleOptions,
): Promise<void> {
  const { analyzer, arbiter = null } = opts;

  const gate = async (_request: FastifyRequest, reply: FastifyReply) => {
    if (fastify.pluginEnabled?.('analysis') !== true) {
      return reply.code(404).send({ error: 'plugin_disabled' });
    }
  };

  // Поставить задачу в очередь триажа. Дедуп внутри анализатора.
  fastify.post<AnalysisRoute>('/api/tasks/:id/analyze', {
    preHandler: gate,
  }, async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });

    const body = objectOrEmpty(request.body);

    if (body.taskSource !== undefined) {
      try {
        const tracker = opts.tracker!;
        const context = tracker.captureContext();
        const identity = await tracker.accountIdentity();
        const source = `${context.trackerId}@${trackerAccountScope(identity)}`;

        tracker.assertContext(context);

        if (body.taskSource !== source) {
          return reply.code(409).send({ error: 'tracker_context_changed',
            message: 'Оценка доступна для доски по умолчанию' });
        }

        const generation = request.headers['x-grigdesk-tracker-generation'];

        if (generation !== undefined) {
          tracker.forDriver(context.trackerId!).assertContext(Number(generation));
        }
      } catch {
        return reply.code(409).send({ error: 'tracker_context_changed',
          message: 'Не удалось подтвердить источник доски по умолчанию' });
      }
    }

    return analyzer.enqueue(id);
  });

  // Сводка всех анализов (бейджи доски): [{task, analysis?, status?}].
  fastify.get('/api/analysis', { preHandler: gate }, async () => analyzer.list());

  // Деталь: оценки + разведнота + статус.
  fastify.get<AnalysisRoute>('/api/analysis/:id', { preHandler: gate }, async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });
    return analyzer.get(id);
  });

  // Локальные уточнения к задаче (НЕ комментарии B24 — заказчик их не видит).
  // Копятся в t<id>.clarify.md; их читают триаж и запуск конвейера.
  fastify.get<AnalysisRoute>('/api/tasks/:id/clarifications', {
    preHandler: gate,
  }, async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });
    const clarifications: AnalysisClarifications = {
      text: await analyzer.readClarifications(id),
      entries: typeof analyzer.readClarificationEntries === 'function'
        ? await analyzer.readClarificationEntries(id)
        : [],
    };

    return clarifications;
  });

  fastify.post<AnalysisRoute>('/api/tasks/:id/clarifications', {
    preHandler: gate,
  }, async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });

    const body = objectOrEmpty(request.body);
    const answers = body.answers;
    if (Array.isArray(answers)) {
      const result = await analyzer.appendClarificationBatch(id, answers, { actor: 'human' });
      if (!result.ok) {
        return reply.code(400).send({ error: result.error });
      }
      return { text: result.text, entries: result.entries };
    }
    const text = String(body.text || '').trim();
    if (!text) return reply.code(400).send({ error: 'empty_text' });
    return { text: await analyzer.appendClarification(id, text) };
  });

  // Скрыть прерванный/упавший статус (человек решил не перезапускать).
  fastify.delete<AnalysisRoute>('/api/analysis/:id/status', {
    preHandler: gate,
  }, async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });
    return analyzer.dismiss(id);
  });

  fastify.post<AnalysisRoute>(
    '/api/tasks/:id/analysis/arbitrate',
    { preHandler: gate },
    async (request, reply) => {
      const id = String(request.params.id).replace(/[^0-9]/g, '');
      if (!id) return reply.code(400).send({ error: 'bad_task_id' });
      if (!arbiter) return reply.code(503).send({ error: 'analysis_arbiter_unavailable' });
      return arbiter.arbitrate(id, { automatic: false });
    },
  );
}

export default fp(analysisModule, { name: 'module-analysis' });
