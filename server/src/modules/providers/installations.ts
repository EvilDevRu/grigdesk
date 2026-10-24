import type { FastifyInstance } from 'fastify';

import { ProviderInstallError, ProviderInstallService } from '../../lib/providerInstall/service.ts';
import type { ProviderInstallOperation } from '../../../../shared/chat/providerInstallContracts.ts';

interface StartRoute {
  Params: { id: string };
}

/**
 * Общий auth guard уже защищает эти маршруты до обращения к сервису.
 * URL задаёт действие, тело не может передать команду или окружение процесса.
 */
export function registerProviderInstallations(fastify: FastifyInstance,
  service: ProviderInstallService): void {
  fastify.get('/api/providers/installations/current', () => service.current());

  for (const operation of ['install', 'update'] as const) {
    fastify.post<StartRoute>(`/api/providers/:id/${operation}/start`, {
      preValidation: async (request) => {
        if (request.body === undefined) {
          request.body = {};
        }
      },
      schema: {
        body: {
          type: 'object',
          propertyNames: false,
          additionalProperties: false,
        },
      },
    }, async (request, reply) => {
      try {
        const started = await service.start(request.params.id, operation);

        return reply.code(202).send(started.snapshot);
      } catch (error) {
        if (!(error instanceof ProviderInstallError)) {
          throw error;
        }

        return reply.code(error.statusCode).send({
          error: error.code,
          message: error.message,
          snapshot: await service.current(),
        });
      }
    });
  }

  fastify.post<StartRoute>('/api/providers/:id/update', async (request, reply) => {
    try {
      const started = await service.start(request.params.id, 'update' as ProviderInstallOperation, true);

      return await started.completion;
    } catch (error) {
      if (!(error instanceof ProviderInstallError)) {
        throw error;
      }

      return reply.code(error.statusCode).send({
        error: error.code,
        message: error.message,
        snapshot: await service.current(),
      });
    }
  });

  fastify.addHook('preClose', async () => service.dispose());
}
