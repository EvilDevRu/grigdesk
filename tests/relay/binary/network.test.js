import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';

import { connect, hello, makeCert, readLine, relayEnv, temporary } from '../helpers.js';
import { copyBinary, freePort, startRelay } from './helpers.js';

const execute = promisify(execFile);
let binary;
let removeBinary;

after(() => removeBinary?.());
before(async () => {
  binary = await copyBinary({ after: (cleanup) => {
    removeBinary = cleanup;
  } });
});

/**
 * Запускает готовый файл только с синтетическими ключами и свободным портом.
 * Возвращает настройки для проверки отсутствия секретов в полном журнале.
 */
async function fixture(t, certificate) {
  const cert = certificate ?? await makeCert(await temporary(t), 'sea-network');
  const port = await freePort();
  const env = relayEnv({
    cert,
    overrides: { RELAY_PORT: String(port) },
  });
  const relay = await startRelay(t, {
    binary,
    env,
  });

  return {
    ...relay,
    cert,
    port,
    env,
  };
}

/**
 * Принадлежащий тесту сокет всегда закрывается, даже после неудачного assertion.
 * Пин проверяется до передачи каких-либо прикладных байтов.
 */
async function socketFor(t, box) {
  const socket = await connect(box.port, box.cert.fp);

  t.after(() => socket.destroy());

  return socket;
}

/**
 * Собирает ровно один буфер туннеля без предположений о границах TLS-чанков.
 * Ограничение времени и снятие listeners не оставляют зависших проверок.
 */
function receiveBytes(socket, length) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => finish(new Error('таймаут байтов туннеля')), 3000);

    /**
     * Снимает свои обработчики до передачи результата следующей проверке.
     * Socket снова приостановлен, чтобы не терять последующие данные.
     */
    function finish(error) {
      clearTimeout(timer);
      socket.off('data', receive);
      socket.off('close', closed);
      socket.pause();

      if (error) {
        reject(error);
      } else {
        resolve(Buffer.concat(chunks));
      }
    }

    function closed() {
      finish(new Error('туннель закрыт до получения буфера'));
    }

    function receive(chunk) {
      chunks.push(chunk);
      size += chunk.length;

      if (size >= length) {
        finish();
      }
    }

    socket.on('data', receive);
    socket.once('close', closed);
    socket.resume();
  });
}

test('RS-05: запуск и health готового файла', async (t) => {
  const box = await fixture(t);
  const result = await execute(binary, ['--healthcheck'], {
    cwd: path.dirname(binary),
    env: {
      PATH: '',
      RELAY_PORT: String(box.port),
    },
    timeout: 5000,
  });

  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('RS-06: пара ролей и двусторонние байты, id одноразовый', async (t) => {
  const box = await fixture(t);
  const control = await socketFor(t, box);

  assert.deepEqual(await hello(control, {
    v: 1,
    role: 'brain-control',
    token: 'brain-token',
  }), { ok: true });

  const incoming = readLine(control);
  const device = await socketFor(t, box);
  const deviceReply = hello(device, {
    v: 1,
    role: 'device',
    token: 'device-token',
  });
  const { id } = JSON.parse(await incoming);
  const brain = await socketFor(t, box);

  assert.deepEqual(await hello(brain, {
    v: 1,
    role: 'brain-data',
    token: 'brain-token',
    id,
  }), { ok: true });
  assert.deepEqual(await deviceReply, { ok: true });

  const toBrain = Buffer.alloc(65536, 123);
  const toDevice = Buffer.alloc(65536, 47);
  const brainBytes = receiveBytes(brain, toBrain.length);

  device.write(toBrain);
  assert.deepEqual(await brainBytes, toBrain);

  const deviceBytes = receiveBytes(device, toDevice.length);

  brain.write(toDevice);
  assert.deepEqual(await deviceBytes, toDevice);

  const duplicate = await socketFor(t, box);

  assert.deepEqual(await hello(duplicate, {
    v: 1,
    role: 'brain-data',
    token: 'brain-token',
    id,
  }), {
    ok: false,
    error: 'unknown_id',
  });

  const closed = once(brain, 'close', { signal: AbortSignal.timeout(3000) });

  brain.resume();
  device.destroy();
  await closed;
});

test('RS-07: отказы и полный журнал без секретов', async (t) => {
  const box = await fixture(t);

  for (const [token, error] of [['неверный-токен', 'unauthorized'], ['device-token', 'brain_offline']]) {
    const socket = await socketFor(t, box);

    assert.deepEqual(await hello(socket, {
      v: 1,
      role: 'device',
      token,
    }), {
      ok: false,
      error,
    });
    socket.destroy();
  }

  box.child.kill('SIGTERM');
  assert.equal((await box.exited).code, 0);

  const log = `${box.output.stdout}${box.output.stderr}`;

  assert.ok(log.includes('listening'));

  for (const value of [
    'brain-token', 'device-token', 'неверный-токен',
    box.env.RELAY_BRAIN_TOKEN_SHA256, box.env.RELAY_DEVICE_TOKEN_SHA256,
    box.env.RELAY_TLS_KEY_B64, box.env.RELAY_TLS_CERT_B64,
    box.cert.keyPem, box.cert.certPem, 'BEGIN PRIVATE KEY', 'BEGIN CERTIFICATE',
  ]) {
    assert.equal(log.includes(value), false);
  }
});

test('RS-08: настройки сертификата читаются при каждом запуске', async (t) => {
  const directory = await temporary(t);
  const certificates = [await makeCert(directory, 'first'), await makeCert(directory, 'second')];

  for (const [index, cert] of certificates.entries()) {
    await t.test(`сертификат ${index + 1}`, async (t) => {
      const box = await fixture(t, cert);
      const socket = await socketFor(t, box);

      assert.deepEqual(await hello(socket, {
        v: 1,
        role: 'health',
      }), { ok: true });
      await assert.rejects(() => connect(box.port, certificates[1 - index].fp), /pin_mismatch/);
    });
  }
});
