// Модуль входа: состояние доступа и обмен локального ключа окна на сессию.
// Пароля, первичной настройки и выхода нет: приложение входит по ключу, а от чужих
// защищает блокировка экрана компьютера.
import { timingSafeEqual } from 'node:crypto';

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthStore } from '../../lib/authStore.ts';
import type { WindowAuthState } from '../../lib/windowKey.ts';
import {
  sessionCookie, readCookie, SESSION_COOKIE, isSecureRequest,
  isLocalRequest,
} from '../../plugins/auth.ts';

export interface AuthModuleOptions {
  authStore: AuthStore;
  windowAuth?: WindowAuthState;
}

/**
 * Адрес обмена определяется конфигурацией сервера, а не недоверенным Host.
 * Канонический HTTP-порт 80 разрешает обе обычные формы authority.
 */
function windowOriginAllowed(request: FastifyRequest, origin: string): boolean {
  const expected = new URL(origin);
  const host = request.headers.host;
  const site = request.headers['sec-fetch-site'];
  const sameHost = host === expected.host
    || (expected.port === '' && expected.protocol === 'http:'
      && expected.hostname === '127.0.0.1' && host === '127.0.0.1:80');

  return sameHost && (request.headers.origin === undefined || request.headers.origin === origin)
    && site !== 'cross-site' && (site === undefined || typeof site === 'string');
}

/**
 * Только одиночный заголовок точного формата допускается к сравнению секрета.
 * Равенство размеров проверяется до timingSafeEqual, чтобы отказ не стал исключением.
 */
function windowKeyMatches(provided: unknown, key: string): boolean {
  if (typeof provided !== 'string' || provided.length !== 43 || !/^[A-Za-z0-9_-]+$/u.test(provided)) {
    return false;
  }

  const actual = Buffer.from(provided, 'utf8');
  const expected = Buffer.from(key, 'utf8');

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Обмен ключа создаёт обычную сессию AuthStore и ограниченную хостом cookie.
 * Secure определяется сокетом запроса; заголовки пересылки его не меняют.
 */
async function authModule(fastify: FastifyInstance, opts: AuthModuleOptions): Promise<void> {
  const { authStore } = opts;

  fastify.post('/api/auth/window-session', {
    logLevel: 'silent',
    onRequest: async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
    },
  }, async (request, reply) => {
    const state = opts.windowAuth;

    if (!state?.key) {
      return reply.code(503).send({ error: 'window_key_unavailable' });
    }

    const forwarded = ['forwarded', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host']
      .some((name) => request.headers[name] !== undefined);

    if (!isLocalRequest(request) || forwarded) {
      return reply.code(403).send({ error: 'local_only' });
    }

    if (!windowOriginAllowed(request, state.origin)) {
      return reply.code(403).send({ error: 'bad_window_origin' });
    }

    if (!windowKeyMatches(request.headers['x-grigdesk-window-key'], state.key)) {
      return reply.code(401).send({ error: 'bad_window_key' });
    }

    const session = authStore.createSession();

    return reply.header('Set-Cookie', sessionCookie(session.id, {
      maxAgeSec: session.maxAgeSec,
      secure: isSecureRequest(request),
    })).send({ ok: true });
  });

  // Состояние входа — публичный эндпоинт: по нему оболочка и заставка окна понимают,
  // опубликован ли ключ и действует ли сессия. Ни логина, ни хеша, ни признака
  // «пароль не задан» здесь больше нет.
  fastify.get('/api/auth/state', {
    onRequest: async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
    },
  }, async (request) => {
    const sid = readCookie(request.headers.cookie, SESSION_COOKIE);
    const authenticated = authStore.isValidSession(sid);

    return {
      method: 'window-key',
      configured: Boolean(opts.windowAuth?.key),
      authenticated,
      secure: isSecureRequest(request),
      // Владелец локальных данных нужен только действующей сессии.
      ...(authenticated ? { clientScope: authStore.clientScope } : {}),
    };
  });
}

export default fp(authModule, { name: 'module-auth' });
