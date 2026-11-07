import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import dockerModule from '../../server/src/modules/docker/index.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

function serviceStub() {
  const calls = [];
  return {
    calls,
    health: async () => ({ available: true, version: '29.5.2' }),
    overview: async () => ({ containers: [], projects: [], counts: {} }),
    usage: async (options) => {
      calls.push(['usage', options]);
      return { source: 'daemon' };
    },
    inspect: async (id) => ({ id }),
    containerAction: async (id, action) => {
      calls.push(['action', id, action]);
      return { ok: true, action };
    },
    projectAction: async () => ({ ok: true, results: [] }),
    removeContainer: async (id, options) => {
      calls.push(['remove', id, options]);
      return { ok: true };
    },
    removeImage: async () => ({ ok: true }),
    removeVolume: async () => {
      const error = new Error('удаление томов запрещено настройками плагина');
      error.status = 403;
      error.code = 'volumes_forbidden';
      throw error;
    },
    removeNetwork: async () => ({ ok: true }),
    prune: async (input) => {
      calls.push(['prune', input]);
      return { ok: true, report: {} };
    },
  };
}

async function fixture(t, { enabled = true, authKind = 'session' } = {}) {
  const app = Fastify({ logger: false });
  const service = serviceStub();
  app.decorate('pluginEnabled', (id) => id === 'docker' && enabled);
  app.addHook('onRequest', async (request) => {
    request.authKind = authKind;
  });
  await app.register(dockerModule, { service });
  t.after(() => app.close());
  return { app, service };
}

test('выключенный плагин закрывает все ручки докера одним plugin_disabled', async (t) => {
  const { app } = await fixture(t, { enabled: false });
  const requests = [
    ['GET', '/api/docker/health'],
    ['GET', '/api/docker/overview'],
    ['GET', '/api/docker/usage'],
    ['GET', '/api/docker/containers/c1'],
    ['POST', '/api/docker/containers/c1/stop'],
    ['DELETE', '/api/docker/containers/c1'],
    ['POST', '/api/docker/projects/proj/stop'],
    ['DELETE', '/api/docker/images/i1'],
    ['DELETE', '/api/docker/volumes/v1'],
    ['DELETE', '/api/docker/networks/n1'],
    ['POST', '/api/docker/prune'],
  ];

  for (const [method, url] of requests) {
    const response = await app.inject({ method, url, payload: method === 'POST' ? {} : undefined });
    assert.equal(response.statusCode, 404, `${method} ${url}`);
    assert.equal(response.json().error, 'plugin_disabled', `${method} ${url}`);
  }
});

test('токен агента в панель докера не пускается — это инструмент человека', async (t) => {
  const { app } = await fixture(t, { authKind: 'token' });

  const response = await app.inject({ method: 'GET', url: '/api/docker/overview' });

  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error, 'session_required');
});

test('отказ политики доезжает до клиента своим статусом и кодом', async (t) => {
  const { app } = await fixture(t);

  const response = await app.inject({ method: 'DELETE', url: '/api/docker/volumes/data' });

  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error, 'volumes_forbidden');
  assert.match(response.json().message, /запрещено/u);
});

test('параметры запросов доходят до сервиса разобранными', async (t) => {
  const { app, service } = await fixture(t);

  await app.inject({ method: 'GET', url: '/api/docker/usage?force=1' });
  await app.inject({ method: 'DELETE', url: '/api/docker/containers/c1?force=1&volumes=0' });
  await app.inject({
    method: 'POST',
    url: '/api/docker/prune',
    payload: { targets: ['images', 'buildCache'], allImages: true },
  });

  assert.deepEqual(service.calls[0], ['usage', { force: true }]);
  assert.deepEqual(service.calls[1], ['remove', 'c1', { force: true, volumes: false }]);
  assert.deepEqual(service.calls[2], ['prune', { targets: ['images', 'buildCache'], allImages: true }]);
});

test('гейт докера не трогает чужие маршруты того же приложения', async (t) => {
  const { app } = await fixture(t, { enabled: false });
  app.get('/api/other', async () => ({ ok: true }));

  const response = await app.inject({ method: 'GET', url: '/api/other' });

  assert.equal(response.statusCode, 200);
});
