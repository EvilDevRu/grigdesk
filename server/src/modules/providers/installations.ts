import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { ProviderInstallError, ProviderInstallService } from '../../lib/providerInstall/service.ts';
import { readCookie, SESSION_COOKIE } from '../../plugins/auth.ts';
import type {
  ProviderInstallOperation,
  ProviderInstallPreparation,
} from '../../../../shared/chat/providerInstallContracts.ts';

interface StartRoute {
  Params: { id: string };
  Body: { preparationToken?: string };
}

/**
 * Область подготовок — авторизованная identity, а не вкладка браузера.
 * Значение хэшируется: сырая cookie и device id не остаются в памяти сервиса.
 */
function authScopeOf(request: FastifyRequest): string {
  const kind = String(request.authKind ?? 'anonymous');
  const principal = request.authPrincipal as { deviceId?: unknown } | null;
  const cookie = readCookie(request.headers.cookie, SESSION_COOKIE);
  const identity = typeof principal?.deviceId === 'string'
    ? `device:${principal.deviceId}`
    : cookie ? `session:${cookie}` : kind;

  return createHash('sha256').update(`${kind}:${identity}`).digest('hex');
}

/**
 * Общий auth guard уже защищает эти маршруты до обращения к сервису.
 * URL задаёт действие; тело prepare пустое, тело старта несёт только выданный token.
 */
export function registerProviderInstallations(fastify: FastifyInstance,
  service: ProviderInstallService): void {
  fastify.get('/api/providers/installations/current', () => service.current());

  for (const operation of ['install', 'update'] as const) {
    fastify.post<{ Params: { id: string } }>(`/api/providers/:id/${operation}/prepare`, {
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
        const preparation: ProviderInstallPreparation = await service.prepare(
          request.params.id, operation, authScopeOf(request));

        return reply.code(200).send(preparation);
      } catch (error) {
        if (!(error instanceof ProviderInstallError)) {
          throw error;
        }

        return reply.code(error.statusCode).send({
          error: error.code,
          message: error.message,
        });
      }
    });

    fastify.post<StartRoute>(`/api/providers/:id/${operation}/start`, {
      preValidation: async (request) => {
        if (request.body === undefined) {
          request.body = {};
        }
      },
      schema: {
        body: {
          type: 'object',
          propertyNames: { enum: ['preparationToken'] },
          properties: {
            preparationToken: { type: 'string', minLength: 1 },
          },
          additionalProperties: false,
        },
      },
    }, async (request, reply) => {
      try {
        const started = await service.start(request.params.id, operation, {
          token: request.body?.preparationToken,
          scope: authScopeOf(request),
        });

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
      const started = await service.start(request.params.id, 'update' as ProviderInstallOperation, {
        legacy: true,
        scope: authScopeOf(request),
      });

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
