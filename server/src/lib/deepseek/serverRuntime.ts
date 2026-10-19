// Владелец процесса DSH web на один запуск чата. Авторизационный URL остаётся
// только в памяти: лог процесса может содержать одноразовый токен входа.
import { spawn } from 'node:child_process';
import net from 'node:net';

import type { ChildProcess, SpawnOptions } from 'node:child_process';

import { DeepSeekWebClient } from './serverClient.ts';
import type { DeepSeekRuntimeDescriptor } from './runtimeProcess.ts';
import { verifyDeepSeekRuntimeDescriptorAsync } from './runtimeProcess.ts';
import { spawnDeepSeekBinary } from './binaryProcess.ts';

export interface DeepSeekServerProcess {
  client: DeepSeekWebClient;
  stop(): Promise<void>;
}

export interface StartDeepSeekServerOptions {
  bin: string;
  runtime?: DeepSeekRuntimeDescriptor;
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

/**
 * Ждёт выхода процесса не дольше заданного; таймер снимается в любом исходе.
 * Возвращает, вышел ли процесс за это время.
 */
async function exited(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }

  let timer: ReturnType<typeof setTimeout>;

  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);

  clearTimeout(timer!);

  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * SIGTERM, ограниченное ожидание, затем SIGKILL — только своему процессу. После SIGKILL
 * остановка тоже ждёт выхода, иначе порт и файлы запуска освобождались бы позже возврата.
 */
async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');

  if (!await exited(child, 2_000)) {
    child.kill('SIGKILL');
    await exited(child, 2_000);
  }
}

/**
 * Сервер запускается на собственном loopback-порту без публикации токена в журнале.
 * Таймаут и abort завершают только его дочерний процесс и освобождают probe.
 */
export async function startDeepSeekServer(options: StartDeepSeekServerOptions): Promise<DeepSeekServerProcess> {
  options.signal?.throwIfAborted();

  const port = await unusedPort();

  if (options.runtime) {
    await verifyDeepSeekRuntimeDescriptorAsync(options.runtime);
    options.signal?.throwIfAborted();
  }

  const command = options.runtime?.command || options.bin;
  const args = [
    ...(options.runtime?.prefixArgs || []),
    '--profile', 'web', '--patch', options.overlayPath,
    '--host', '127.0.0.1', '--port', String(port), '--no-open',
  ];
  const spawnOptions: SpawnOptions = {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  const spawnProcess = options.spawnProcess || spawn;
  const owned = options.runtime?.kind === 'binary'
    ? spawnDeepSeekBinary(command, args, spawnOptions, spawnProcess) : null;
  const child = owned?.child ?? spawnProcess(command, args, spawnOptions);
  const stop = () => owned ? owned.stop() : stopChild(child);
  let output = '';
  let outputBytes = 0;
  let resolved = false;
  let resolveUrl!: (url: string) => void;
  let rejectUrl!: (error: Error) => void;
  const startupAbort = new AbortController();
  const startupSignal = options.signal
    ? AbortSignal.any([options.signal, startupAbort.signal]) : startupAbort.signal;
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
      void stop().catch(() => {});

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
  // URL ещё не означает готовность: child может завершиться во время cookie-auth.
  // Его отказ должен прервать и ожидание URL, и уже начавшийся HTTP-запрос.
  const startupFailed = (error: Error) => {
    startupAbort.abort(error);
    rejectUrl(error);
  };
  const startupExited = () => startupFailed(new Error('DeepSeek web завершился до запуска'));

  child.once('error', startupFailed);
  child.once('exit', startupExited);

  if (child.exitCode !== null || child.signalCode !== null) {
    startupExited();
  }

  let startupTimer: ReturnType<typeof setTimeout>;
  const abort = () => {
    rejectUrl(new Error('Probe DeepSeek остановлен'));
    void stop().catch(() => {});
  };

  options.signal?.addEventListener('abort', abort, { once: true });

  if (options.signal?.aborted) {
    abort();
  }

  try {
    const authenticatedUrl = await Promise.race([
      url,
      new Promise<string>((_, reject) => {
        startupTimer = setTimeout(() => reject(new Error('Таймаут запуска DeepSeek web')), 20_000);
      }),
    ]);

    clearTimeout(startupTimer!);

    const client = await DeepSeekWebClient.authenticate(authenticatedUrl, startupSignal);

    // После startup отменой хода владеет session/cancel; процесс освобождается в finally.
    // Metadata-запросы передают свой signal в RPC и также закрываются единственным owner.
    options.signal?.removeEventListener('abort', abort);
    child.off('error', startupFailed);
    child.off('exit', startupExited);
    child.stdout?.off('data', accept);
    child.stderr?.off('data', accept);
    child.stdout?.resume();
    child.stderr?.resume();

    return { client, stop: async () => {
      options.signal?.removeEventListener('abort', abort);
      await stop();
    } };
  } catch (error) {
    clearTimeout(startupTimer!);
    options.signal?.removeEventListener('abort', abort);
    child.off('error', startupFailed);
    child.off('exit', startupExited);
    await stop();
    throw error;
  }
}
