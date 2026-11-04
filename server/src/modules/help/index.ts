import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import type { HelpService } from '../../lib/help/service.ts';
/**
 * Руководство доступно через общий /api auth guard и не открывает файловый маршрут.
 * Ошибка загрузки справки не мешает запуску и работе других модулей.
 */
async function helpModule(app: FastifyInstance, options: {
  help: HelpService;
}): Promise<void> {
  app.get('/api/help', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');

    try {
      return await options.help.bundle();
    }
    catch {
      return reply.code(503).send({
        error: 'help_unavailable'
      });
    }
  });
}

export default fp(helpModule, {
  name: 'module-help'
});
