import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PhoneEmulator } from '../../tools/mobile-phone/emulator.mts';
import { selfSignedCertificate } from '../../desktop/src/selfSignedCert.ts';
import { localStack } from '../mobile/helpers/local-stack.js';

/**
 * Тестовая личность живёт только в памяти; каталог хранит конфигурацию и очередь.
 * Все созданные экземпляры закрываются до удаления каталога.
 */
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'desktop-link-'));
  const calls = [];
  let pair;
  let failure = false;
  const phones = [];
  const identity = {
    async create(dir, name) {
      calls.push(['create', dir, name]);
      pair = selfSignedCertificate(name);

      return pair;
    },
    async load(dir) {
      calls.push(['load', dir]);

      if (failure) {
        throw new Error('secure_store_unavailable');
      }

      return pair;
    },
  };

  t.after(async () => {
    for (const phone of phones) {
      await phone.close();
    }

    await rm(directory, { recursive: true, force: true });
  });

  return {
    directory,
    calls,
    pair: () => pair,
    fail: (value) => {
      failure = value;
    },
    phone(options = {}) {
      const phone = new PhoneEmulator(directory, {
        identity,
        deviceName: 'Компьютер тест',
        ...options,
      });

      phones.push(phone);

      return phone;
    },
  };
}

test('DC-05/07: прежние часы, defaults и новый срок сохраняют deadline', () => {
  let now = 100;
  const plain = new PhoneEmulator('/tmp/desktop-unused');

  assert.equal(plain.state.deviceName, 'Эмулятор телефона');

  for (const options of [() => now, { monotonic: () => now }, { monotonic: () => now, unlockMs: 1000 }]) {
    const phone = new PhoneEmulator('/tmp/desktop-unused', options);
    const duration = typeof options === 'object' && options.unlockMs ? 1000 : 600000;

    phone.unlock();
    now += duration - 1;
    assert.equal(phone.getState().unlocked, true);
    now += 1;
    assert.equal(phone.getState().unlocked, false);
  }

  for (const unlockMs of [0, -1, 0.5, Infinity]) {
    assert.throws(() => new PhoneEmulator('/tmp/desktop-unused', { unlockMs }));
  }
});

test('DC-06: внедрённая личность проходит pair и перезапуск без смены устройства', async (t) => {
  const stack = await localStack(t);
  const f = await fixture(t);
  const phone = f.phone();

  await phone.addFromText(stack.qr);

  const hello = JSON.parse((await phone.request({ method: 'GET', path: '/api/mobile/v1/hello' })).body);
  const devices = await stack.service.devices.list();
  const fingerprint = new X509Certificate(f.pair().cert).fingerprint256.replaceAll(':', '').toLowerCase();

  assert.equal(hello.device.name, 'Компьютер тест');
  assert.equal(devices.find((device) => device.id === hello.device.id).fp, fingerprint);
  assert.deepEqual(f.calls, [['create', f.directory, 'Компьютер тест']]);
  await phone.close();

  const restored = f.phone();

  await restored.load();
  restored.unlock();

  const again = JSON.parse((await restored.request({ method: 'GET', path: '/api/mobile/v1/hello' })).body);

  assert.equal(again.device.id, hello.device.id);
  assert.deepEqual(f.calls[1], ['load', f.directory]);
});

test('DC-07a: ошибка восстановления не публикует часть состояния и допускает повтор', async (t) => {
  const stack = await localStack(t);
  const f = await fixture(t);
  const first = f.phone();

  await first.addFromText(stack.qr);
  await first.close();

  const restored = f.phone();
  const initial = restored.getState();
  const pairedPath = path.join(f.directory, 'paired.json');
  const paired = await readFile(pairedPath, 'utf8');

  for (const broken of ['identity', 'paired.json', 'outbox.json']) {
    f.fail(broken === 'identity');

    if (broken !== 'identity') {
      await writeFile(path.join(f.directory, broken), '{');
    }

    const expected = broken === 'identity' ? /secure_store_unavailable/ : /store_corrupt/;

    await assert.rejects(restored.load(), expected);
    assert.deepEqual(restored.getState(), initial);
    f.fail(false);
    await writeFile(pairedPath, paired);
    await writeFile(path.join(f.directory, 'outbox.json'), '[]');
  }

  await restored.load();
  assert.equal(restored.getState().deviceId, first.state.deviceId);
  assert.equal(restored.getState().unlocked, false);
  await mkdir(path.join(f.directory, 'media'), { recursive: true });
  await writeFile(path.join(f.directory, 'media', 'test'), 'private');
  await restored.close();
  await assert.rejects(readFile(path.join(f.directory, 'media', 'test')), /ENOENT/);
});
