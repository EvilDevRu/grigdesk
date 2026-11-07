import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeSettings } from '../../desktop/src/settings.ts';
import { Profiles } from '../../desktop/src/profiles.ts';

test('PB-B0: прежний local сохраняет id и порт при повторе', async () => {
  const settings = normalizeSettings({
    version: 1,
    connection: { kind: 'local', origin: 'http://127.0.0.1:12345' },
  });
  const profiles = new Profiles({
    settings,
    save: async () => {},
    available: async () => true,
  });
  const local = structuredClone(settings.profiles[0]);
  const remote = await profiles.add({
    kind: 'remote',
    name: 'Удалённая машина',
    address: 'https://remote.test:12345',
    fp: '12'.repeat(32),
  });
  const remoteBefore = structuredClone(remote);
  const repeated = await profiles.add({
    kind: 'local',
    name: 'Прежняя установка',
    address: 'http://127.0.0.1:23456',
    fp: null,
  });

  assert.equal(repeated.id, local.id);
  assert.equal(repeated.port, local.port);
  assert.equal(repeated.address, 'http://127.0.0.1:23456');
  assert.equal(repeated.name, 'Прежняя установка');
  assert.equal(settings.selected, local.id);
  assert.deepEqual(remote, remoteBefore);
  assert.equal(settings.profiles.length, 2);
});

test('PB-LOCAL-01: разные ELF сохраняют отдельные local после нормализации', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-profiles-'));
  const a = path.join(root, 'A/bin/grigdesk-server');
  const b = path.join(root, 'B/bin/grigdesk-server');

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  for (const file of [a, b]) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '\x7fELF-fixture', { mode: 0o755 });
  }

  const settings = normalizeSettings(null);
  const profiles = new Profiles({
    settings,
    save: async () => {},
    available: async () => true,
  });
  const input = {
    kind: 'local',
    name: 'Копия A',
    address: 'http://127.0.0.1:12345',
    fp: null,
  };
  const first = await profiles.add({ ...input, serverBinary: a });
  const second = await profiles.add({
    ...input,
    name: 'Копия B',
    serverBinary: b,
  });

  assert.notEqual(first.id, second.id, 'одинаковый origin не объединяет разные установки');
  assert.notEqual(first.port, second.port);

  const roundtrip = normalizeSettings(JSON.parse(JSON.stringify(settings)));

  assert.deepEqual(roundtrip.profiles, settings.profiles);
  assert.equal(roundtrip.profiles[0].serverBinary, a);
  assert.equal(roundtrip.profiles[1].serverBinary, b);

  const same = await profiles.add({ ...input, serverBinary: b });

  assert.equal(same.id, second.id);
  assert.equal(same.port, second.port);
  assert.equal(settings.profiles.length, 2);
});

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
