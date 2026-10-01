// Владелец процесса DSH web на один запуск чата. Авторизационный URL остаётся
// только в памяти: лог процесса может содержать одноразовый токен входа.
import { spawn } from 'node:child_process';
import net from 'node:net';

import type { ChildProcess } from 'node:child_process';

import { DeepSeekWebClient } from './serverClient.ts';

export interface DeepSeekServerProcess {
  client: DeepSeekWebClient;
  stop(): Promise<void>;
}

export interface StartDeepSeekServerOptions {
  bin: string;
  overlayPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  spawnProcess?: typeof spawn;
  signal?: AbortSignal;
}

async function unusedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  let timer: ReturnType<typeof setTimeout>;

  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, 2_000); }),
  ]);

  clearTimeout(timer!);

  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

/**
 * Сервер запускается на собственном loopback-порту без публикации токена в журнале.
 * Таймаут и abort завершают только его дочерний процесс и освобождают probe.
 */
export async function startDeepSeekServer(options: StartDeepSeekServerOptions): Promise<DeepSeekServerProcess> {
  options.signal?.throwIfAborted();

  const port = await unusedPort();
  const child = (options.spawnProcess || spawn)(options.bin, [
    '--profile', 'web', '--patch', options.overlayPath,
    '--host', '127.0.0.1', '--port', String(port), '--no-open',
  ], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let outputBytes = 0;
  let resolved = false;
  let resolveUrl!: (url: string) => void;
  let rejectUrl!: (error: Error) => void;
  const url = new Promise<string>((resolve, reject) => {
    resolveUrl = resolve;
    rejectUrl = reject;
  });
  /**
   * Приватный вывод нужен только для обнаружения URL собственного сервера.
   * Probe ограничивает его размер, а короткий хвост не печатается в каталог.
   */
  const accept = (chunk: Buffer | string) => {
    outputBytes += Buffer.byteLength(chunk);

    if (options.signal && outputBytes > 2_097_152) {
      rejectUrl(new Error('Probe DeepSeek превысил предел вывода'));
      child.kill('SIGTERM');

      return;
    }

    output = `${output}${String(chunk)}`.slice(-32_768);
    const match = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?[^\s]+)/u);
    if (match && !resolved) {
      resolved = true;
      resolveUrl(match[1]!);
    }
  };
  child.stdout?.on('data', accept);
  child.stderr?.on('data', accept);
  child.once('error', (error) => {
    if (!resolved) rejectUrl(error);
  });
  child.once('exit', () => {
    if (!resolved) rejectUrl(new Error('DeepSeek web завершился до запуска'));
  });
  let startupTimer: ReturnType<typeof setTimeout>;
  const abort = () => {
    rejectUrl(new Error('Probe DeepSeek остановлен'));
    void stopChild(child);
  };

  options.signal?.addEventListener('abort', abort, { once: true });

  try {
    const authenticatedUrl = await Promise.race([
      url,
      new Promise<string>((_, reject) => {
        startupTimer = setTimeout(() => reject(new Error('Таймаут запуска DeepSeek web')), 20_000);
      }),
    ]);

    clearTimeout(startupTimer!);

    const client = await DeepSeekWebClient.authenticate(authenticatedUrl, options.signal);

    return { client, stop: async () => {
      options.signal?.removeEventListener('abort', abort);
      await stopChild(child);
    } };
  } catch (error) {
    clearTimeout(startupTimer!);
    options.signal?.removeEventListener('abort', abort);
    await stopChild(child);
    throw error;
  }
}
