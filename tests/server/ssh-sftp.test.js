import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

async function fixture(t, authKind) {
  let module;
  try {
    module = await import('../../server/src/modules/ssh/index.js');
  } catch (error) {
    assert.fail(`human-only SFTP API ещё не реализован: ${error.message}`);
  }
  const app = Fastify({ logger: false });
  app.decorateRequest('authKind', null);
  app.addHook('onRequest', async (request) => { request.authKind = authKind; });
  app.decorate('pluginEnabled', () => true);
  await app.register(module.default, {
    service: {
      async listFiles() { return [{ name: 'app.log', type: 'file', size: 12 }]; },
    },
  });
  t.after(() => app.close());
  return app;
}

test('SFTP-список доступен человеку с browser session', async (t) => {
  const app = await fixture(t, 'session');
  const response = await app.inject({
    method: 'GET',
    url: '/api/ssh/sessions/session-a/files?path=%2Fvar%2Flog',
  });

  assert.deepEqual({ status: response.statusCode, body: response.json() }, {
    status: 200,
    body: { files: [{ name: 'app.log', type: 'file', size: 12 }] },
  });
});

test('внутренний агентский канал не получает SFTP-список', async (t) => {
  const app = await fixture(t, 'internal');
  const response = await app.inject({
    method: 'GET',
    url: '/api/ssh/sessions/session-a/files?path=%2Fvar%2Flog',
  });

  assert.deepEqual({ status: response.statusCode, error: response.json().error }, {
    status: 403,
    error: 'session_required',
  });
});
