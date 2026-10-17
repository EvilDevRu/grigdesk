import tls from 'node:tls';

import { readConfig } from './config.ts';
import { installCrashHandlers } from './crash.ts';
import { createRelayServer } from './relayServer.ts';

/**
 * Пишет только фиксированное событие и безопасные технические поля.
 * Адреса, токены и идентификаторы соединений в журнал не передаются.
 */
function log(ev: string, fields: { port?: number } = {}) {
  process.stdout.write(
    `${JSON.stringify({
      ts: Date.now(),
      ev,
      ...fields,
    })}\n`,
  );
}

/**
 * Запускает рабочую часть с прежним протоколом и ограниченным журналом.
 * Потеря IPC сторожа закрывает принадлежащие процессу соединения.
 */
export async function runRelay(env: Record<string, string | undefined> = process.env): Promise<void> {
  installCrashHandlers(process, {
    log,
    exit: (code) => process.exit(code),
  });

  try {
    const config = readConfig(env);
    const server = createRelayServer(config, { log });
    const port = await server.listen();
    const heartbeat = setInterval(() => {
      if (process.connected) {
        process.send?.({ t: 'heartbeat' });
      }
    }, 1000);
    let stopping = false;

    /**
     * Прекращает приём и закрывает свои соединения при штатной остановке.
     * Внешний supervisor ограничивает ожидание на случай зависшего event loop.
     */
    async function stop() {
      if (stopping) {
        return;
      }

      stopping = true;
      clearInterval(heartbeat);
      await server.close();
      process.exit(0);
    }

    if (process.connected) {
      process.once('disconnect', stop);
    }

    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    log('listening', { port });
  } catch {
    log('configuration_error');
    process.exit(2);
  }
}

/**
 * Проверяет только loopback TLS с общим сроком и единым завершением.
 * Неканоничный порт отклоняется до открытия сети, результат не печатается.
 */
export function checkHealth(portText: string | undefined, timeoutMs = 3000): Promise<0 | 1> {
  if (portText !== undefined && (!/^[1-9][0-9]{0,4}$/.test(portText) || Number(portText) > 65535)) {
    return Promise.resolve(1);
  }

  return new Promise((resolve) => {
    const socket = tls.connect({
      host: '127.0.0.1',
      port: Number(portText ?? 7443),
      rejectUnauthorized: false,
      minVersion: 'TLSv1.3',
    });
    let complete = false;
    let saved = '';

    /**
     * Снимает таймер и закрывает сокет ровно один раз при любом исходе.
     * Поздний close не перезаписывает уже полученный ответ проверки.
     */
    function finish(code: 0 | 1) {
      if (complete) {
        return;
      }

      complete = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(code);
    }

    const timer = setTimeout(() => finish(1), timeoutMs);

    socket.once('secureConnect', () => socket.write('{"v":1,"role":"health"}\n'));
    socket.once('error', () => finish(1));
    socket.once('close', () => finish(1));
    socket.on('data', (chunk: Buffer) => {
      saved += chunk.toString('utf8');

      if (saved.length > 2048) {
        finish(1);

        return;
      }

      if (saved.includes('\n')) {
        try {
          finish(JSON.parse(saved.trim()).ok === true ? 0 : 1);
        } catch {
          finish(1);
        }
      }
    });
  });
}
