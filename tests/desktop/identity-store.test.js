import assert from 'node:assert/strict';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, writeFile, readdir, rm, rename, symlink, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { electronSealer, sealedIdentity } from '../../desktop/src/identity.ts';
import { selfSignedCertificate } from '../../desktop/src/selfSignedCert.ts';

const storage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString: (text) => Buffer.from('sealed:' + Buffer.from(text).toString('base64')),
  decryptString(data) {
    assert.match(data.toString(), /^sealed:/);

    return Buffer.from(data.toString().slice(7), 'base64').toString();
  },
};

/**
 * Для каждого сценария создаётся собственный каталог, имитирующий link в userData.
 * Подделка шифрования позволяет проверить формат без запуска Electron и связки ключей.
 */
async function fixture(t, backend = storage) {
  const directory = await mkdtemp(path.join(tmpdir(), 'desktop-identity-'));

  t.after(() => rm(directory, { recursive: true, force: true }));

  return { directory, identity: sealedIdentity(electronSealer(backend, 'linux')) };
}

test('DC-08/09: ключ записан зашифрованным, перезапуск возвращает прежнюю пару', async (t) => {
  const { directory, identity } = await fixture(t);
  const pair = await identity.create(directory, 'Компьютер тест');
  const files = await readdir(directory);

  assert.deepEqual(files.sort(), ['device-cert.pem', 'device-key.sealed']);
  assert.doesNotMatch((await readFile(path.join(directory, 'device-key.sealed'))).toString(), /PRIVATE KEY/);
  assert.match(await readFile(path.join(directory, 'device-cert.pem'), 'utf8'), /BEGIN CERTIFICATE/);
  assert.equal(new X509Certificate(pair.cert).checkPrivateKey(createPrivateKey(pair.key)), true);
  assert.deepEqual(await sealedIdentity(electronSealer(storage, 'linux')).load(directory), pair);

  if (process.platform !== 'win32') {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);

    for (const file of files) {
      assert.equal((await stat(path.join(directory, file))).mode & 0o777, 0o600);
    }
  }
});

test('DC-10/11/13b: недоступные backend отказывают до записи, Windows не спрашивает backend', async (t) => {
  for (const backend of [
    { ...storage, isEncryptionAvailable: () => false },
    { ...storage, getSelectedStorageBackend: () => 'basic_text' },
    { ...storage, getSelectedStorageBackend: () => 'unknown' },
    { ...storage, getSelectedStorageBackend: undefined },
    { ...storage, getSelectedStorageBackend: () => {
      throw new Error('нет сервиса');
    } },
  ]) {
    const { directory, identity } = await fixture(t, backend);

    await assert.rejects(identity.create(directory, 'Компьютер тест'), /secure_store_unavailable/);
    await assert.rejects(identity.load(directory), /secure_store_unavailable/);
    assert.deepEqual(await readdir(directory), []);
  }

  const win = electronSealer({
    ...storage,
    getSelectedStorageBackend: () => {
      throw new Error('Windows не должен спрашивать');
    },
  }, 'win32');

  assert.equal(win.available(), true);

  for (const backend of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']) {
    const sealer = electronSealer({ ...storage, getSelectedStorageBackend: () => backend }, 'linux');

    assert.equal(sealer.available(), true);
  }
});

test('DC-12/13b: повреждения, размер и каталог вместо файла отвергаются', async (t) => {
  for (const damage of ['key', 'cert', 'size', 'directory']) {
    const { directory, identity } = await fixture(t);

    await identity.create(directory, 'Компьютер тест');

    const file = path.join(directory, 'device-key.sealed');

    if (damage === 'directory') {
      await rm(file);
      await mkdir(file);
    } else if (damage === 'cert') {
      await writeFile(path.join(directory, 'device-cert.pem'), selfSignedCertificate('Чужой').cert);
    } else {
      await writeFile(file, damage === 'size' ? Buffer.alloc(16385) : 'мусор');
    }

    await assert.rejects(identity.load(directory), /store_corrupt/);
    await assert.rejects(identity.create(directory, 'Новое имя'), /store_corrupt/);
  }
});

test('DC-13: ссылка вместо ключа отвергается', { skip: process.platform === 'win32' }, async (t) => {
  const { directory, identity } = await fixture(t);

  await identity.create(directory, 'Компьютер тест');

  const file = path.join(directory, 'device-key.sealed');

  await rename(file, file + '.saved');
  await symlink(file + '.saved', file);
  await assert.rejects(identity.load(directory), /store_corrupt/);
});

test('DC-13a: потеря ACK переиспользует пару, неполная запись и остатки требуют сброса', async (t) => {
  const { directory, identity } = await fixture(t);
  const first = await identity.create(directory, 'Компьютер тест');

  assert.deepEqual(await identity.create(directory, 'Другое имя'), first);
  await rm(path.join(directory, 'device-cert.pem'));

  const sealed = await readFile(path.join(directory, 'device-key.sealed'));

  await assert.rejects(identity.create(directory, 'Другое имя'), /store_corrupt/);
  assert.deepEqual(await readFile(path.join(directory, 'device-key.sealed')), sealed);

  const second = await fixture(t);

  await writeFile(path.join(second.directory, 'device-key.sealed.crashed.tmp'), 'остаток');
  await assert.rejects(second.identity.create(second.directory, 'Компьютер тест'), /store_corrupt/);
});

test('DC-13a: отказ шифрования не оставляет ключ или временные файлы', async (t) => {
  const { directory, identity } = await fixture(t, {
    ...storage,
    encryptString: () => {
      throw new Error('ошибка шифрования');
    },
  });

  await assert.rejects(identity.create(directory, 'Компьютер тест'));
  assert.deepEqual(await readdir(directory), []);
});
