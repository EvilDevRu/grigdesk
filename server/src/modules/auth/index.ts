// Модуль входа: состояние, логин, выход, первичная настройка и смена пароля.
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { AuthStore } from '../../lib/authStore.ts';
import {
  sessionCookie, clearCookie, readCookie, SESSION_COOKIE, isSecureRequest,
} from '../../plugins/auth.ts';

export interface AuthModuleOptions {
  authStore: AuthStore;
}

// Тело запросов входа: приходит из сети, поэтому каждое поле недоверенное.
interface AuthBody {
  login?: unknown;
  password?: unknown;
  currentPassword?: unknown;
}

// Ограничение попыток входа. Без него пароль перебирается по сети за вечер.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
// Счётчик неудач по адресу: ключ — адрес клиента, значение — сколько и до какого
// момента. Живёт в памяти процесса: перезапуск обнуляет, и это допустимо.
const attempts = new Map<string, { count: number; until: number }>();

function attemptKey(request: FastifyRequest): string {
  return request.ip || 'unknown';
}

function tooMany(request: FastifyRequest): boolean {
  const rec = attempts.get(attemptKey(request));
  if (!rec) return false;
  if (rec.until <= Date.now()) {
    attempts.delete(attemptKey(request));
    return false;
  }
  return rec.count >= MAX_ATTEMPTS;
}

function registerFailure(request: FastifyRequest): void {
  const key = attemptKey(request);
  const rec = attempts.get(key);
  if (!rec || rec.until <= Date.now()) {
    attempts.set(key, { count: 1, until: Date.now() + WINDOW_MS });
    return;
  }
  rec.count += 1;
  rec.until = Date.now() + WINDOW_MS;
}

function clearFailures(request: FastifyRequest): void {
  attempts.delete(attemptKey(request));
}

/**
 * Задержка на неудачный вход: тормозит перебор и заодно сглаживает разницу во времени
 * между «нет такого логина» и «пароль неверный».
 */
const slowDown = () => new Promise<void>((resolve) => {
  setTimeout(resolve, 400);
});

/** Текст отказа хранилища: сообщение о слабом пароле человек должен увидеть целиком. */
function failureText(error: unknown): string {
  return String((error as { message?: unknown } | null)?.message || error);
}

/**
 * Вход, смена пароля и выход используют одно серверное хранилище сессий.
 * Cookie остаётся ограниченной хостом, её Secure определяется сокетом запроса.
 */
async function authModule(fastify: FastifyInstance, opts: AuthModuleOptions): Promise<void> {
  const { authStore } = opts;

  // Secure вычисляется для каждого запроса; заголовки пересылки его не меняют.
  // При локальном HTTP браузер получает обычную сессионную cookie.
  const cookieOpts = (request: FastifyRequest) => ({
    secure: isSecureRequest(request),
  });

  // Состояние входа — публичный эндпоинт: с него оболочка решает, что показать.
  fastify.get('/api/auth/state', async (request) => {
    const sid = readCookie(request.headers.cookie, SESSION_COOKIE);
    return {
      configured: authStore.isConfigured(),
      authenticated: authStore.isValidSession(sid),
      login: authStore.publicView().login,
      secure: isSecureRequest(request),
    };
  });

  // Первичная настройка: доступна ТОЛЬКО пока пароль не задан. Иначе кто угодно
  // переустановил бы пароль и вошёл.
  fastify.post('/api/auth/setup', async (request, reply) => {
    if (authStore.isConfigured()) {
      return reply.code(409).send({ error: 'already_configured', message: 'Пароль уже задан. Меняется в настройках после входа.' });
    }
    const { login, password } = (request.body || {}) as AuthBody;

    try {
      authStore.setCredentials({ login: String(login ?? ''), password: String(password ?? '') });
    } catch (err) {
      return reply.code(400).send({ error: 'bad_password', message: failureText(err) });
    }
    // Сразу впускаем — иначе пользователь задал пароль и тут же вводит его снова.
    const s = authStore.createSession();
    return reply
      .header('Set-Cookie', sessionCookie(s.id, { maxAgeSec: s.maxAgeSec, ...cookieOpts(request) }))
      .send({ ok: true, login: String(login ?? '') });
  });

  fastify.post('/api/auth/login', async (request, reply) => {
    if (!authStore.isConfigured()) {
      return reply.code(409).send({ error: 'not_configured', message: 'Пароль ещё не задан.' });
    }
    if (tooMany(request)) {
      return reply.code(429).send({ error: 'too_many_attempts', message: 'Слишком много попыток. Подождите 15 минут.' });
    }
    const { login, password } = (request.body || {}) as AuthBody;

    if (!authStore.check({ login, password })) {
      registerFailure(request);
      await slowDown();
      return reply.code(401).send({ error: 'bad_credentials', message: 'Неверный логин или пароль.' });
    }
    clearFailures(request);
    const s = authStore.createSession();
    return reply
      .header('Set-Cookie', sessionCookie(s.id, { maxAgeSec: s.maxAgeSec, ...cookieOpts(request) }))
      .send({ ok: true });
  });

  // Выход. Под гардом — сюда попадают только с валидной сессией.
  fastify.post('/api/auth/logout', async (request, reply) => {
    authStore.dropSession(readCookie(request.headers.cookie, SESSION_COOKIE));
    return reply.header('Set-Cookie', clearCookie(cookieOpts(request))).send({ ok: true });
  });

  fastify.post('/api/auth/logout-all', async (request, reply) => {
    authStore.dropAllSessions();
    return reply.header('Set-Cookie', clearCookie(cookieOpts(request))).send({ ok: true });
  });

  // Смена логина/пароля из настроек. Требуем текущий пароль: украденная сессия не должна
  // позволять сменить пароль и запереть владельца.
  fastify.post('/api/auth/password', async (request, reply) => {
    const { currentPassword, login, password } = (request.body || {}) as AuthBody;
    const acc = authStore.readAccount();
    if (!authStore.check({ login: acc?.login, password: currentPassword })) {
      await slowDown();
      return reply.code(401).send({ error: 'bad_current_password', message: 'Текущий пароль неверен.' });
    }
    try {
      // setCredentials сбрасывает все сессии — сразу выдаём новую, чтобы не выкинуть себя.
      authStore.setCredentials({
        login: String(login ?? acc?.login ?? ''),
        password: String(password ?? ''),
      });
    } catch (err) {
      return reply.code(400).send({ error: 'bad_password', message: failureText(err) });
    }
    const s = authStore.createSession();
    return reply
      .header('Set-Cookie', sessionCookie(s.id, { maxAgeSec: s.maxAgeSec, ...cookieOpts(request) }))
      .send({ ok: true, note: 'Остальные устройства разлогинены.' });
  });
}

export default fp(authModule, { name: 'module-auth' });
