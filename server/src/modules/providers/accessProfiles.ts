import type { FastifyInstance } from 'fastify';

import { attemptView, type AccessProfileService } from '../../lib/accessProfiles/service.ts';

declare module 'fastify' {
  interface FastifyInstance {
    accessProfiles: AccessProfileService;
  }
}

interface Route {
  Params: {
    id: string;
    profileId: string;
    attemptId: string;
    stepId: string;
    operationId: string;
  };
  Body: Record<string, unknown>;
}

/**
 * Все маршруты находятся под общим guard /api и повторно читают серверное состояние.
 * Публичный ответ не сериализует приватный manifest или окружение драйвера.
 */
export function registerAccessProfiles(app: FastifyInstance, service: AccessProfileService): void {
  app.decorate('accessProfiles', service);

  const base = '/api/providers/:id/access-profiles';

  app.get<Route>(base, (request) => service.list(request.params.id));
  app.post<Route>(`${base}/attempts`, (request) => service.create(request.params.id, request.body));
  app.get<Route>(`${base}/attempts`, async (request) => {
    return service.store.locked(request.params.id, async () => {
      const manifest = await service.manifest(request.params.id);

      return { attempts: manifest.attempts.map(attemptView) };
    });
  });
  app.get<Route>(`${base}/attempts/:attemptId`, (request) =>
    service.attempt(request.params.id, request.params.attemptId));
  app.post<Route>(`${base}/attempts/:attemptId/steps/:stepId`, (request) => service.submit(
    request.params.id, request.params.attemptId, request.params.stepId, request.body,
  ));
  app.post<Route>(`${base}/attempts/:attemptId/cancel`, (request) =>
    service.cancel(request.params.id, request.params.attemptId, request.body));
  app.post<Route>(`${base}/attempts/:attemptId/retry`, async (request) => {
    const attempt = await service.attempt(request.params.id, request.params.attemptId);

    return service.create(request.params.id, {
      operationId: request.body.operationId,
      name: attempt.name,
      methodId: attempt.methodId,
      ...(attempt.profileId ? { profileId: attempt.profileId } : {}),
    });
  });
  app.get<Route>(`${base}/operations/:operationId`, async (request, reply) => {
    return service.store.locked(request.params.id, async () => {
      const manifest = await service.manifest(request.params.id);
      const result = Object.hasOwn(manifest.operations, request.params.operationId)
        ? manifest.operations[request.params.operationId] : undefined;

      return result ?? reply.code(404).send({ error: 'unknown_operation' });
    });
  });
  app.patch<Route>(`${base}/:profileId`, (request) =>
    service.mutate(request.params.id, request.params.profileId, 'rename', request.body));
  app.delete<Route>(`${base}/:profileId`, (request) =>
    service.mutate(request.params.id, request.params.profileId, 'delete', request.body));
  app.post<Route>(`${base}/:profileId/activate`, (request) =>
    service.mutate(request.params.id, request.params.profileId, 'activate', request.body));
}
