import assert from 'node:assert/strict';
import test from 'node:test';

import { createDockerService } from '../../server/src/lib/docker/service.ts';

/**
 * Проверяем границу неизвестного Engine JSON через сервис: двойник возвращает
 * сырые ответы, а проверки касаются результата и повторных обращений к демону.
 */
function fixture(responses = {}, overrides = {}) {
  const reads = [];
  const client = {
    socketPath: '/tmp/docker-engine-boundary.sock',
    async get(path) {
      reads.push(path);

      return responses[path];
    },
    async post() {
      return {};
    },
    async del() {
      return null;
    },
    ...overrides,
  };
  const service = createDockerService({ client });

  return { service, reads };
}

test('старые ответы и null-метаданные сохраняют значения по умолчанию', async () => {
  const { service } = fixture({
    '/containers/json': [{
      Id: 'container',
      Names: null,
      Ports: null,
      Labels: null,
      Mounts: null,
      Health: null,
      NetworkSettings: { Networks: { default: null } },
    }],
    '/images/json': [{ Id: 'image', RepoTags: null, RepoDigests: null }],
    '/volumes': { Volumes: null },
    '/networks': null,
    '/system/df': null,
    '/containers/container/stats': {
      cpu_stats: null,
      memory_stats: { stats: null },
      blkio_stats: { io_service_bytes_recursive: null },
      networks: null,
    },
  });
  const overview = await service.overview();

  assert.equal(overview.containers[0].compose, null);
  assert.deepEqual(overview.containers[0].ports, []);
  assert.deepEqual(overview.containers[0].networks, ['default']);
  assert.equal(overview.images[0].dangling, true);
  assert.deepEqual(overview.volumes, []);
  assert.deepEqual(overview.networks, []);
  assert.equal((await service.usage()).source, 'computed');
  assert.equal((await service.statsOnce('container')).memoryUsed, 0);
});

test('повреждённый Engine JSON отклоняется без исходного значения в ошибке', async () => {
  const rejectedValue = 'значение-которое-нельзя-публиковать';
  const { service } = fixture({
    '/containers/json': [{ Id: 'container', Ports: [{ PrivatePort: rejectedValue }] }],
    '/images/json': [],
    '/volumes': {},
    '/networks': [],
    '/containers/container/stats': { memory_stats: { usage: rejectedValue } },
  });

  for (const action of [() => service.overview(), () => service.statsOnce('container')]) {
    await assert.rejects(action, (error) => {
      assert.equal(error.status, 502);
      assert.equal(error.code, 'docker_bad_response');
      assert.match(error.message, /PrivatePort|memory_stats\.usage/u);
      assert.equal(error.message.includes(rejectedValue), false);

      return true;
    });
  }
});

test('неудачный принудительный пересчёт не заменяет последнюю корректную сводку', async () => {
  const responses = {
    '/system/df': { ImageUsage: { TotalSize: 2048, Reclaimable: 512 } },
    '/containers/json': [],
    '/images/json': [],
    '/volumes': { Volumes: [] },
    '/networks': [],
  };
  const { service, reads } = fixture(responses);
  const original = await service.usage();

  responses['/system/df'] = { ImageUsage: { TotalSize: 'broken' } };

  await assert.rejects(() => service.usage({ force: true }), /df\.ImageUsage\.TotalSize/u);

  const cached = await service.usage();

  assert.equal(cached.cached, true);
  assert.equal(cached.images.size, original.images.size);
  assert.equal(cached.computedAt, original.computedAt);
  assert.equal(reads.filter((path) => path === '/system/df').length, 2);
});

test('повреждённый отчёт одной уборки не отменяет последующие цели', async () => {
  const calls = [];
  const { service } = fixture({}, {
    async post(path) {
      calls.push(path);

      return path === '/containers/prune'
        ? { ContainersDeleted: 'broken', SpaceReclaimed: 10 }
        : { CachesDeleted: ['cache'], SpaceReclaimed: 20 };
    },
  });
  const result = await service.prune({ targets: ['containers', 'buildCache'] });

  assert.match(result.report.containers.error, /prune\.ContainersDeleted/u);
  assert.equal(result.report.containers.freed, 0);
  assert.deepEqual(result.report.buildCache, { removed: 1, freed: 20 });
  assert.deepEqual(calls, ['/containers/prune', '/build/prune']);
});

test('inspect не переносит окружение и посторонние поля в карточку', async () => {
  const { service } = fixture({
    '/containers/container/json': {
      Id: 'container',
      Config: { Tty: true, Env: ['EXAMPLE_SECRET=private-value'], Extra: 'private-value' },
      State: { ExitCode: 0 },
      HostConfig: null,
      Mounts: null,
      NetworkSettings: null,
    },
  });
  const inspected = await service.inspect('container');

  assert.equal(inspected.tty, true);
  assert.equal(inspected.exitCode, 0);
  assert.deepEqual(inspected.mounts, []);
  assert.equal(JSON.stringify(inspected).includes('private-value'), false);
  assert.equal('Env' in inspected, false);
});
