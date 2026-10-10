import { createRequire } from 'node:module';

import { OperationJournal } from '../../../server/src/lib/mobile/idempotency.ts';
import { registerOperationGuard } from '../../../server/src/lib/mobile/operations.ts';
import { temporary } from '../../relay/helpers.js';

const requireFromServer = createRequire(new URL('../../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

export const testDevice = {
  id: 'd12345678',
  name: 'Тестовый телефон',
  fp: 'a'.repeat(64),
  createdAt: 1760000000000,
  lastSeenAt: 1760000000000,
  revokedAt: null,
};

/**
 * Фасад тестируется через настоящий Fastify и тот же durable guard операций, что TLS-вход.
 * Только TLS identity подставляется синтетически; проверка сертификатов живёт в MB/V тестах.
 */
export async function mobileFacadeFixture(t, register) {
  const directory = await temporary(t);
  const app = Fastify({ logger: false });

  app.decorateRequest('mobileDevice', null);
  app.decorateRequest('mobileFingerprint', testDevice.fp);
  app.addHook('onRequest', async (request) => {
    request.mobileDevice = testDevice;
  });
  registerOperationGuard(app, { journal: new OperationJournal(directory) });
  app.setErrorHandler((error, _request, reply) =>
    reply.code(error.status || 500).send({
      error: error.code || 'test_error',
      message: error.message,
    }),
  );
  await register(app, directory);
  t.after(() => app.close());

  return {
    app,
    directory,
  };
}

/**
 * Каждый POST получает исходное время и устойчивый ключ до первого сетевого вызова.
 * Повтор использует заданный ключ, а не создаёт новый идентификатор вместо восстановления.
 */
export function mutation(app, url, payload, key = 'test-operation-1', createdAt = Date.now()) {
  return app.inject({
    method: 'POST',
    url,
    payload,
    headers: {
      'idempotency-key': key,
      'x-cockpit-operation-created-at': String(createdAt),
    },
  });
}
