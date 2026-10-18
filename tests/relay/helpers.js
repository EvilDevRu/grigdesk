import { execFile } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { promisify } from 'node:util';

import { createLineReader } from '../../relay/src/protocol.ts';

const execute = promisify(execFile);

/**
 * Выдаёт каждому тесту собственный каталог с синтетическими ключами.
 * Очистка не затрагивает состояние живого сервера.
 */
export async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'grigdesk-relay-test-'));

  t.after(() =>
    rm(directory, {
      recursive: true,
      force: true,
    }),
  );

  return directory;
}

/**
 * Выпускает тестовый сертификат отдельным OpenSSL без секретов в выводе.
 * Возвращает пин именно DER-сертификата, как в транспортном контракте.
 */
export async function makeCert(directory, cn) {
  const keyFile = path.join(directory, `${cn}-key.pem`);
  const certFile = path.join(directory, `${cn}-cert.pem`);

  await execute('openssl', [
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:prime256v1',
    '-nodes',
    '-days',
    '30',
    '-subj',
    `/CN=${cn}`,
    '-keyout',
    keyFile,
    '-out',
    certFile,
  ]);

  const keyPem = await readFile(keyFile, 'utf8');
  const certPem = await readFile(certFile, 'utf8');
  const fp = new X509Certificate(certPem).fingerprint256.replaceAll(':', '').toLowerCase();

  return {
    keyPem,
    certPem,
    fp,
  };
}

/**
 * Собирает окружение только из синтетических сертификатов и токенов.
 * Переопределения задают короткие таймауты изолированных тестов.
 */
export function relayEnv({
  cert,
  brainToken = 'brain-token',
  deviceToken = 'device-token',
  overrides = {},
}) {
  const hash = (value) => createHash('sha256').update(value).digest('hex');

  return {
    RELAY_TLS_KEY_B64: Buffer.from(cert.keyPem).toString('base64'),
    RELAY_TLS_CERT_B64: Buffer.from(cert.certPem).toString('base64'),
    RELAY_BRAIN_TOKEN_SHA256: hash(brainToken),
    RELAY_DEVICE_TOKEN_SHA256: hash(deviceToken),
    ...overrides,
  };
}

/**
 * Подключается с проверкой пина до отправки прикладных байтов.
 * Самоподписанный сертификат не проверяется через системное хранилище CA.
 */
export function connect(port, fp) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: '127.0.0.1',
      port,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.3',
    });

    socket.on('error', reject);
    socket.once('secureConnect', () => {
      const actual = socket
        .getPeerX509Certificate()
        .fingerprint256.replaceAll(':', '')
        .toLowerCase();

      if (actual !== fp) {
        socket.destroy();
        reject(new Error('pin_mismatch'));

        return;
      }

      socket.pause();
      resolve(socket);
    });
  });
}

/**
 * Читает ровно одну строку, сохраняя coalesced-хвост для следующего потребителя.
 * После чтения сокет остаётся приостановлен, чтобы данные не исчезли без слушателя.
 */
export function readLine(socket, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const reader = createLineReader();
    const timer = setTimeout(() => finish(new Error('line_timeout')), timeoutMs);

    /**
     * Завершение снимает все listeners и останавливает socket до передачи хвоста.
     * Следующий consumer получает остаток после установки собственного reader.
     */
    function finish(error, result) {
      clearTimeout(timer);
      socket.pause();
      socket.off('data', receive);
      socket.off('close', closed);

      if (error) {
        reject(error);
      } else {
        if (result.rest.length) {
          socket.unshift(result.rest);
        }

        resolve(result.line);
      }
    }

    function closed() {
      finish(new Error('socket_closed'));
    }

    /**
     * Дроблёная строка проходит тот же bounded decoder, что рабочий протокол.
     * Ошибка parser завершает ожидание с обязательной очисткой listeners.
     */
    function receive(chunk) {
      try {
        const result = reader.push(chunk);

        if (result) {
          finish(null, result);
        }
      } catch (error) {
        finish(error);
      }
    }

    socket.on('data', receive);
    socket.once('close', closed);
    socket.resume();
  });
}

/**
 * Reader устанавливается до записи hello, поэтому быстрый ACK не теряется.
 * Тест передаёт сокет дальше после разбора полной первой строки.
 */
export async function hello(socket, value) {
  const result = readLine(socket);

  socket.write(`${JSON.stringify(value)}\n`);

  return JSON.parse(await result);
}
