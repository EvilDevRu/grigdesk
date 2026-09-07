import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { createDockerService } from '../../server/src/lib/docker/service.ts';
import dockerModule from '../../server/src/modules/docker/index.ts';
import * as contracts from '../../shared/dockerContracts.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

/**
 * Фикстура содержит богатый и минимальный ответы демона: отсутствие необязательных
 * полей должно нормализоваться до той же формы, которую проверяет браузер.
 */
function engineResponses() {
  return {
    '/version': { Version: '29.0.0', ApiVersion: '1.52' },
    '/containers/json': [
      {
        Id: 'app',
        Names: ['/example-app-1'],
        Image: 'example:latest',
        ImageID: 'sha256:used',
        Created: 1_788_536_132,
        State: 'running',
        Status: 'Up 1 hour',
        Health: { Status: 'healthy' },
        Ports: [{ PrivatePort: 80, PublicPort: 8080, Type: 'tcp', IP: '0.0.0.0' }],
        Labels: {
          'com.docker.compose.project': 'example',
          'com.docker.compose.service': 'app',
          'com.docker.compose.container-number': '1',
        },
        Mounts: [{ Type: 'volume', Name: 'data', Destination: '/data' }],
        NetworkSettings: { Networks: { example_default: {} } },
        SizeRw: 64,
      },
      { Id: 'minimal' },
    ],
    '/images/json': [
      { Id: 'sha256:used', RepoTags: ['example:latest'], Size: 2048 },
      { Id: 'sha256:unused', RepoTags: null, RepoDigests: null },
    ],
    '/volumes': {
      Volumes: [
        { Name: 'data', Driver: 'local' },
        { Name: 'anonymous', Labels: { 'com.docker.volume.anonymous': '' } },
      ],
    },
    '/networks': [
      { Id: 'bridge-id', Name: 'bridge' },
      {
        Id: 'project-network',
        Name: 'example_default',
        IPAM: { Config: [{}, { Subnet: '172.20.0.0/16' }] },
      },
    ],
    '/system/df': {
      ImageUsage: { TotalCount: 2, ActiveCount: 1, TotalSize: 2048, Reclaimable: 512 },
      Volumes: [{ Name: 'data', UsageData: { Size: 4096 } }],
      BuildCache: [{ ID: 'cache', Size: 1024 }],
    },
  };
}

/**
 * Настоящие модуль HTTP, сервис и нормализаторы работают поверх двойника Engine.
 * Проверяем сериализованный ответ ручки общим декодером, не имитируя DTO сервиса.
 */
async function fixture(t, responses = engineResponses()) {
  const client = {
    socketPath: '/tmp/docker-contract-test.sock',
    async get(path) {
      const response = responses[path];

      if (response instanceof Error) {
        throw response;
      }

      assert.ok(Object.hasOwn(responses, path), `неожиданный GET ${path}`);

      return response;
    },
    async post(path) {
      if (path === '/containers/minimal/restart' || path === '/volumes/prune') {
        throw new Error('ошибка тестового демона');
      }

      return { ContainersDeleted: ['old'], CachesDeleted: ['cache'], SpaceReclaimed: 64 };
    },
    async del() {
      return null;
    },
  };
  const service = createDockerService({ client, settings: () => ({ allowVolumeRemoval: true }) });
  const app = Fastify({ logger: false });

  app.decorate('pluginEnabled', (id) => id === 'docker');
  app.addHook('onRequest', async (request) => {
    request.authKind = 'session';
  });
  await app.register(dockerModule, { service });
  t.after(() => app.close());

  return { app, service };
}

test('реальный HTTP-обзор проходит общий контракт с полными и отсутствующими метаданными', async (t) => {
  const { app } = await fixture(t);
  const response = await app.inject('/api/docker/overview');

  assert.equal(response.statusCode, 200);

  const overview = contracts.parseDockerOverview(response.json());

  assert.deepEqual(overview, response.json(), 'нормализатор не теряет поля при проверке контракта');
  assert.equal(overview.containers[0].compose.project, 'example');
  assert.equal(overview.containers[1].createdAt, null);
  assert.equal(overview.volumes.find((volume) => volume.name === 'data').inUse, true);
  assert.deepEqual(overview.networks.find((network) => network.name === 'example_default').subnets,
    ['172.20.0.0/16']);
});

test('ответ usage остаётся совместимым до кэша, из кэша и после принудительного пересчёта', async (t) => {
  const { app } = await fixture(t);
  const snapshots = [];

  for (const url of ['/api/docker/usage', '/api/docker/usage', '/api/docker/usage?force=1']) {
    const response = await app.inject(url);

    assert.equal(response.statusCode, 200);

    const usage = contracts.parseDockerUsage(response.json());

    assert.deepEqual(usage, response.json());
    snapshots.push(usage);
  }

  assert.deepEqual(snapshots.map((usage) => usage.cached), [false, true, false]);
  assert.equal(snapshots[0].computedAt, snapshots[1].computedAt);
  assert.equal(snapshots[0].images.reclaimable, 512);
  assert.equal(snapshots[0].volumes.size, 4096);
});

test('оба состояния доступности демона соответствуют дискриминированному контракту', async (t) => {
  const responses = engineResponses();
  const { app } = await fixture(t, responses);
  const available = await app.inject('/api/docker/health');

  assert.equal(contracts.parseDockerHealth(available.json()).available, true);

  responses['/version'] = new Error('тестовый сокет недоступен');

  const unavailable = await app.inject('/api/docker/health');
  const health = contracts.parseDockerHealth(unavailable.json());

  assert.equal(health.available, false);
  assert.equal(health.error, 'docker_error');
});

test('частичные отказы действий над проектом и уборки сохраняются в контракте ответа', async (t) => {
  const { app } = await fixture(t);
  const projectResponse = await app.inject({
    method: 'POST',
    url: '/api/docker/projects/example/restart',
    payload: {},
  });
  const project = contracts.parseDockerProjectActionResponse(projectResponse.json());

  assert.equal(project.ok, false);
  assert.deepEqual(project.results.map((item) => item.ok), [true, false]);
  assert.equal(project.results[1].message, 'ошибка тестового демона');

  const pruneResponse = await app.inject({
    method: 'POST',
    url: '/api/docker/prune',
    payload: { targets: ['containers', 'volumes', 'buildCache'] },
  });
  const prune = contracts.parseDockerPruneResponse(pruneResponse.json());

  assert.equal(prune.report.volumes.error, 'ошибка тестового демона');
  assert.equal(prune.report.buildCache.freed, 64);
  assert.equal(prune.report.containers.removed, 1);
});

test('нормализованная статистика принимается общим декодером сообщений WebSocket', async (t) => {
  const responses = engineResponses();

  responses['/containers/app/stats'] = {
    read: '2026-09-06T10:00:00Z',
    cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 2000, online_cpus: 4 },
    precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
    memory_stats: { usage: 500, limit: 1000, stats: { inactive_file: 100 } },
    networks: { eth0: { rx_bytes: 10, tx_bytes: 20 } },
    blkio_stats: { io_service_bytes_recursive: [{ op: 'Read', value: 50 }] },
    pids_stats: { current: 7 },
  };

  const { service } = await fixture(t, responses);
  const stats = await service.statsOnce('app');
  const message = contracts.parseDockerStatsMessage({
    t: 'stats',
    at: '2026-09-06T10:00:00Z',
    items: { app: stats },
  });

  assert.deepEqual(message.items.app, stats);
  assert.equal(message.items.app.cpuPercent, 40);
  assert.equal(message.items.app.blockRead, 50);
});
