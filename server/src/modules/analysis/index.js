// Модуль analysis — триаж задач: оценка сложности/рисков разведкой кода без стенда.
// Очередь и раннер — в lib/analysis/analyzer.js; здесь только HTTP-обвязка.
import fp from 'fastify-plugin';

async function analysisModule(fastify, opts) {
  const { analyzer, arbiter = null } = opts;

  const gate = async (_request, reply) => {
    if (fastify.pluginEnabled?.('analysis') !== true) {
      return reply.code(404).send({ error: 'plugin_disabled' });
    }
  };

  // Поставить задачу в очередь триажа. Дедуп внутри анализатора.
  fastify.post('/api/tasks/:id/analyze', { preHandler: gate }, async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });
    return analyzer.enqueue(id);
  });

  // Сводка всех анализов (бейджи доски): [{task, analysis?, status?}].
  fastify.get('/api/analysis', { preHandler: gate }, async () => analyzer.list());

  // Деталь: оценки + разведнота + статус.
  fastify.get('/api/analysis/:id', { preHandler: gate }, async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });
    return analyzer.get(id);
  });

  // Локальные уточнения к задаче (НЕ комментарии B24 — заказчик их не видит).
  // Копятся в t<id>.clarify.md; их читают триаж и запуск конвейера.
  fastify.get('/api/tasks/:id/clarifications', { preHandler: gate }, async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });
    const text = await analyzer.readClarifications(id);
    const entries = typeof analyzer.readClarificationEntries === 'function'
      ? await analyzer.readClarificationEntries(id)
      : [];
    return { text, entries };
  });

  fastify.post('/api/tasks/:id/clarifications', { preHandler: gate }, async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });
    const answers = (request.body || {}).answers;
    if (Array.isArray(answers)) {
      const result = await analyzer.appendClarificationBatch(id, answers, { actor: 'human' });
      if (!result.ok) {
        return reply.code(400).send({ error: result.error });
      }
      return { text: result.text, entries: result.entries };
    }
    const text = String((request.body || {}).text || '').trim();
    if (!text) return reply.code(400).send({ error: 'empty_text' });
    return { text: await analyzer.appendClarification(id, text) };
  });

  // Скрыть прерванный/упавший статус (человек решил не перезапускать).
  fastify.delete('/api/analysis/:id/status', { preHandler: gate }, async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });
    return analyzer.dismiss(id);
  });

  fastify.post(
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
