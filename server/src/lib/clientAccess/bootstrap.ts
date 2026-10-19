import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { TLSSocket } from 'node:tls';

import { API_VERSION } from '../../../../shared/client/apiVersion.ts';
import { MobileInputError } from '../mobile/errors.ts';
import type { PairingCodes } from '../mobile/pairing.ts';
import apiVersionPlugin from '../../plugins/apiVersion.ts';

export interface ClientBootstrapOptions {
  pairing: PairingCodes;
  identity: () => { fp: string } | null;
  name: string;
}

/**
 * Непривязанное TLS-соединение видит только отдельное приложение привязки.
 * Основной API никогда не регистрируется в этом экземпляре Fastify.
 */
export async function createClientBootstrap(options: ClientBootstrapOptions) {
  const app = Fastify({ bodyLimit: 4096 });

  await app.register(apiVersionPlugin);
  app.setErrorHandler((error, _request, reply) => {
    const candidate = error as { statusCode?: number; message?: string };
    const status = error instanceof MobileInputError ? error.status : candidate.statusCode ?? 500;

    reply.code(status).send({
      error: error instanceof MobileInputError ? error.code : 'client_error',
      message: status < 500 ? candidate.message : 'Не удалось выполнить привязку.',
    });
  });
  app.get('/api/client/hello', async () => ({
    product: 'grigdesk',
    name: 'GrigDesk',
    fp: options.identity()?.fp,
    api: API_VERSION,
    device: null,
  }));
  registerClientPairRoute(app, options);
  app.setNotFoundHandler((_request, reply) => reply.code(401).send({ error: 'unpaired' }));
  await app.ready();

  return app;
}

/**
 * Повтор после потерянного ответа приходит уже в основной API с привязанным сокетом.
 * Оба входа вызывают один обработчик, а субъект и отпечаток всегда берутся из TLS.
 */
export function registerClientPairRoute(app: FastifyInstance, options: ClientBootstrapOptions): void {
  app.post<{ Body: { code?: unknown; name?: unknown } }>('/api/client/pair', {
    errorHandler(error, _request, reply) {
      if (error instanceof MobileInputError) {
        return reply.code(error.status).send({ error: error.code, message: error.message });
      }

      return reply.send(error);
    },
  }, async (request) => {
    const fp = (request.raw.socket as TLSSocket).getPeerX509Certificate?.()
      ?.fingerprint256.replaceAll(':', '').toLowerCase();

    if (!fp) {
      throw new MobileInputError('no_client_cert', 'Устройство не предъявило сертификат.');
    }

    if (typeof request.body?.code !== 'string' || request.body.code.length > 100) {
      throw new MobileInputError('pair_code_invalid', 'Код привязки недействителен.', 401);
    }

    const device = await options.pairing.pair(request.body.code, fp, request.body.name, 'client',
      request.raw.socket.remoteAddress ?? request.ip);

    return {
      device: { id: device.id, name: device.name },
      server: {
        name: options.name,
        fp: options.identity()?.fp,
        api: API_VERSION,
      },
    };
  });
}
