import assert from 'node:assert/strict';
import test from 'node:test';

import { computeStats, createDockerService } from '../../server/src/lib/docker/service.ts';

/**
 * Клиент-двойник записывает вызовы: политику проверяем по тому, ЧТО ушло демону,
 * а не по тому, что вернул наш же код. Иначе тест подтверждал бы сам себя.
 */
function clientStub(responses = {}) {
  const calls = [];
  const answer = (key, fallback) => (key in responses ? responses[key] : fallback);
  return {
    calls,
    socketPath: '/tmp/docker.sock',
    get: async (path, query) => {
      calls.push({ method: 'GET', path, query });
      return answer(path, {});
    },
    post: async (path, options = {}) => {
      calls.push({ method: 'POST', path, ...options });
      return answer(path, {});
    },
    del: async (path, query) => {
      calls.push({ method: 'DELETE', path, query });
      return answer(path, null);
    },
    request: async () => ({}),
    stream: async () => ({ res: { on() {} }, abort() {} }),
    hijack: async () => ({ on() {}, once() {}, write() {}, destroy() {} }),
  };
}

test('удаление тома отклоняется, пока настройка выключена, и не доходит до демона', async () => {
  const client = clientStub();
  const service = createDockerService({ client, settings: () => ({ allowVolumeRemoval: false }) });

  await assert.rejects(() => service.removeVolume('data'), (error) => {
    assert.equal(error.code, 'volumes_forbidden');
    assert.equal(error.status, 403);
    return true;
  });
  await assert.rejects(() => service.prune({ targets: ['volumes'] }), /запрещена/u);
  assert.equal(client.calls.length, 0, 'запрещённое действие не должно уходить демону');
});

test('разрешённое удаление тома доходит до демона', async () => {
  const client = clientStub();
  const service = createDockerService({ client, settings: () => ({ allowVolumeRemoval: true }) });

  await service.removeVolume('data');

  assert.equal(client.calls[0].method, 'DELETE');
  assert.equal(client.calls[0].path, '/volumes/data');
});

test('очистка образов по умолчанию трогает только висячие', async () => {
  const client = clientStub({ '/images/prune': { ImagesDeleted: [{}], SpaceReclaimed: 512 } });
  const service = createDockerService({ client, settings: () => ({}) });

  const result = await service.prune({ targets: ['images'] });

  const call = client.calls.find((item) => item.path === '/images/prune');
  assert.deepEqual(call.query.filters, { dangling: ['true'] });
  assert.deepEqual(result.report.images, { removed: 1, freed: 512 });
});

test('снос всех неиспользуемых образов требует отдельного разрешения', async () => {
  const denied = createDockerService({ client: clientStub(), settings: () => ({}) });
  await assert.rejects(() => denied.prune({ targets: ['images'], allImages: true }), (error) => {
    assert.equal(error.code, 'images_all_forbidden');
    return true;
  });

  const client = clientStub();
  const allowed = createDockerService({ client, settings: () => ({ allowImagePruneAll: true }) });
  await allowed.prune({ targets: ['images'], allImages: true });
  const call = client.calls.find((item) => item.path === '/images/prune');
  assert.deepEqual(call.query.filters, { dangling: ['false'] });
});

test('отказ одной цели уборки не отменяет остальные', async () => {
  const client = clientStub();
  client.post = async (path) => {
    client.calls.push({ path });
    if (path === '/volumes/prune') throw new Error('volume is in use');
    return { SpaceReclaimed: 100, ContainersDeleted: [{}], CachesDeleted: [{}] };
  };
  const service = createDockerService({ client, settings: () => ({ allowVolumeRemoval: true }) });

  const result = await service.prune({ targets: ['containers', 'volumes', 'buildCache'] });

  assert.equal(result.report.containers.freed, 100);
  assert.match(result.report.volumes.error, /in use/u);
  assert.equal(result.report.buildCache.freed, 100);
});

