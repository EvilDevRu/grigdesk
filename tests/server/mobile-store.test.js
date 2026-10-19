import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { DeviceStore, RelayStore } from '../../server/src/lib/mobile/store.ts';
import { PairingCodes } from '../../server/src/lib/mobile/pairing.ts';
import { temporary } from '../relay/helpers.js';

test('MB-05…MB-07: конкурентные привязки, отзыв и повреждённый JSON', async (t) => {
  const directory = await temporary(t);
  const devices = new DeviceStore(directory);
  const fp = 'a'.repeat(64);
  const [first, second] = await Promise.all([
    devices.add({
      name: 'Телефон',
      fp,
    }),
    devices.add({
      name: 'Телефон',
      fp,
    }),
  ]);

  assert.equal(first.id, second.id);
  assert.equal((await devices.list()).length, 1);
  await devices.revoke(first.id);
  assert.equal((await devices.findByFp(fp)).revokedAt !== null, true);
  await assert.rejects(() =>
    devices.add({
      name: 'Телефон',
      fp,
    }),
  );

  const relays = new RelayStore(directory);
  const relay = await relays.add({
    name: 'Дом',
    host: '127.0.0.1',
    port: 7443,
  });

  assert.equal((await relays.list()).length, 1);
  await relays.remove(relay.id);
  assert.equal((await relays.list()).length, 0);
  await assert.rejects(() =>
    relays.add({
      name: 'Дом',
      host: 'https://x',
      port: 0,
    }),
  );

  const file = path.join(directory, 'devices.json');

  await writeFile(file, '{bad');
  await assert.rejects(
    () => devices.list(),
    (error) => error.code === 'mobile_store_corrupt',
  );
  assert.equal(await readFile(file, 'utf8'), '{bad');
});

test('MB-08: потерянный ответ pair, конкуренция, exp и изолированный лимит попыток', async (t) => {
  let now = 1;
  const directory = await temporary(t);
  const devices = new DeviceStore(directory);
  const pairing = new PairingCodes({
    devices,
    now: () => now,
  });
  const issued = pairing.issue();
  const fp = 'a'.repeat(64);
  const [first, second] = await Promise.all([
    pairing.pair(issued.code, fp, 'Телефон'),
    pairing.pair(issued.code, fp, 'Телефон'),
  ]);

  assert.equal(first.id, second.id);
  await assert.rejects(() => pairing.pair(issued.code, 'b'.repeat(64), 'Другой'));

  const another = pairing.issue();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(() => pairing.pair('invalid', 'c'.repeat(64), 'Чужой'));
  }

  await assert.rejects(
    () => pairing.pair(another.code, 'c'.repeat(64), 'Чужой'),
    (error) => error.code === 'pair_locked',
  );
  assert.equal((await pairing.pair(another.code, 'd'.repeat(64), 'Ещё')).name, 'Ещё');
  now = issued.exp + 1;
  await assert.rejects(() => pairing.pair(issued.code, fp, 'Телефон'));
});

test('S1: перебор ограничен IP независимо от сертификата и не запирает весь вход', async (t) => {
  const devices = new DeviceStore(await temporary(t));
  const pairing = new PairingCodes({ devices });

  for (let index = 0; index < 5; index += 1) {
    await assert.rejects(pairing.pair('invalid', index.toString(16).padStart(64, '0'),
      'Чужой', 'client', '192.0.2.1'));
  }

  const issued = pairing.issue({ scope: 'client', name: 'Фикстура' });

  await assert.rejects(pairing.pair(issued.code, 'a'.repeat(64), 'Чужой', 'client', '192.0.2.1'),
    (error) => error.code === 'pair_locked');
  assert.equal((await pairing.pair(issued.code, 'b'.repeat(64), 'Фикстура', 'client', '192.0.2.2'))
    .scope, 'client');
});

test('S1: заполнение таблицы не блокирует привязку с другого IP', async (t) => {
  const devices = new DeviceStore(await temporary(t));
  const pairing = new PairingCodes({ devices });

  for (let index = 0; index < 4096; index += 1) {
    await assert.rejects(pairing.pair('invalid', index.toString(16).padStart(64, '0'),
      'Чужой', 'client', `fixture-${index}`));
  }

  const issued = pairing.issue({ scope: 'client', name: 'Фикстура' });

  assert.equal((await pairing.pair(issued.code, 'f'.repeat(64), 'Фикстура', 'client', '192.0.2.2'))
    .scope, 'client');
});

test('S3: другой scope возвращает409 и сохраняет код для подходящего сертификата', async (t) => {
  const devices = new DeviceStore(await temporary(t));
  const pairing = new PairingCodes({ devices });
  const fp = 'a'.repeat(64);

  await devices.add({
    name: 'Прежнее приложение',
    fp,
    scope: 'mobile-v1'
  });

  const issued = pairing.issue({ name: 'Полное приложение', scope: 'client' });

  await assert.rejects(pairing.pair(issued.code, fp, 'Полное приложение', 'client'),
    (error) => error.status === 409 && error.code === 'device_scope_conflict');
  assert.equal((await pairing.pair(issued.code, 'b'.repeat(64), 'Полное приложение', 'client')).scope,
    'client');
});
