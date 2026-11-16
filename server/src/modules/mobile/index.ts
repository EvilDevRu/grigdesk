import type { FastifyInstance } from 'fastify';
import qrcode from 'qrcode-generator';

import { MobileInputError } from '../../lib/mobile/errors.ts';
import type { MobileService } from '../../lib/mobile/service.ts';
import { deploymentRoutes } from './deployments.ts';

/**
 * Административные ручки наследуют общий auth guard основного API.
 * Env и QR выдаются без кэширования и без записи содержимого в журнал.
 */
export default async function mobileModule(
  app: FastifyInstance,
  options: { service: MobileService },
) {
  const { service } = options;

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof MobileInputError) {
      return reply.code(error.status).send({
        error: error.code,
        message: error.message,
      });
    }

    return reply.code(503).send({
      error: 'mobile_unavailable',
      message: 'Мобильный доступ недоступен.',
    });
  });
  await app.register(async (scope) => deploymentRoutes(scope, service));

  app.get('/api/mobile/status', () => service.status());
  app.post<{ Body: Parameters<MobileService['addRelay']>[0] }>(
    '/api/mobile/relays',
    async (request) => ({
      relay: await service.addRelay(request.body ?? {}),
    }),
  );
  app.get<{ Params: { id: string } }>('/api/mobile/relays/:id/env', async (request, reply) => {
    const env = await service.relayEnv(request.params.id);

    return reply
      .header('cache-control', 'no-store')
      .header('content-disposition', 'attachment; filename="relay.env"')
      .type('text/plain; charset=utf-8')
      .send(env);
  });
  app.post<{
    Params: { id: string };
    Body: { pair?: unknown };
  }>('/api/mobile/relays/:id/qr', async (request, reply) => {
    if (typeof request.body?.pair !== 'boolean') {
      throw new MobileInputError('bad_pair', 'Укажите вид QR: телефон или посредник.');
    }

    const value = await service.qr(request.params.id, request.body.pair);
    const qr = qrcode(0, 'M');

    qr.addData(value.text, 'Byte');
    qr.make();

    return reply.header('cache-control', 'no-store').send({
      ...value,
      svg: qr.createSvgTag(4, 4),
    });
  });
  app.delete<{ Params: { id: string } }>('/api/mobile/relays/:id', async (request) => {
    await service.removeRelay(request.params.id);

    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/mobile/devices/:id/revoke', async (request) => {
    await service.revokeDevice(request.params.id);

    return { ok: true };
  });
}
