import { runIsolatedNetworkWorker } from './isolatedNetworkWorker.ts';

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

export interface IsolatedFetchLimits {
  timeoutMs?: number;
  maxBytes?: number;
  successJsonOnly?: boolean;
}

interface NetworkResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string | null;
}

const READ_RESPONSE = `async ({ url, init, maxBytes, successJsonOnly }) => {
  const response = await fetch(url, init);
  const headers = [...response.headers];
  const { status, statusText } = response;
  const type = response.headers.get('content-type')?.toLowerCase();
  const skipBody = successJsonOnly && (!response.ok || !type?.startsWith('application/json'));

  if (!response.body || skipBody) {
    await response.body?.cancel();

    return { status, statusText, headers, body: null };
  }

  const chunks = [];
  let size = 0;

  if (Number(response.headers.get('content-length')) > maxBytes) {
    throw Object.assign(new Error(), { code: 'response_too_large' });
  }

  for await (const chunk of response.body) {
    size += chunk.byteLength;

    if (size > maxBytes) {
      throw Object.assign(new Error(), { code: 'response_too_large' });
    }

    chunks.push(chunk);
  }

  return {
    status,
    statusText,
    headers,
    body: Buffer.concat(chunks).toString('base64'),
  };
}`;

/**
 * Буферизованный HTTP(S) для небольших ответов статистики, без Request и потокового тела.
 * Таймаут и отмена убивают собственный процесс и дожидаются close, освобождая даже зависший DNS.
 */
export async function isolatedFetchWithLimits(
  input: string | URL | Request,
  init: RequestInit = {},
  { timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES, successJsonOnly = false }: IsolatedFetchLimits = {},
): Promise<Response> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 20 * 1024 * 1024) {
    throw new RangeError('Недопустимые пределы изолированного запроса.');
  }

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

  init.signal?.throwIfAborted();

  const result = await runIsolatedNetworkWorker<NetworkResponse>({
    operation: READ_RESPONSE,
    request: {
      url: url.href,
      maxBytes,
      successJsonOnly,
      init: {
        method: init.method,
        headers: [...new Headers(init.headers)],
        body: init.body,
        redirect: init.redirect,
        credentials: init.credentials,
      },
    },
    signal: init.signal,
    timeoutMs,
    maxOutputBytes: maxBytes * 2 + 64 * 1024,
    http: true,
  });

  return new Response(result.body === null ? null : Buffer.from(result.body, 'base64'), {
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
  });
}

/**
 * Умолчания статистики сохраняют прежние 15 секунд и 2 МиБ.
 * Telegram задаёт пределы явно, используя тот же транспорт и подтверждение close.
 */
export const isolatedFetch: typeof fetch = (input, init) => isolatedFetchWithLimits(input, init);
