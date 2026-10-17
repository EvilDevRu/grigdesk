import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

import type { Cookies } from 'electron';

import { delayWithAbort } from '../../shared/lib/delay.ts';

export interface EnsureSessionOptions {
  origin: string;
  keyFile: string | null;
  cookies: Pick<Cookies, 'get' | 'set'>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface SessionValue {
  value: string;
  maxAgeSec: number;
}

/**
 * Reader допускает только приватный файл через проверенный дескриптор.
 * Любой отказ оставляет окно без сессии и не раскрывает содержимое ключа.
 */
export async function readWindowKey(file: string | null): Promise<string | null> {
  const uid = process.getuid?.();
  let handle: FileHandle | undefined;

  if (file === null || uid === undefined) {
    return null;
  }

  try {
    const directory = await fs.lstat(path.dirname(file));

    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== uid
      || (directory.mode & 0o7777) !== 0o700) {
      return null;
    }

    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

    const stat = await handle.stat();

    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o077) !== 0 || stat.nlink !== 1) {
      return null;
    }

    const buffer = Buffer.alloc(129);
    let size = 0;

    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);

      if (bytesRead === 0) {
        break;
      }

      size += bytesRead;
    }

    if (size > 128) {
      return null;
    }

    const key = buffer.subarray(0, size).toString('utf8').trim();

    return key.length === 43 && /^[A-Za-z0-9_-]+$/u.test(key) ? key : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Разбирается единственная полноценная cookie, ограниченная локальным HTTP-хостом.
 * Неполные атрибуты и дубли не превращаются в постоянную сессию окна.
 */
export function sessionFromSetCookie(headers: readonly string[]): SessionValue | null {
  let result: SessionValue | null = null;

  for (const header of headers) {
    const parts = header.split(';');
    const first = parts.shift()?.trim() ?? '';
    const equals = first.indexOf('=');

    if (first.slice(0, equals) !== 'cockpit_sid') {
      continue;
    }

    const value = first.slice(equals + 1);

    if (result !== null || !/^[A-Za-z0-9_-]+$/u.test(value)) {
      return null;
    }

    const attributes = new Map<string, string | true>();

    for (const part of parts) {
      const index = part.indexOf('=');
      const name = (index < 0 ? part : part.slice(0, index)).trim().toLowerCase();

      if (attributes.has(name)) {
        return null;
      }

      attributes.set(name, index < 0 ? true : part.slice(index + 1).trim());
    }

    const age = attributes.get('max-age');
    const sameSite = attributes.get('samesite');
    const maxAgeSec = typeof age === 'string' && /^[0-9]+$/u.test(age) ? Number(age) : NaN;

    if (!Number.isSafeInteger(maxAgeSec) || maxAgeSec <= 0 || attributes.get('path') !== '/'
      || attributes.get('httponly') !== true || typeof sameSite !== 'string'
      || sameSite.toLowerCase() !== 'lax' || attributes.has('domain') || attributes.has('secure')) {
      return null;
    }

    result = {
      value,
      maxAgeSec,
    };
  }

  return result;
}

/**
 * Таймаут действует на запрос и чтение его тела до возврата результата.
 * Внешняя отмена объединяется с таймером, который очищается при любом исходе.
 */
async function requestWithin<T>(
  timeoutMs: number,
  external: AbortSignal | undefined,
  action: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = external ? AbortSignal.any([external, controller.signal]) : controller.signal;

  try {
    signal.throwIfAborted();

    const result = await action(signal);

    signal.throwIfAborted();

    return result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Проверяет действующую cookie отдельным GET без обмена ключом окна.
 * Отказы запроса передаются caller, который выбирает вход или отказ открытия настроек.
 */
export async function sessionCookieActive(
  options: Pick<EnsureSessionOptions, 'origin' | 'cookies' | 'fetchImpl' | 'signal'>,
): Promise<boolean> {
  const { origin, cookies, signal } = options;
  const fetchImpl = options.fetchImpl ?? fetch;

  if (signal?.aborted) {
    return false;
  }

  const existing = await cookies.get({
    url: origin + '/',
    name: 'cockpit_sid',
  });

  if (signal?.aborted) {
    return false;
  }

  const candidate = existing.length === 1 ? existing[0] : undefined;

  if (candidate?.name === 'cockpit_sid' && /^[A-Za-z0-9_-]+$/u.test(candidate.value)) {
    const authenticated = await requestWithin(2000, signal, async (requestSignal) => {
      const response = await fetchImpl(origin + '/api/auth/state', {
        method: 'GET',
        headers: { Cookie: `cockpit_sid=${candidate.value}` },
        redirect: 'error',
        signal: requestSignal,
      });

      requestSignal.throwIfAborted();

      if (response.status !== 200) {
        return false;
      }

      const state: unknown = await response.json();

      return state !== null && typeof state === 'object' && !Array.isArray(state)
        && 'authenticated' in state && state.authenticated === true;
    });

    if (signal?.aborted) {
      return false;
    }

    return authenticated;
  }

  return false;
}

/**
 * Вход проходит до загрузки веба и сохраняет уже действующую cookie.
 * Обмен ограничен двумя чтениями ключа и никогда не возвращает секрет caller.
 *
 * `session` — уже действующая cookie, `window-key` — сессия получена обменом ключа,
 * `unavailable` — ни того, ни другого: парольного запасного входа больше нет.
 */
export async function ensureSession(
  options: EnsureSessionOptions,
): Promise<'session' | 'window-key' | 'unavailable'> {
  const { origin, keyFile, cookies, signal } = options;
  const fetchImpl = options.fetchImpl ?? fetch;

  if (signal?.aborted) {
    return 'unavailable';
  }

  try {
    if (await sessionCookieActive(options)) {
      return signal?.aborted ? 'unavailable' : 'session';
    }

    if (signal?.aborted) {
      return 'unavailable';
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const key = await readWindowKey(keyFile);

      if (signal?.aborted) {
        return 'unavailable';
      }

      if (key !== null) {
        const response = await requestWithin(5000, signal, (requestSignal) => {
          return fetchImpl(origin + '/api/auth/window-session', {
            method: 'POST',
            headers: { 'x-cockpit-window-key': key },
            redirect: 'error',
            signal: requestSignal,
          });
        });

        if (signal?.aborted) {
          return 'unavailable';
        }

        if (response.status === 200) {
          const session = sessionFromSetCookie(response.headers.getSetCookie());

          if (!session || signal?.aborted) {
            return 'unavailable';
          }

          const expirationDate = Math.floor((options.now ?? Date.now)() / 1000) + session.maxAgeSec;

          if (!Number.isSafeInteger(expirationDate) || expirationDate <= 0) {
            return 'unavailable';
          }

          await cookies.set({
            url: origin + '/',
            name: 'cockpit_sid',
            value: session.value,
            httpOnly: true,
            sameSite: 'lax',
            path: '/',
            secure: false,
            expirationDate,
          });

          return signal?.aborted ? 'unavailable' : 'window-key';
        }

        if (response.status !== 401 && response.status !== 503) {
          return 'unavailable';
        }
      }

      if (attempt === 0) {
        await (options.sleep ?? delayWithAbort)(100, signal);

        if (signal?.aborted) {
          return 'unavailable';
        }
      }
    }
  } catch {
    return 'unavailable';
  }

  return 'unavailable';
}
