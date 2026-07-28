// Модуль analysis — триаж задач: оценка сложности/рисков разведкой кода без стенда.
// Очередь и раннер — в lib/analysis/analyzer.js; здесь только HTTP-обвязка.
import fp from 'fastify-plugin';

async function analysisModule(fastify, opts) {
  const { analyzer } = opts;

  // Поставить задачу в очередь триажа. Дедуп внутри анализатора.
  fastify.post('/api/tasks/:id/analyze', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });
    return analyzer.enqueue(id);
  });

  // Сводка всех анализов (бейджи доски): [{task, analysis?, status?}].
  fastify.get('/api/analysis', async () => analyzer.list());

  // Деталь: оценки + разведнота + статус.
  fastify.get('/api/analysis/:id', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });
    return analyzer.get(id);
  });

  // Локальные уточнения к задаче (НЕ комментарии B24 — заказчик их не видит).
  // Копятся в t<id>.clarify.md; их читают триаж и запуск конвейера.
  fastify.get('/api/tasks/:id/clarifications', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });
    return { text: await analyzer.readClarifications(id) };
  });

  fastify.post('/api/tasks/:id/clarifications', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    const text = String((request.body || {}).text || '').trim();
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });
    if (!text) return reply.code(400).send({ error: 'empty_text' });
    return { text: await analyzer.appendClarification(id, text) };
  });

  // Скрыть прерванный/упавший статус (человек решил не перезапускать).
  fastify.delete('/api/analysis/:id/status', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });
    return analyzer.dismiss(id);
  });
}

export default fp(analysisModule, { name: 'module-analysis' });
