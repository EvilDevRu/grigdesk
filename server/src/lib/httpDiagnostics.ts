import type { FastifyInstance } from 'fastify';

/**
 * Числовая метрика отделяет время сервера до отправки тела от ожидания в окне.
 * Сбор включён только при verbose; путь, заголовки запроса и payload не читаются.
 */
export function installHttpDiagnostics(app: FastifyInstance): void {
  const starts = new WeakMap<object, number>();

  app.addHook('onRequest', async (request) => {
    if (app.log.level === 'debug') {
      starts.set(request, performance.now());
    }
  });
  app.addHook('onSend', async (request, reply, payload) => {
    const start = starts.get(request);

    if (start !== undefined && app.log.level === 'debug') {
      const duration = Math.max(0, performance.now() - start).toFixed(1);
      const previous = reply.getHeader('server-timing');

      reply.header('server-timing', [previous, `grigdesk;dur=${duration}`].filter(Boolean).join(', '));
    }

    return payload;
  });
}
