import { spawn } from 'node:child_process';

import { NETWORK_FAMILY_ATTEMPT_TIMEOUT_MS } from './networkFamily.ts';
import { nodeExecutable } from './runtimePaths.ts';

// Ввод передаётся через stdin. Самосторож действует даже при потере родительского процесса.
const BOOTSTRAP = String.raw`
import { stdin, stdout } from 'node:process';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';

// Тот же предел попыток happy-eyeballs, что и у сервера: ребёнок не наследует дефолты родителя.
setDefaultAutoSelectFamilyAttemptTimeout(${NETWORK_FAMILY_ATTEMPT_TIMEOUT_MS});

const terminate = () => process.kill(process.pid, 'SIGKILL');
process.on('uncaughtException', terminate);
process.on('unhandledRejection', terminate);
stdout.on('error', terminate);

let watchdog = setTimeout(terminate, 16_000);

async function runNetworkOperation(operation) {
  try {
    let input = '';

    for await (const chunk of stdin.setEncoding('utf8')) {
      input += chunk;
    }

    const { deadline, request } = JSON.parse(input);

    clearTimeout(watchdog);
    watchdog = setTimeout(terminate, Math.max(0, deadline + 1000 - Date.now()));

    const value = await operation(request);

    stdout.write(JSON.stringify({ value }));
  } catch (error) {
    const code = error?.code || error?.cause?.code;
    const safeCode = typeof code === 'string' && /^[\w-]{1,80}$/u.test(code) ? code : 'network_error';

    stdout.write(JSON.stringify({ error: safeCode }));
  } finally {
    // Обычный process.exit может ждать зависший native getaddrinfo.
    stdout.end(terminate);
  }
}
`;

interface NetworkWorkerOptions {
  operation: string;
  request: object;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal | null;
  timeoutMessage?: string;
  http?: boolean;
}

type WorkerResult<Value> = { value: Value } | { error: string };

export const envHttpProxyEnabled = process.env.NODE_USE_ENV_PROXY === '1'
  || process.execArgv.includes('--use-env-proxy')
  || /(?:^|\s)--use-env-proxy(?:\s|$)/u.test(process.env.NODE_OPTIONS ?? '');

const inheritedKeys = [
  'PATH', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'NODE_USE_SYSTEM_CA',
  'RES_OPTIONS', 'LOCALDOMAIN', 'HOSTALIASES',
];
const proxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'];

/**
 * Запускает сетевую операцию в одноразовом Node и ограничивает её результат.
 * Тайм-аут и отмена завершают собственный процесс, а ответ принимается только после close.
 */
export async function runIsolatedNetworkWorker<Value>({
  operation, request, timeoutMs, maxOutputBytes, signal, timeoutMessage = 'Сеть не ответила.', http = false,
}: NetworkWorkerOptions): Promise<Value> {
  const deadline = Date.now() + timeoutMs;

  signal?.throwIfAborted();

  const payload = JSON.stringify({ request, deadline });

  if (Buffer.byteLength(payload) > 256 * 1024) {
    throw new RangeError('Слишком большой изолированный запрос.');
  }

  const useProxy = http && envHttpProxyEnabled;
  const keys = useProxy ? [...inheritedKeys, ...proxyKeys] : inheritedKeys;
  const env = Object.fromEntries(keys
    .flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : []));

  if (useProxy) {
    env.NODE_USE_ENV_PROXY = '1';
  }

  return new Promise<Value>((resolve, reject) => {
    const script = `${BOOTSTRAP}\nrunNetworkOperation(${operation});`;
    const child = spawn(nodeExecutable(), ['--input-type=module', '--eval', script], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let failure: { reason: unknown } | undefined;

    /** Сохраняет первую причину, даже если завершение процесса закрыло его каналы с ошибкой. */
    const stop = (reason: unknown) => {
      failure ??= { reason };
      child.kill('SIGKILL');
    };
    const abort = () => stop(signal?.reason ?? new DOMException('Запрос отменён.', 'AbortError'));
    const timer = setTimeout(() => stop(new DOMException(timeoutMessage, 'TimeoutError')),
      Math.max(0, deadline - Date.now()));

    signal?.addEventListener('abort', abort, { once: true });

    child.on('error', () => stop(new TypeError('Не удалось запустить сетевой процесс.')));
    child.stdin.on('error', () => stop(new TypeError('Сетевой процесс закрыл вход.')));
    child.stdout.on('error', () => stop(new TypeError('Сетевой процесс закрыл ответ.')));
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;

      if (size > maxOutputBytes) {
        stop(new RangeError('Слишком большой ответ сетевого процесса.'));
      } else {
        chunks.push(chunk);
      }
    });
    child.on('close', (code, signalCode) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);

      if (failure) {
        reject(failure.reason);

        return;
      }

      try {
        if (code !== 0 && signalCode !== 'SIGKILL') {
          throw new TypeError('Сетевой процесс завершился без ответа.');
        }

        const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as WorkerResult<Value>;

        if ('error' in result) {
          throw Object.assign(new TypeError('Сетевой запрос не выполнен.'), {
            cause: { code: result.error },
          });
        }

        resolve(result.value);
      } catch (error) {
        reject(error);
      }
    });

    if (signal?.aborted) {
      abort();
    } else {
      child.stdin.end(payload);
    }
  });
}
