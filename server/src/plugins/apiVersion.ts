import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';

import { API_VERSION } from '../../../shared/client/apiVersion.ts';

/**
 * Заголовок версии должен сопровождать ответ до исполнения гарда и маршрута.
 * Плагин подключается к корню Fastify, чтобы охватить также отказы и ответы 404.
 */
async function apiVersionPlugin(fastify: FastifyInstance): Promise<void> {
  const version = `${API_VERSION.major}.${API_VERSION.minor}`;

  fastify.addHook('onRequest', async (_request, reply) => {
    reply.header('X-GrigDesk-Api', version);
    // SSE использует hijack и raw.writeHead, обходя накопленные заголовки Fastify.
    // Сырой ответ получает ту же версию до передачи управления обработчику потока.
    reply.raw.setHeader('X-GrigDesk-Api', version);
  });
}

export default fp(apiVersionPlugin, { name: 'grigdesk-api-version' });
