// Плагин авторизации кокпита.
//
// Модель: ОДИН пользователь, вход по логину и паролю, дальше — сессионная httpOnly-cookie.
// Гард стоит на ВСЁМ `/api`, включая GET и upgrade вебсокета. Прежняя модель («читать свободно
// внутри доверенной сети») не годится: кокпит отдаёт историю чатов, дифы, состояние фабрики,
// а через терминал — шелл на машину, поэтому чтение закрыто наравне с мутациями.
//
// Почему 401, а не редирект на страницу входа: фронт — PWA с service worker'ом, и серверный
// редирект на навигации конфликтует с офлайн-оболочкой (SW отдаёт закешированное приложение
// вместо страницы логина). Поэтому статика ПУБЛИЧНА (в ней нет секретов), оболочка грузится
// всегда, спрашивает `/api/auth/state` и сама показывает экран входа по 401.
import fp from 'fastify-plugin';

export const SESSION_COOKIE = 'cockpit_sid';

// Эндпоинты, доступные без сессии: ТОЛЬКО то, что нужно экрану входа.
// `/api/health` сознательно НЕ здесь: он отдаёт имя хоста и абсолютные пути (`stateDir`,
// `factoryHome`), а до входа его никто не запрашивает — экран логина обходится `auth/state`.
const PUBLIC_API = new Set([
  '/api/auth/state',
  '/api/auth/login',
  '/api/auth/setup',
]);

// Артефакты приёмки (`/shots/*`) и демо-видео (`/demo/*`) — это скриншоты и записи
// тестируемого приложения: данные проектов, содержимое задач, всё что было на экране.
// Имена предсказуемы (`t<номер задачи>-…`), листинг не нужен. Закрываем наравне с API:
// раньше они отдавались без сессии (проверено — реальный PNG приходил анонимно).
const PROTECTED_STATIC = ['/shots/', '/demo/'];

/**
 * Значение одной cookie из заголовка. Своими руками, чтобы не тащить @fastify/cookie:
 * нужна ровно одна cookie, и та в одном месте.
 */
export function readCookie(header, name) {
  if (!header) return null;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/**
 * Заголовок Set-Cookie для сессии.
 * Secure ставим ТОЛЬКО при включённом TLS: на http браузер cookie с Secure выбрасывает,
 * и вход сломался бы молча.
 */
export function sessionCookie(id, { maxAgeSec, secure }) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(id)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookie({ secure }) {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

async function authPlugin(fastify, opts) {
  const { authStore, tlsEnabled, internalToken } = opts;

  if (!authStore.isConfigured()) {
    fastify.log.warn('Пароль кокпита НЕ задан — до первичной настройки API закрыт, откроется экран создания пароля.');
  }
  if (!tlsEnabled) {
    fastify.log.warn('TLS выключен: пароль будет ходить открытым текстом. Для доступа вне localhost задайте COCKPIT_TLS_KEY/CERT.');
  }

  fastify.addHook('onRequest', async (request, reply) => {
    // Решение принимаем по МАТЧЕННОМУ РОУТУ, а НЕ по `request.raw.url`.
    //
    // Почему это критично: роутер Fastify декодирует percent-encoding ПЕРЕД сопоставлением,
    // поэтому `/%61pi/terminal` попадает в обработчик `/api/terminal`. Проверка сырой строки
    // на префикс `/api/` такой запрос пропускала как статику — получался полный обход входа
    // (проверено: читались `/api/chat/store` и `/api/tasks`, проходили мутации, а PTY-вебсокет
    // отдавал `101 Switching Protocols`, т.е. шелл без пароля).
    //
    // Матченный роут — это шаблон вида `/api/tasks/:id/graph`: он не зависит ни от кодирования,
    // ни от query, ни от лишних слэшей. Если роут не совпал (404) — пусто, и запрос уходит
    // в SPA-fallback, никаких данных API там нет.
    const routeUrl = request.routeOptions?.url || request.routerPath || '';

    // Оболочка (web/dist) остаётся публичной — без неё не показать даже экран входа.
    // Закрываем API и артефакты приёмки; всё остальное статика.
    const guarded = routeUrl.startsWith('/api/')
      || PROTECTED_STATIC.some((p) => routeUrl.startsWith(p));
    if (!guarded) return;
    if (PUBLIC_API.has(routeUrl)) return;

    const sid = readCookie(request.headers.cookie, SESSION_COOKIE);
    if (authStore.isValidSession(sid)) return;

    // Внутренние запросы САМОГО сервера: permission-prompt-tool чата живёт в дочернем
    // процессе claude, cookie у него нет и быть не может, а спросить разрешение он должен.
    // Пускаем по секрету, который живёт только в памяти процесса и передаётся тому child'у.
    if (internalToken && request.headers['x-cockpit-internal'] === internalToken) return;

    // 401 и на upgrade вебсокета тоже: хуки Fastify выполняются и для WS-роутов,
    // так что терминал закрыт тем же гардом, без токена в query (тот утекал в логи).
    reply.code(401).send({
      error: 'unauthorized',
      needsSetup: !authStore.isConfigured(),
      message: 'Требуется вход в кокпит.',
    });
  });
}

export default fp(authPlugin, { name: 'cockpit-auth' });
