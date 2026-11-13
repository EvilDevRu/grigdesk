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
  app.get('/api/help', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');

    const query = request.query as Record<string, unknown>;
    const locale = query.locale ?? 'ru';

    if (Object.keys(query).some((key) => key !== 'locale') || (locale !== 'ru' && locale !== 'en')) {
      return reply.code(400).send({ error: 'help_input_invalid' });
    }

    try {
      return await options.help.bundle(locale);
    }
    catch (error) {
      if (error instanceof Error && error.message === 'help_locale_unavailable') {
        return reply.code(404).send({
          error: 'help_locale_unavailable',
          locale
        });
      }

      return reply.code(503).send({
        error: 'help_unavailable'
      });
    }
  });
}

export default fp(helpModule, {
  name: 'module-help'
});
