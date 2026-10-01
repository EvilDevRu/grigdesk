// Runtime сервера Kimi: поднять `kimi web`, дождаться токена и погасить процесс.
//
// ACP-процесс живёт ровно на ход, а серверу нужен свой жизненный цикл: он слушает порт,
// печатает токен в KIMI_CODE_HOME/server.token и обслуживает REST/WS. Модуль владеет только
// процессом и готовностью; канал уточнений и события — у клиента и потока событий.
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { KimiServerClient } from './serverClient.ts';

const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;
const LOG_TAIL_LIMIT = 4000;
const STOP_GRACE_MS = 3000;

export interface KimiServerLog {
  info?: (fields: Record<string, unknown>, message: string) => void;
  warn?: (fields: Record<string, unknown>, message: string) => void;
}

export interface KimiServerProcess {
  baseUrl: string;
  token: string;
  client: KimiServerClient;
  pid: number | null;
  stop(): Promise<void>;
  logTail(): string;
}

export interface StartKimiServerOptions {
  bin: string;
  home: string;
  cwd?: string;
  port?: number;
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  log?: KimiServerLog | null;
  launch?: {
    command: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
  };
  socketPath?: string;
  signal?: AbortSignal;
}

/**
 * Contained-сервер слушает только свой network namespace. Короткий loopback relay
 * переправляет HTTP и WebSocket в единственный Unix socket, смонтированный в sandbox.
 */
async function openSocketRelay(port: number, socketPath: string): Promise<{
  close(): Promise<void>;
}> {
  const connections = new Set<net.Socket>();
  const relay = net.createServer((outside) => {
    const inside = net.createConnection(socketPath);

    connections.add(outside);
    connections.add(inside);
    outside.on('close', () => connections.delete(outside));
    inside.on('close', () => connections.delete(inside));
    outside.on('error', () => inside.destroy());
    inside.on('error', () => outside.destroy());
    outside.pipe(inside);
    inside.pipe(outside);
  });

  await new Promise<void>((resolve, reject) => {
    relay.once('error', reject);
    relay.listen(port, '127.0.0.1', () => resolve());
  });

  return {
    async close() {
      for (const connection of connections) {
        connection.destroy();
      }

      await new Promise<void>((resolve) => relay.close(() => resolve()));
    },
  };
}

/**
 * Свободный порт на loopback: сервер не должен занимать чужой и не светиться наружу.
 * Порт выбирается до запуска процесса, потому что сервер обязан слушать ровно его.
 */
export async function freeLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = net.createServer();

    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = address && typeof address === 'object' ? address.port : 0;

      probe.close(() => (port ? resolve(port) : reject(new Error('не удалось выбрать порт'))));
    });
  });
}

/**
 * Запуск сервера и ожидание готовности. Готовность — это не «процесс жив», а «есть токен и
 * `/api/v1/meta` отвечает»: иначе первый же prompt ушёл бы в никуда.
 */
export async function startKimiServer({
  bin,
  home,
  cwd,
  port,
  env,
  startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
  log = null,
  launch,
  socketPath,
  signal,
}: StartKimiServerOptions): Promise<KimiServerProcess> {
  signal?.throwIfAborted();

  const listenPort = port || await freeLoopbackPort();
  const tokenFile = path.join(home, 'server.token');
  let tail = '';
  let exited = false;
  let exitReason = '';

  await fs.mkdir(home, { recursive: true });

  const relay = socketPath ? await openSocketRelay(listenPort, socketPath) : null;

  const normalArgs = [
    'web',
    '--port', String(listenPort),
    '--host', '127.0.0.1',
    '--no-open',
  ];
  const child = spawn(launch?.command || bin, launch?.args || normalArgs, {
    cwd: launch?.cwd || cwd || home,
    env: launch?.env || { ...(env || process.env), KIMI_CODE_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const abort = () => child.kill('SIGKILL');

  signal?.addEventListener('abort', abort, { once: true });
  child.once('error', () => {
    exited = true;
    exitReason = 'ошибка запуска';
  });

  const remember = (chunk: unknown) => {
    tail = `${tail}${String(chunk)}`.slice(-LOG_TAIL_LIMIT);
  };

  child.stdout?.on('data', remember);
  child.stderr?.on('data', remember);
  child.on('exit', (code, signal) => {
    exited = true;
    exitReason = signal ? `сигнал ${signal}` : `код ${code ?? '?'}`;
  });

  const baseUrl = `http://127.0.0.1:${listenPort}`;
  const deadline = Date.now() + Math.max(1000, startupTimeoutMs);
  let token = '';

  while (Date.now() < deadline) {
    if (exited) {
      signal?.removeEventListener('abort', abort);
      await relay?.close();

      throw new Error(`Kimi server завершился, не поднявшись (${exitReason}): ${tail.trim().slice(-600)}`);
    }

    try {
      token = (await fs.readFile(tokenFile, 'utf8')).trim();
    } catch {
      token = '';
    }

    if (token) {
      const client = new KimiServerClient({ baseUrl, token });

      try {
        await client.meta();
        log?.info?.({ port: listenPort, pid: child.pid }, 'чат: сервер Kimi поднят');

        return {
          baseUrl,
          token,
          client,
          pid: child.pid ?? null,
          logTail: () => tail,
          /**
           * Погасить сервер: сначала SIGTERM с коротким окном на закрытие сессий, затем
           * SIGKILL. Уже завершённый процесс — не ошибка: остановка идемпотентна.
           */
          async stop() {
            signal?.removeEventListener('abort', abort);

            if (exited) {
              await relay?.close();

              return;
            }

            child.kill('SIGTERM');
            await new Promise<void>((resolve) => {
              const timer = setTimeout(() => {
                if (!exited) {
                  child.kill('SIGKILL');
                }

                resolve();
              }, STOP_GRACE_MS);

              child.once('exit', () => {
                clearTimeout(timer);
                resolve();
              });
            });
            await relay?.close();
            log?.info?.({ port: listenPort }, 'чат: сервер Kimi остановлен');
          },
        };
      } catch {
        // Сервер уже слушает, но мета ещё не готова — это нормальные первые доли секунды.
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  child.kill('SIGKILL');
  signal?.removeEventListener('abort', abort);
  await relay?.close();

  throw new Error(`Kimi server не поднялся за ${startupTimeoutMs} мс: ${tail.trim().slice(-600)}`);
}
