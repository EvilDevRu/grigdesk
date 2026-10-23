import assert from 'node:assert/strict';
import test from 'node:test';

import { hwmon, mountLine, partition, resourcesFixture, settle } from './helpers/system-resources-fixture.js';

test('RT-01: температуры принадлежат устройствам', async (t) => {
  const f = await resourcesFixture(t);
  const cpu = await hwmon(f, 12, 'k10temp', 'devices/platform/cpu', {
    temp1_label: 'Tctl',
    temp1_input: 72800,
    temp2_label: 'Tccd1',
    temp2_input: 99000,
  });

  for (const [index, driver] of ['gigabyte_wmi', 'acpitz', 'iwlwifi'].entries()) {
    await hwmon(f, index, driver, `devices/platform/ignored${index}`, {
      temp1_input: 99000,
    });
  }

  const disk = await partition(f, 'nvme0n1p2', 'data');

  await f.put('proc/mounts', mountLine(disk));
  await hwmon(f, 7, 'nvme', 'devices/pci0000:00/0000:01:00.0/nvme/nvme0', {
    temp1_label: 'Composite',
    temp1_input: 41000,
    temp1_max: 79850,
    temp1_crit: 84850,
    temp2_label: 'Sensor 1',
    temp2_input: 91000,
  });

  const adapter = f.start();

  await settle();
  assert.deepEqual(adapter.read().cpu.temperature, { celsius: 72.8 },
    'на базе нет cpu.temperature; не подставляем значение из датчика платы');
  assert.equal(adapter.read().disks.length, 1);
  assert.deepEqual(adapter.read().disks[0].temperature, {
    celsius: 41,
    maxCelsius: 79.85,
    critCelsius: 84.85,
  });

  await f.remove('sys/class/hwmon/hwmon12');
  await hwmon(f, 30, 'coretemp', 'devices/platform/package0', {
    temp1_label: 'Package id 0',
    temp1_input: 65000,
    temp1_max: 85000,
    temp1_crit: 100000,
    temp2_label: 'Core 0',
    temp2_input: 99000,
  });
  await hwmon(f, 4, 'coretemp', 'devices/platform/package1', {
    temp3_label: 'Package id 1',
    temp3_input: 75000,
    temp3_max: 90000,
    temp3_crit: 105000,
  });
  await f.advance(5000);

  assert.deepEqual(adapter.read().cpu.temperature, {
    celsius: 75,
    maxCelsius: 90,
    critCelsius: 105,
  }, 'берётся горячий пакет вместе с пределами того же канала');

  await f.put('sys/devices/platform/package1/hwmon/hwmon4/temp3_input', 'не число');
  await f.advance(5000);
  assert.equal(adapter.read().cpu.temperature.celsius, 65);

  await f.remove('sys/class/hwmon/hwmon30');
  await f.remove('sys/class/hwmon/hwmon4');
  await f.put(`${cpu}/temp1_input`, 'не число');
  await f.advance(5000);
  assert.equal(adapter.read().cpu.temperature, undefined,
    'успешный обход без датчика удаляет старую температуру, а не держит её навечно');

  f.readErrors.set('temp1_input', Object.assign(new Error('Фикстура без доступа'), { code: 'EACCES' }));
  await f.advance(5000);
  assert.equal(adapter.read().cpu.temperature, undefined);
  assert.equal(adapter.read().disks[0].temperature, undefined);
});
