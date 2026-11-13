import type { BrowserHostIdentity } from './browserHost.ts';


/**
 * Host token передаётся только заголовком выбранному same-origin backend.
 * Все ожидания ограничены; ошибка POST не порождает повтор побочного действия.
 */
export function createBrowserHostHttp(port: {
  fetch: typeof fetch;
  unauthorized(): void;
}) {
  return async (method: string, suffix: string, body: unknown,
    host: BrowserHostIdentity | null, signal?: AbortSignal, timeoutMs = 15000): Promise<unknown> => {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;

    try {
      const response = await port.fetch('/api/browser' + suffix, {
        method,
        credentials: 'same-origin',
        mode: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        signal: combined,
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(host ? { 'X-GrigDesk-Browser-Host': host.token } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();

      if (text.length > 256 * 1024) {
        throw new Error('browser_response_invalid');
      }

      if (response.status === 401) {
        port.unauthorized();
      }

      if (!response.ok) {
        const error = new Error(response.status === 409
          ? 'browser_host_conflict' : 'browser_unavailable') as Error & { status: number };

        error.status = response.status;

        throw error;
      }

      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(timer);
    }
  };
}

