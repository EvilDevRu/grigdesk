import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSettings } from '../../desktop/src/settings.ts';
import { Profiles } from '../../desktop/src/profiles.ts';

test('v1 мигрирует в v2 без потери геометрии и с выбранным местным профилем', () => {
  const settings = normalizeSettings({
    version: 1,
    window: {
    width: 902,
    height: 701,
    maximized: true,
  },
    connection: { kind: 'local', origin: 'http://127.0.0.1:12345' },
  });

  assert.equal(settings.version, 2);
  assert.deepEqual(settings.window, {
    width: 902,
    height: 701,
    maximized: true,
  });
  assert.equal(settings.profiles.length, 1);
  assert.equal(settings.profiles[0].name, 'Этот компьютер');
  assert.equal(settings.profiles[0].address, 'http://127.0.0.1:12345');
  assert.equal(settings.selected, settings.profiles[0].id);
});

test('профили разделяют стабильные порты, повтор pin обновляет адрес, занятый порт заменяется', async () => {
  const settings = normalizeSettings(null);
  const busy = new Set([47101]);
  let writes = 0;
  const profiles = new Profiles({
    settings,
    save: async () => {
      writes += 1;
    },
    available: async (port) => !busy.has(port),
  });
  const first = await profiles.add({
    name: 'Машина A',
    kind: 'remote',
    address: 'https://machine-a.test:12345',
    fp: '01'.repeat(32),
  });

  assert.ok(first, 'профиль должен быть создан');
  assert.equal(first.port, 47102);

  const second = await profiles.add({
    name: 'Машина B',
    kind: 'remote',
    address: 'https://machine-b.test:12345',
    fp: '02'.repeat(32),
  });
  const again = await profiles.add({
    name: 'Новое имя',
    kind: 'remote',
    address: 'https://moved.test:12345',
    fp: first.fp,
  });

  assert.equal(again.id, first.id);
  assert.equal(again.port, first.port);
  assert.equal(second.port, 47103);
  assert.equal(settings.profiles.length, 2);
  busy.add(first.port);
  await profiles.claimPort(first.id);
  assert.equal(first.port, 47104);
  assert.equal(writes, 4);
});
