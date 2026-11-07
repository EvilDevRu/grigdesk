import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import path from 'node:path';
import { finished } from 'node:stream/promises';

const loaderInputs = new Set([
  'NODE_OPTIONS', 'NODE_PATH', 'NODE_REPL_EXTERNAL_MODULE', 'NODE_COMPILE_CACHE',
  'NODE_V8_COVERAGE', 'NODE_REDIRECT_WARNINGS', 'OPENSSL_CONF', 'OPENSSL_MODULES',
]);

export interface WorkerOptions {
  root: string;
  binary: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  capture?: boolean;
  externalParent?: boolean;
  parentAlive?: () => boolean;
  stopGraceMs?: number;
  onSpawn?: (child: ChildProcess) => Promise<void>;
  onMessage?: (message: unknown) => void;
}

/**
 * Ordinary Node не наследует loader inputs SEA, но получает ранний extra CA.
 * Пустое coverage подавляет специальный fallback child_process из окружения родителя.
 */
export function workerEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => !loaderInputs.has(key)));

  env.NODE_V8_COVERAGE = '';

  return env;
}

/**
 * Launcher владеет только своим worker, ожидая подтверждённого close перед release lease.
 * Внутренний IPC обнаруживает SIGKILL launcher; эскалация не убивает отвязанную фабрику.
 */
export async function runLauncherWorker(options: WorkerOptions) {
  const externalParent = options.externalParent ?? typeof process.send === 'function';
  const parentAlive = options.parentAlive ?? (() => !externalParent || process.connected === true);
  const grace = options.stopGraceMs ?? 45000;

  if (grace < 45000) {
    throw new Error('Бюджет остановки worker должен быть не меньше 45000 мс');
  }

  if (!parentAlive()) {
    return {
      code: 0,
      stdout: '',
      stderr: '',
    };
  }

  const stdio: StdioOptions = options.capture
    ? ['inherit', 'pipe', 'pipe', 'ipc']
    : ['inherit', 'inherit', 'inherit', 'ipc'];
  const child = spawn(path.join(options.root, 'runtime/node/bin/node'), [
    path.join(options.root, 'server/worker-bootstrap.cjs'),
    path.join(options.root, 'server/payload.cjs'),
    options.binary,
  ], {
    stdio,
    cwd: options.cwd,
    env: workerEnvironment(options.env),
  });
  let stdout = '';
  let stderr = '';
  let stopping = false;
  let escalated = false;
  let overflow = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const completion = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  const spawned = new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  const drained = Promise.all([child.stdout, child.stderr].map((stream) => stream
    ? finished(stream) : Promise.resolve()));

  void completion.catch(() => {});
  void drained.catch(() => {});

  /**
   * Только первый stop передаётся worker; повторные сигналы не дублируют shutdown.
   * Deadline относится к собственному PID, а не группе detached процессов фабрики.
   */
  const stop = (signal?: NodeJS.Signals) => {
    if (stopping) {
      return;
    }

    stopping = true;

    if (signal) {
      child.kill(signal);
    } else if (child.connected) {
      child.disconnect();
    }

    timer = setTimeout(() => {
      escalated = true;
      child.kill('SIGKILL');
    }, grace);
  };
  const term = () => stop('SIGTERM');
  const interrupt = () => stop('SIGINT');
  const disconnect = () => stop();

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (value: string) => {
    if (Buffer.byteLength(stdout) + Buffer.byteLength(value) > 65536) {
      overflow = true;
      term();
    } else {
      stdout += value;
    }
  });
  child.stderr?.on('data', (value: string) => {
    if (Buffer.byteLength(stderr) + Buffer.byteLength(value) > 65536) {
      overflow = true;
      term();
    } else {
      stderr += value;
    }
  });
  child.on('message', (message) => {
    options.onMessage?.(message);

    if (externalParent && process.connected && process.send) {
      process.send(message, () => {});
    }
  });
  process.once('SIGTERM', term);
  process.once('SIGINT', interrupt);

  if (externalParent) {
    process.once('disconnect', disconnect);
  }

  try {
    await spawned;
    await options.onSpawn?.(child);

    if (!parentAlive()) {
      disconnect();
    }

    if (!stopping && child.connected) {
      child.send({ type: 'grigdesk:worker-start' }, (error) => {
        if (error) {
          term();
        }
      });
    }

    const code = await completion;

    await drained;

    return {
      code: escalated || overflow ? 1 : code ?? 1,
      stdout,
      stderr,
    };
  } catch (error) {
    term();
    await completion.catch(() => {});

    throw error;
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGTERM', term);
    process.removeListener('SIGINT', interrupt);
    process.removeListener('disconnect', disconnect);

    if (externalParent) {
      process.channel?.unref();
    }
  }
}
