import type { FastifyInstance } from 'fastify';

import type { MobileService } from '../../lib/mobile/service.ts';
import { MobileInputError } from '../../lib/mobile/errors.ts';

/**
 * Мастер отделён от прежних ручных mobile routes и требует сессию человека на каждом запросе.
 * Binary credentials разрешены только защищённому транспорту без forwarded-заголовков.
 */
export async function deploymentRoutes(app: FastifyInstance, mobile: MobileService): Promise<void> {
  app.addHook('onRequest', async (request, reply) => {
    reply.header('cache-control', 'no-store');

    if (request.authKind !== 'session') {
      return reply.code(403).send({ error: 'session_required' });
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof MobileInputError) {
      return reply.code(error.status).send({ error: error.code, message: error.message });
    }

    const status = (error as { statusCode?: number }).statusCode === 413 ? 413 : 503;

    return reply.code(status).send({ error: 'deployment_unavailable' });
  });

  if (app.hasContentTypeParser('application/octet-stream')) {
    app.removeContentTypeParser('application/octet-stream');
  }

  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 65_536 },
    (_request, body, done) => done(null, body));
  app.get<{ Querystring: { requestId?: string } }>('/api/mobile/deployments',
    async (request) => ({ jobs: await mobile.deploymentService().list(request.query.requestId) }));
  app.get<{ Params: { id: string } }>('/api/mobile/deployments/:id',
    (request) => mobile.deploymentService().get(request.params.id));
  app.post('/api/mobile/deployments', async (request, reply) => {
    const result = await mobile.deploymentService().create(request.body);

    return reply.code(201).send(result);
  });
  app.post<{ Params: { id: string }; Body: Buffer }>(
    '/api/mobile/deployments/:id/credentials', { bodyLimit: 65_536 }, async (request, reply) => {
      const forwarded = Object.keys(request.headers).some((key) => key.startsWith('x-forwarded-')
        || key === 'forwarded');
      const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.ip);

      if (forwarded || request.protocol !== 'https' && !local || !Buffer.isBuffer(request.body)) {
        throw new MobileInputError('secure_transport_required', 'Нужен HTTPS или локальный вход.', 403);
      }

      try {
        let input: unknown;

        try {
          input = JSON.parse(request.body.toString('utf8'));
        } catch {
          throw new MobileInputError('bad_credentials', 'Не удалось прочитать SSH-доступ.');
        }

        return reply.code(202).send(await mobile.deploymentService().credentials(request.params.id, input));
      } finally {
        request.body.fill(0);
      }
    },
  );

  for (const action of ['probe', 'host-key', 'start', 'retry', 'check', 'cancel'] as const) {
    app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
      `/api/mobile/deployments/:id/${action}`, async (request, reply) => {
        const body = request.body;
        const allowed = action === 'probe' ? ['revision'] : action === 'host-key'
          ? ['revision', 'challengeId', 'decision'] : action === 'start'
            ? ['requestId', 'revision', 'previewDigest'] : ['requestId', 'revision'];

        if (!body || typeof body !== 'object' || Array.isArray(body)
          || !Number.isSafeInteger(body.revision) || Object.keys(body).some((key) => !allowed.includes(key))
          || allowed.some((key) => key !== 'revision' && typeof body[key] !== 'string')) {
          throw new MobileInputError('bad_deployment_input', 'Проверьте параметры действия.');
        }

        const service = mobile.deploymentService();
        const id = request.params.id;
        const revision = Number(body.revision);
        let result;

        if (action === 'probe') {
          result = await service.probe(id, { revision });
        } else if (action === 'host-key') {
          result = await service.hostKey(id, {
            revision,
            challengeId: String(body.challengeId),
            decision: String(body.decision),
          });
        } else if (action === 'start') {
          result = await service.start(id, {
            revision,
            requestId: String(body.requestId),
            previewDigest: String(body.previewDigest),
          });
        } else {
          result = await service[action](id, { revision, requestId: String(body.requestId) });
        }

        return reply.code(action === 'probe' || action === 'host-key' ? 200 : 202).send(result);
      },
    );
  }
}
