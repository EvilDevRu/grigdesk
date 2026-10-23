import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import systemModule from '../../server/src/modules/system/index.ts';
import { deferred, hwmon, mountLine, partition, resourcesFixture, settle } from
  './helpers/system-resources-fixture.js';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

/**
 * Счётчики отделяют медленную ёмкость от текущей температуры того же диска.
 * Любой ввод-вывод при чтении кеша виден независимо от значений снимка.
 */
function counts(f) {
  return {
    ...f.legacy.calls,
    gpu: f.spawns.length,
    statfs: f.io.filter((entry) => entry.method === 'statfs').length,
    mounts: f.io.filter((entry) => entry.path === `${f.procRoot}/mounts`).length,
    temperature: f.io.filter((entry) => entry.path.endsWith('temp1_input')).length,
  };
}

/**
 * Регистрирует настоящий маршрут с инертными соседями без подъёма всего сервера.
 * Адаптером владеет фикстура; Fastify закрывает только свои ресурсы.
 */
async function apiFixture(t, system) {
  const app = Fastify({ logger: false });

  t.after(() => app.close());
  await app.register(systemModule, {
    system,
    config: { rootDir: '/tmp/fixture-unused', grigDeskUpdateStatePath: '/tmp/fixture-unused' },
    releases: {
      async getStatus() {
        return {};
      },
      start() {},
      stop() {},
    },
    updates: {
      async getJob() {
        return null;
      },
      async assertIdle() {},
    },
    launcher: {},
  });
  await app.ready();

  return app;
}

test('RS-01: CPU2с, GPU/температуры5с, диски45с', async (t) => {
  const f = await resourcesFixture(t);
  const disk = await partition(f, 'nvme0n1p1', 'data');
  const sensor = await hwmon(f, 6, 'nvme', 'devices/pci0000:00/0000:01:00.0/nvme/nvme0', {
    temp1_label: 'Composite',
    temp1_input: 55000,
  });

  await f.put('proc/mounts', mountLine(disk));
  f.nvidia.mode = 'success';
  f.nvidia.output = 'GPU-one, 00000000:02:00.0, Fixture RTX, 24, 1536, 8192, 53';

  const adapter = f.start();

  await settle();

  const initial = counts(f);

  adapter.read();
  adapter.read();
  assert.deepEqual(counts(f), initial, 'на базе read ещё вызывает os и читает память');
  assert.equal(initial.gpu, 1);
  assert.equal(initial.statfs, 1);
  await f.advance(1999);
  assert.deepEqual(counts(f), initial);

  f.legacy.user += 75;
  f.legacy.idle += 25;
  await f.advance(1);
  assert.equal(adapter.read().cpu.percent, 75);
  assert.ok(counts(f).cpu > initial.cpu);
  assert.equal(counts(f).gpu, 1);
  assert.equal(counts(f).statfs, 1);

  await f.put(`${sensor}/temp1_input`, 75000);
  f.stats.set(disk.mountpoint, {
    bsize: 1024 ** 3,
    blocks: 100,
    bfree: 5,
    bavail: 5,
  });
  await f.advance(2999);
  assert.equal(counts(f).temperature, initial.temperature);
  await f.advance(1);
  assert.equal(counts(f).gpu, 2);
  assert.ok(counts(f).temperature > initial.temperature);
  assert.equal(counts(f).statfs, 1);
  assert.equal(adapter.read().disks[0].temperature.celsius, 75);
  assert.equal(adapter.read().disks[0].freeGb, 10, 'место ещё из 45-секундного снимка');

  await f.advance(39999);
  assert.equal(counts(f).statfs, 1);
  await f.advance(1);
  assert.equal(counts(f).statfs, 2);
  assert.equal(adapter.read().disks[0].freeGb, 5);
});

test('API-01: GET отдаёт кеш до завершения медленных источников', { timeout: 10000 }, async (t) => {
  const f = await resourcesFixture(t);
  const disk = await partition(f, 'nvme0n1p1', 'data');
  const held = deferred();

  t.after(() => {
    held.resolve({
      bsize: 1024 ** 3,
      blocks: 100,
      bfree: 20,
      bavail: 10,
    });

    for (const entry of f.spawns) {
      entry.child.finish('', 1);
    }
  });
  await f.put('proc/mounts', mountLine(disk));
  f.nvidia.mode = 'held';
  f.stats.set(disk.mountpoint, held.promise);

  const adapter = f.start();
  const app = await apiFixture(t, adapter);

  await settle();

  const before = counts(f);
  const response = await app.inject('/api/system');

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().cpu.cores, 4);
  assert.equal(response.json().mem.totalGb, 24);
  assert.equal(response.json().net.ip, '192.0.2.1');
  assert.deepEqual(counts(f), before, 'на базе GET читает /proc и os вместо готового снимка');
  assert.equal(before.statfs, 1);
  assert.equal(before.gpu, 1);
  await f.advance(45000);
  assert.equal(counts(f).statfs, 1, 'висящий statfs не плодит перекрывающиеся обходы');
  assert.equal(counts(f).gpu, 1, 'висящий child не запускается повторно');

  held.resolve({
    bsize: 1024 ** 3,
    blocks: 100,
    bfree: 20,
    bavail: 10,
  });
  f.spawns[0].child.finish('', 1);
  f.nvidia.mode = 'success';
  f.nvidia.output = 'GPU-one, 00000000:02:00.0, Fixture RTX, 24, 1536, 8192, 53';
  await f.advance(5000);
  await settle();

  const ready = (await app.inject('/api/system')).json();

  assert.equal(ready.disks[0].freeGb, 10);
  assert.equal(ready.gpus[0].memoryUsedGb, 1.5);

  const source = await readFile(new URL('../../server/src/app.ts', import.meta.url), 'utf8');

  assert.match(source, /new SystemAdapter\(\s*\{[\s\S]*?dataHome:\s*config\.dataHome/);
  assert.match(source, /addHook\(['"]onClose['"][\s\S]*?system\.stop\(\)/);
});

test('RS-02: stop запрещает повтор и позднюю публикацию', async (t) => {
  const f = await resourcesFixture(t);
  const disk = await partition(f, 'nvme0n1p1', 'data');
  const held = deferred();

  await f.put('proc/mounts', mountLine(disk));
  f.stats.set(disk.mountpoint, held.promise);
  f.nvidia.mode = 'held';

  const adapter = f.start();

  await settle();
  assert.equal(f.spawns.length, 1, 'на базе адаптер не владеет child аппаратного опроса');

  const child = f.spawns[0].child;

  adapter.stop();

  const before = structuredClone(adapter.read());
  const calls = counts(f);

  assert.deepEqual(child.signals, ['SIGKILL']);
  held.resolve({
    bsize: 1024 ** 3,
    blocks: 100,
    bfree: 20,
    bavail: 10,
  });
  child.finish('GPU-one, 00000000:02:00.0, Late GPU, 99, 1024, 8192, 95');
  await settle();
  await f.advance(90000);
  assert.deepEqual(adapter.read(), before, 'после stop поздние ответы не публикуются');
  assert.deepEqual(counts(f), calls, 'после stop не остаётся таймеров и новых запросов');
});