test('действия над контейнером ограничены белым списком', async () => {
  const client = clientStub();
  const service = createDockerService({ client, settings: () => ({}) });

  await assert.rejects(() => service.containerAction('c1', 'commit'), (error) => {
    assert.equal(error.code, 'bad_action');
    return true;
  });
  await service.containerAction('c1', 'stop');
  assert.equal(client.calls[0].path, '/containers/c1/stop');
  assert.equal(client.calls[0].query.t, 10, 'мягкая остановка получает срок ожидания');
});

test('действие над проектом идёт по его контейнерам, а пустой проект — это 404', async () => {
  const containers = [
    { Id: 'a', Names: ['/proj-app-1'], State: 'running', Ports: [], Labels: {}, Mounts: [] },
    { Id: 'b', Names: ['/proj-db-1'], State: 'running', Ports: [], Labels: {}, Mounts: [] },
  ];
  const client = clientStub({ '/containers/json': containers });
  const service = createDockerService({ client, settings: () => ({}) });

  const result = await service.projectAction('proj', 'stop');

  assert.equal(result.ok, true);
  assert.equal(result.results.length, 2);
  const filters = client.calls[0].query.filters;
  assert.deepEqual(filters, { label: ['com.docker.compose.project=proj'] });
  assert.ok(client.calls.some((call) => call.path === '/containers/a/stop'));

  const empty = createDockerService({
    client: clientStub({ '/containers/json': [] }),
    settings: () => ({}),
  });
  await assert.rejects(() => empty.projectAction('ghost', 'stop'), (error) => {
    assert.equal(error.status, 404);
    return true;
  });
});

test('терминал в контейнер выключается настройкой', async () => {
  const service = createDockerService({ client: clientStub(), settings: () => ({ allowExec: false }) });

  await assert.rejects(() => service.execStart('c1'), (error) => {
    assert.equal(error.code, 'exec_forbidden');
    return true;
  });
});

test('выключение плагина рвёт открытые потоки', async () => {
  let aborted = 0;
  const client = clientStub();
  client.stream = async () => ({ res: { on() {} }, abort: () => { aborted += 1; } });
  const service = createDockerService({ client, settings: () => ({}) });
  client.get = async () => ({ Config: { Tty: false }, State: {}, Mounts: [], NetworkSettings: {} });

  await service.logStream('c1');
  assert.equal(service.activeStreams(), 1);

  await service.disable();

  assert.equal(aborted, 1);
  assert.equal(service.activeStreams(), 0);
});

test('сводка занятого места кэшируется, а «пересчитать» идёт мимо кэша', async () => {
  const client = clientStub({
    '/system/df': { ImageUsage: { TotalSize: 1, Reclaimable: 0 } },
    '/containers/json': [],
    '/images/json': [],
    '/volumes': { Volumes: [] },
    '/networks': [],
  });
  const service = createDockerService({ client, settings: () => ({}) });

  const first = await service.usage();
  const second = await service.usage();
  const forced = await service.usage({ force: true });

  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(forced.cached, false);
  const dfCalls = client.calls.filter((call) => call.path === '/system/df').length;
  assert.equal(dfCalls, 2, 'второй вызов обслужен кэшем');
});

test('проценты CPU и памяти считаются как в docker stats', () => {
  const stats = computeStats({
    read: '2026-09-06T10:00:00Z',
    cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 2000, online_cpus: 4 },
    precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
    memory_stats: { usage: 500, limit: 1000, stats: { inactive_file: 100 } },
    networks: { eth0: { rx_bytes: 10, tx_bytes: 20 } },
    pids_stats: { current: 7 },
  });

  assert.equal(stats.cpuPercent, 40, '(100/1000) * 4 ядра * 100%');
  assert.equal(stats.memoryUsed, 400, 'cache вычтен из потребления');
  assert.equal(stats.memoryPercent, 40);
  assert.equal(stats.networkRx, 10);
  assert.equal(stats.pids, 7);
  assert.equal(computeStats({ read: '0001-01-01T00:00:00Z' }), null);
});
