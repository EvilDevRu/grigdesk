import { spawn, type StdioOptions } from 'node:child_process';
import path from 'node:path';

const nodeInputs = new Set([
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_EXTRA_CA_CERTS',
  'NODE_REPL_EXTERNAL_MODULE',
  'NODE_COMPILE_CACHE',
  'NODE_V8_COVERAGE',
  'NODE_REDIRECT_WARNINGS',
  'OPENSSL_CONF',
  'OPENSSL_MODULES',
]);

export interface WorkerResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface WorkerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * Node loader inputs не переходят из окружения SEA в обычный Node worker.
 * Остальные runtime inputs, включая профиль и разрешённые credentials, сохраняются.
 */
export function workerEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = Object.fromEntries(Object.entries(source).filter(([key]) => !nodeInputs.has(key)));

  // child_process дописывает родительский coverage даже поверх явного allowlist.
  // Собственное пустое значение подавляет этот специальный fallback Node.
  result.NODE_V8_COVERAGE = '';

  return result;
}

/**
 * Все режимы запускают обычный Node через IPC-bootstrap, включая служебный verify.
 * Launcher ждёт close worker; успех после SIGKILL требует подтверждённого disposal.
 */
export async function runLauncherWorker(options: {
  directory: string;
  entry: string;
  args: string[];
  capture?: boolean;
}): Promise<WorkerResult> {
  const stdio: StdioOptions = options.capture
    ? ['ignore', 'pipe', 'pipe', 'ipc']
    : ['inherit', 'inherit', 'inherit', 'ipc'];
  const child = spawn(path.join(options.directory, 'node'), [
    path.join(options.directory, 'worker-bootstrap.mjs'),
    options.entry,
    ...options.args,
  ], {
    stdio,
    cwd: process.cwd(),
    env: workerEnvironment(process.env),
  });
  let stdout = '';
  let stderr = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposalTimer: ReturnType<typeof setTimeout> | undefined;
  let disposedCode: 0 | 130 | undefined;
  let killedAfterDisposal = false;
  let escalated = false;
  let overflow = false;

  const forward = (signal: NodeJS.Signals) => {
    if (timer) {
      return;
    }

    child.kill(signal);
    timer = setTimeout(() => {
      escalated = true;
      child.kill('SIGKILL');
    }, 4000);
  };
  const term = () => forward('SIGTERM');
  const interrupt = () => forward('SIGINT');
  const deadline = options.capture ? setTimeout(term, 60000) : undefined;

  child.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object' || !('type' in message) || !('code' in message)
      || message.type !== 'worker-disposed' || (message.code !== 0 && message.code !== 130)
      || disposedCode !== undefined || escalated || overflow) {
      return;
    }

    disposedCode = message.code;

    // После disposal даём stdio и обычному exit 100 мс, не продлевая общий срок 4 с.
    // Неотменяемый getaddrinfo удерживает native exit, хотя сервисы и дети уже освобождены.
    disposalTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        killedAfterDisposal = child.kill('SIGKILL');
      }
    }, 100);
  });

  child.stdout?.on('data', (bytes) => {
    if (Buffer.byteLength(stdout) + bytes.length > 65536) {
      overflow = true;
      forward('SIGTERM');
    } else {
      stdout += String(bytes);
    }
  });
  child.stderr?.on('data', (bytes) => {
    if (Buffer.byteLength(stderr) + bytes.length > 65536) {
      overflow = true;
      forward('SIGTERM');
    } else {
      stderr += String(bytes);
    }
  });
  process.once('SIGTERM', term);
  process.once('SIGINT', interrupt);

  if (process.send) {
    process.send({ type: 'bootstrap-worker', pid: child.pid });
  }

  try {
    const outcome = await new Promise<WorkerExit>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const confirmedCode = killedAfterDisposal && outcome.signal === 'SIGKILL' ? disposedCode : undefined;

    return {
      code: escalated || overflow ? 75 : outcome.code ?? confirmedCode ?? 75,
      stdout,
      stderr,
    };
  } finally {
    clearTimeout(timer);
    clearTimeout(disposalTimer);
    clearTimeout(deadline);
    process.removeListener('SIGTERM', term);
    process.removeListener('SIGINT', interrupt);
  }
}
