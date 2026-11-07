import assert from 'node:assert/strict';
import test from 'node:test';

import { hwmon, resourcesFixture, settle } from './helpers/system-resources-fixture.js';

const NVIDIA = [
  'GPU-one, 00000000:02:00.0, Fixture RTX, 24, 1536, 8192, 53',
  'GPU-two, 00000000:03:00.0, Fixture Tesla, N/A, N/A, N/A, N/A',
].join('\n');

/**
 * Карты DRM и hwmon указывают на один канонический PCI device.
 * Дубликат card7 проверяет, что AMD-карта не превращается в две строки.
 */
async function amd(f) {
  const device = 'sys/devices/pci0000:00/0000:04:00.0';

  await f.put(`${device}/vendor`, '0x1002');
  await f.put(`${device}/product_name`, 'Fixture Radeon');
  await f.put(`${device}/gpu_busy_percent`, 37);
  await f.put(`${device}/mem_info_vram_used`, 1.5 * 1024 ** 3);
  await f.put(`${device}/mem_info_vram_total`, 8 * 1024 ** 3);
  await f.link('sys/class/drm/card0/device', device);
  await f.link('sys/class/drm/card7/device', device);
  await hwmon(f, 17, 'amdgpu', device.slice(4), {
    temp1_label: 'edge',
    temp1_input: 61000,
    temp1_max: 85000,
    temp1_crit: 95000,
    temp2_label: 'junction',
    temp2_input: 92000,
  });

  return device;
}

test('RG-01: несколько GPU и AMD без команд', async (t) => {
  const f = await resourcesFixture(t);
  const device = await amd(f);

  await hwmon(f, 2, 'nvidia', 'devices/pci0000:00/0000:02:00.0', {
    temp1_input: 53000,
    temp1_max: 80000,
    temp1_crit: 90000,
  });
  f.nvidia.mode = 'success';
  f.nvidia.output = NVIDIA;

  const adapter = f.start();

  await settle();

  const cards = adapter.read().gpus;

  assert.equal(cards?.length, 3, 'на базе отсутствует список двух NVIDIA и одной AMD');
  assert.equal(new Set(cards.map((gpu) => gpu.id)).size, 3);

  const first = cards.find((gpu) => gpu.id === 'GPU-one');

  assert.equal(first.name, 'Fixture RTX');
  assert.equal(first.percent, 24);
  assert.equal(first.memoryUsedGb, 1.5);
  assert.equal(first.memoryTotalGb, 8);
  assert.deepEqual(first.temperature, {
    celsius: 53,
    maxCelsius: 80,
    critCelsius: 90,
  });

  const unknown = cards.find((gpu) => gpu.id === 'GPU-two');

  assert.equal(unknown.name, 'Fixture Tesla');
  assert.equal(unknown.percent, undefined);
  assert.equal(unknown.memoryUsedGb, undefined);
  assert.equal(unknown.memoryTotalGb, undefined);
  assert.equal(unknown.temperature, undefined);

  const radeon = cards.find((gpu) => gpu.name === 'Fixture Radeon');

  assert.equal(radeon.percent, 37);
  assert.equal(radeon.memoryUsedGb, 1.5);
  assert.equal(radeon.memoryTotalGb, 8);
  assert.deepEqual(radeon.temperature, {
    celsius: 61,
    maxCelsius: 85,
    critCelsius: 95,
  });
  assert.equal(f.spawns.length, 1);
  assert.equal(f.spawns[0].command, 'nvidia-smi');
  assert.deepEqual(f.spawns[0].args, [
    '--query-gpu=uuid,pci.bus_id,name,utilization.gpu,memory.used,memory.total,temperature.gpu',
    '--format=csv,noheader,nounits',
  ]);
  assert.ok(!f.spawns[0].options?.shell);

  const { readAmdGpus } = await import('../../server/src/lib/systemResources/gpu.ts');
  const before = f.spawns.length;
  const amdCards = await readAmdGpus(f.options);

  assert.equal(amdCards.length, 1);
  assert.equal(f.spawns.length, before, 'чтение AMD не запускает никакой процесс');
  await f.remove(`${device}/gpu_busy_percent`);
  await f.put(`${device}/mem_info_vram_used`, 'не число');
  await f.remove(`${device}/mem_info_vram_total`);
  await f.advance(5000);

  const partial = adapter.read().gpus.find((gpu) => gpu.id === radeon.id);

  assert.equal(partial.percent, undefined);
  assert.equal(partial.memoryUsedGb, undefined);
  assert.equal(partial.memoryTotalGb, undefined);
  assert.equal(partial.temperature.celsius, 61);

  await f.remove('sys/class/drm/card0');
  await f.remove('sys/class/drm/card7');
  f.nvidia.output = '';
  await f.advance(5000);
  assert.equal(adapter.read().gpus?.length ?? 0, 0, 'успешный пустой ответ удаляет карты');
});

test('RG-02: ENOENT, срок и живой прежний child', async (t) => {
  const f = await resourcesFixture(t);
  const adapter = f.start();

  await settle();
  assert.equal(f.spawns.length, 1, 'на базе не выполняется независимая проба NVIDIA');
  await f.advance(20000);
  assert.equal(f.spawns.length, 1, 'ENOENT выключает опрос до нового сборщика');
  adapter.stop();

  await amd(f);
  f.nvidia.mode = 'held';

  const held = f.start();

  await settle();
  assert.equal(f.spawns.length, 2);

  const child = f.spawns[1].child;

  await f.advance(1999);
  assert.deepEqual(child.signals, []);
  await f.advance(1);
  assert.deepEqual(child.signals, ['SIGKILL']);
  await f.advance(15000);
  assert.equal(f.spawns.length, 2, 'kill не освобождает single-flight до close');
  assert.equal(held.read().gpus.find((gpu) => gpu.name === 'Fixture Radeon').temperature.celsius, 61);

  child.finish('', 1);
  await f.advance(5000);
  assert.equal(f.spawns.length, 3, 'только close позволяет следующую пробу');
  f.spawns[2].child.finish(NVIDIA);
  await settle();
  assert.equal(held.read().gpus.find((gpu) => gpu.id === 'GPU-one').memoryUsedGb, 1.5);

  await f.advance(5000);
  f.spawns[3].child.finish('ошибка драйвера', 1);
  await settle();
  assert.equal(held.read().gpus.find((gpu) => gpu.id === 'GPU-one').memoryUsedGb, 1.5,
    'сбой команды оставляет последний успешный снимок');
  await f.advance(5000);
  f.spawns[4].child.finish('x'.repeat(2 * 1024 * 1024));
  await settle();
  assert.equal(held.read().gpus.find((gpu) => gpu.id === 'GPU-one').memoryUsedGb, 1.5,
    'слишком большой вывод не публикуется как новый снимок');
});
