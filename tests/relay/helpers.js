import { execFile } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { promisify } from 'node:util';

import { buildTestGo, fixtureGo } from '../helpers/goBuildFixture.mts';
import { freePort, startRelay } from './binary/helpers.js';

const execute = promisify(execFile);

/**
 * Выбирает Go-посредника для локальных интеграционных тестов.
 * Подготовленный файл проверяется тем же helper, что кандидаты выпуска.
 */
export function relayBinary() {
  return fixtureGo('grigdesk-relay');
}

/**
 * Проверяет TLS и доказательство установки на Go-процессе.
 * Тестовый запуск принимает только назначенный loopback и синтетическую квитанцию.
 */
export function managedRelayFixture(t, env, host, port, proofFile) {
  return startRelay(t, {
    binary: buildTestGo('managed-fixture', ['test', '-c', '-trimpath'], './utilities/relay/internal/managed'),
    env,
    args: ['-test.run=^TestServeFixture$', '-fixture-address', `${host}:${port}`,
      '-fixture-proof', proofFile],
  });
}

/**
 * Запускает Go с переданным синтетическим relay.env.
 * Закрытие ждёт завершения собственного процесса.
 */
export async function relayFromEnv(t, env) {
  const fixture = await startRelay(t, { binary: relayBinary(), env });

  return {
    port: Number(env.RELAY_PORT),
    output: fixture.output,
    close: async () => {
      fixture.child.kill('SIGTERM');
      await fixture.exited;
    },
  };
}

/**
 * Запускает поставочный Go-файл с синтетическими TLS и токенами.
 * Выбирает свободный порт, на котором затем подключаются тестовые клиенты.
 */
export async function relayFixture(t, cert, overrides = {}) {
  return relayFromEnv(t, relayEnv({
    cert,
    overrides: { ...overrides, RELAY_PORT: String(await freePort()) },
  }));
}

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
    let pending = Buffer.alloc(0);
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
     * Соединяет части до LF и ограничивает размер на случай обрыва протокола.
     * Байты после LF возвращаются следующему чтению.
     */
    function receive(chunk) {
      pending = Buffer.concat([pending, chunk]);

      const end = pending.indexOf(10);

      if (end >= 0 && end <= 8192) {
        finish(null, { line: pending.subarray(0, end).toString(), rest: pending.subarray(end + 1) });
      } else if (pending.length > 8192) {
        finish(new Error('line_too_long'));
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
