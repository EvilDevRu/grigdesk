import assert from 'node:assert/strict';
import test from 'node:test';

import { hwmon, mountLine, partition, resourcesFixture, settle } from './helpers/system-resources-fixture.js';

test('RD-01: настоящие разделы без дублей и диск данных', async (t) => {
  const f = await resourcesFixture(t);
  const root = await partition(f, 'nvme0n1p1', 'root');
  const data = await partition(f, 'nvme0n1p2', 'data');
  const data2 = await partition(f, 'nvme1n1p1', 'data2');
  const spaced = await partition(f, 'sda1', 'backup disk');
  const efi = await partition(f, 'nvme0n1p3', 'efi');
  const loop = await partition(f, 'loop0', 'loop');
  const ignored = ['tmpfs', 'proc', 'overlay', 'nfs', 'cifs'];
  const alias = { device: `${f.devRoot}/disk/by-uuid/data`, mountpoint: `${f.root}/mounts/data/bind` };

  await f.link('dev/disk/by-uuid/data', 'dev/nvme0n1p2');
  await f.put('mounts/data/bind/app/.fixture', '');
  await f.put('mounts/data/subvolume/.fixture', '');
  await f.link('data-home-link', 'mounts/data/bind/app');
  f.stats.set('/', f.stats.get(root.mountpoint));
  root.mountpoint = '/';
  efi.mountpoint = '/boot/efi';

  const mounts = [
    mountLine(root),
    mountLine({ ...root, mountpoint: `${f.root}/mounts/root-bind` }),
    mountLine(data, 'btrfs'),
    mountLine(data2),
    mountLine(alias, 'btrfs'),
    mountLine({ ...data, mountpoint: `${f.root}/mounts/data/subvolume` }, 'btrfs'),
    mountLine(spaced, 'exfat'),
    mountLine(efi, 'vfat'),
    mountLine(loop),
    ...ignored.map((type) => `${type} ${f.root}/mounts/${type} ${type} rw 0 0`),
  ];

  await f.put('proc/mounts', mounts.join('\n'));

  const adapter = f.start({ dataHome: `${f.root}/data-home-link` });

  await settle();

  const disks = adapter.read().disks;

  assert.equal(disks?.length, 4, 'на базе нет списка настоящих уникальных разделов');
  assert.deepEqual(disks.map((disk) => disk.mountpoint),
    ['/', spaced.mountpoint, data.mountpoint, data2.mountpoint].sort());
  assert.equal(new Set(disks.map((disk) => disk.id)).size, 4);
  assert.deepEqual(disks.filter((disk) => disk.dataHome).map((disk) => disk.mountpoint),
    [data.mountpoint], 'флаг bind-маунта переносится на представителя раздела');

  for (const disk of disks) {
    assert.equal(disk.totalGb, 100);
    assert.equal(disk.usedGb, 80);
    assert.equal(disk.freeGb, 10);
    assert.equal(disk.percent, 80);
    assert.ok(disk.device.startsWith(f.devRoot));
  }

  const statPaths = f.io.filter((call) => call.method === 'statfs').map((call) => call.path);

  assert.deepEqual(statPaths.sort(), disks.map((disk) => disk.mountpoint).sort(),
    'EFI, служебные и сетевые ФС, loop и дубли исключены до statfs');
  adapter.stop();

  await f.put('mounts/data2/nested/app/.fixture', '');

  const second = f.start({ dataHome: `${data2.mountpoint}/nested/app` });

  await settle();
  assert.deepEqual(second.read().disks.filter((disk) => disk.dataHome).map((disk) => disk.mountpoint),
    [data2.mountpoint], '/data не совпадает с /data2 по префиксу');

  await f.put('proc/mounts', '');
  await f.advance(45000);
  assert.equal(second.read().disks?.length ?? 0, 0, 'успешный пустой список удаляет разделы');
});

test('RD-02: температура своего NVMe и недоступные ФС', async (t) => {
  const f = await resourcesFixture(t);
  const first = await partition(f, 'nvme0n1p1', 'data');
  const sibling = await partition(f, 'nvme0n1p2', 'other-partition');
  const second = await partition(f, 'nvme1n1p1', 'second');
  const absent = await partition(f, 'sda2', 'unavailable');
  const zero = await partition(f, 'sda3', 'zero', {
    blocks: 0,
    bfree: 0,
    bavail: 0,
  });

  f.stats.set(absent.mountpoint, Object.assign(new Error('Диск отключён'), { code: 'EIO' }));
  await hwmon(f, 19, 'nvme', 'devices/pci0000:00/0000:01:00.0/nvme/nvme0', {
    temp1_label: 'Composite',
    temp1_input: 55000,
  });
  await hwmon(f, 3, 'nvme', 'devices/pci0000:00/0000:01:00.0/nvme/nvme1', {
    temp1_label: 'Composite',
    temp1_input: 35000,
  });

  const dm = await partition(f, 'dm-0', 'mapper');
  const ambiguous = await partition(f, 'md0', 'raid');

  await f.link('sys/devices/virtual/block/dm-0/slaves/nvme0n1p1',
    'sys/devices/pci0000:00/0000:01:00.0/nvme/nvme0/nvme0n1/nvme0n1p1');
  await f.link('sys/devices/virtual/block/md0/slaves/nvme0n1p1',
    'sys/devices/pci0000:00/0000:01:00.0/nvme/nvme0/nvme0n1/nvme0n1p1');
  await f.link('sys/devices/virtual/block/md0/slaves/nvme1n1p1',
    'sys/devices/pci0000:00/0000:01:00.0/nvme/nvme1/nvme1n1/nvme1n1p1');
  await f.put('proc/mounts', [first, sibling, second, absent, zero, dm, ambiguous].map((disk) =>
    mountLine(disk)).join('\n'));

  const adapter = f.start();

  await settle();
  assert.equal(adapter.read().disks?.length, 5, 'отказ одного statfs не отменяет остальные разделы');

  const temperatures = Object.fromEntries(adapter.read().disks.map((disk) =>
    [disk.mountpoint, disk.temperature?.celsius]));

  assert.equal(temperatures[first.mountpoint], 55);
  assert.equal(temperatures[sibling.mountpoint], 55);
  assert.equal(temperatures[second.mountpoint], 35);
  assert.equal(temperatures[dm.mountpoint], 55);
  assert.equal(temperatures[ambiguous.mountpoint], undefined);

  await f.remove('sys/class/hwmon/hwmon19');
  await f.remove('sys/class/hwmon/hwmon3');
  await f.link('sys/class/hwmon/hwmon3',
    'sys/devices/pci0000:00/0000:01:00.0/nvme/nvme0/hwmon/hwmon19');
  await f.link('sys/class/hwmon/hwmon19',
    'sys/devices/pci0000:00/0000:01:00.0/nvme/nvme1/hwmon/hwmon3');
  await f.advance(5000);

  assert.equal(adapter.read().disks.find((disk) => disk.mountpoint === first.mountpoint)
    .temperature.celsius, 55, 'перестановка индексов не переносит температуру другого диска');
  await f.remove('sys/class/hwmon/hwmon3');
  await f.advance(5000);
  assert.equal(adapter.read().disks.find((disk) => disk.mountpoint === first.mountpoint)
    .temperature, undefined);
  assert.equal(adapter.read().disks.find((disk) => disk.mountpoint === second.mountpoint)
    .temperature.celsius, 35);
});
