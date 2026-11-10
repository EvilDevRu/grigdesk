import { spawn } from 'node:child_process';

import { nodeExecutable } from './runtimePaths.ts';

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

// Вход — JSON через stdin: ключи не оказываются в argv и не наследуются из окружения.
// Процесс одноразовый; основной сервер не выполняет DNS даже при зависшем resolver.
const WORKER = String.raw`
import { stdin, stdout } from 'node:process';

const watchdog = setTimeout(() => process.exit(1), 16_000);

try {
  let input = '';

  for await (const chunk of stdin) {
    input += chunk;
  }

  const { url, init, maxBytes } = JSON.parse(input);
  const response = await fetch(url, init);
  const chunks = [];
  let size = 0;

  if (response.body) {
    for await (const chunk of response.body) {
      size += chunk.byteLength;

      if (size > maxBytes) {
        throw Object.assign(new Error(), { code: 'response_too_large' });
      }

      chunks.push(chunk);
    }
  }

  stdout.write(JSON.stringify({
    status: response.status,
    headers: [...response.headers],
    body: Buffer.concat(chunks).toString('base64'),
  }));
} catch (error) {
  stdout.write(JSON.stringify({ error: String(error.code || error.cause?.code || 'network_error') }));
} finally {
  clearTimeout(watchdog);
  stdout.end(() => process.exit(0));
}
`;

/**
 * Буферизованный HTTP(S) для небольших ответов статистики, без Request и потокового тела.
 * Таймаут и отмена убивают собственный процесс и дожидаются close, освобождая даже зависший DNS.
 */
export const isolatedFetch: typeof fetch = async (input, init = {}) => {
  if (typeof input !== 'string' && !(input instanceof URL)) {
    throw new TypeError('Изолированный запрос принимает строку или URL.');
  }

  const url = new URL(input);

  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new TypeError('Нужен HTTP(S) URL без учётных данных.');
  }

  if (init.body != null && typeof init.body !== 'string') {
    throw new TypeError('Изолированный запрос принимает только строковое тело.');
  }

  const signal = init.signal;

  signal?.throwIfAborted();

  const request = JSON.stringify({
    url: url.href,
    maxBytes: MAX_BYTES,
    init: {
      method: init.method,
      headers: [...new Headers(init.headers)],
      body: init.body,
      redirect: init.redirect,
    },
  });

  if (Buffer.byteLength(request) > 256 * 1024) {
    throw new RangeError('Слишком большой изолированный запрос.');
  }

  return new Promise<Response>((resolve, reject) => {
    const child = spawn(nodeExecutable(), ['--input-type=module', '--eval', WORKER], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: Object.fromEntries(['PATH', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS']
        .flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : [])),
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let failure: unknown;
    let failed = false;

    const stop = (reason: unknown) => {
      if (!failed) {
        failure = reason;
        failed = true;
      }

      child.kill('SIGKILL');
    };
    const abort = () => stop(signal?.reason ?? new DOMException('Запрос отменён.', 'AbortError'));
    const timer = setTimeout(() => stop(new DOMException('Сеть не ответила.', 'TimeoutError')), TIMEOUT_MS);

    signal?.addEventListener('abort', abort, { once: true });

    child.on('error', () => stop(new TypeError('Не удалось запустить сетевой процесс.')));
    child.stdin.on('error', () => stop(new TypeError('Сетевой процесс закрыл вход.')));
    child.stdout.on('error', () => stop(new TypeError('Сетевой процесс закрыл ответ.')));
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;

      if (size > MAX_BYTES * 2) {
        stop(new RangeError('Слишком большой ответ сетевого процесса.'));
      } else {
        chunks.push(chunk);
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);

      if (failed) {
        reject(failure);

        return;
      }

      try {
        if (code !== 0) {
          throw new TypeError('Сетевой процесс завершился без ответа.');
        }

        const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));

        if (result.error) {
          throw Object.assign(new TypeError('Сетевой запрос не выполнен.'), {
            cause: { code: result.error },
          });
        }

        const empty = [204, 205, 304].includes(result.status) || init.method?.toUpperCase() === 'HEAD';

        resolve(new Response(empty ? null : Buffer.from(result.body, 'base64'), {
          status: result.status,
          headers: result.headers,
        }));
      } catch (error) {
        reject(error);
      }
    });

    if (signal?.aborted) {
      abort();
    } else {
      child.stdin.end(request);
    }
  });
};
