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
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { AuthStore } from '../lib/authStore.ts';
import { PUBLIC_HTTP_ROUTES } from '../lib/tls/local.ts';

export interface AuthPluginOptions {
  authStore: AuthStore;
  // Поднят ли собственный TLS: от этого зависит только предупреждение в журнале.
  tlsEnabled?: boolean;
  // Адрес доверенного прокси; пусто — заголовки пересылки игнорируются.
  trustProxy?: string | false;
  // Секрет процесса для дочернего CLI и токен локальных CLI-потребителей.
  internalToken?: string;
  cliToken?: string;
}

// Параметры cookie сессии. `secure` решается ПО ЗАПРОСУ: за шлюзом до нас доезжает http.
export interface SessionCookieOptions {
  maxAgeSec: number;
  secure: boolean;
  domain: string;
}

export const SESSION_COOKIE = 'cockpit_sid';

// Эндпоинты, доступные без сессии: ТОЛЬКО то, что нужно экрану входа.
// `/api/health` сознательно НЕ здесь: он отдаёт имя хоста и абсолютные пути (`stateDir`,
// `factoryHome`), а до входа его никто не запрашивает — экран логина обходится `auth/state`.
const PUBLIC_API = new Set([
  '/api/auth/state',
  '/api/auth/login',
  '/api/auth/setup',
  // Шлюз спрашивает разрешение на выдачу сертификата ДО всякой авторизации (сессии у него нет).
  // Данных не отдаёт — только «да/нет» по имени хоста.
  '/api/gateway/tls-allow',
  // Корневой сертификат локального HTTPS и QR на него. Без сессии, но только для клиентов
  // из локальной сети — проверку делает сам хендлер (`modules/settings`). Иначе установка
  // корня становится невозможной: устройство, где кокпит ещё не открывали, получит 401,
  // а без корня оно не откроет кокпит. Список общий с областью http-сокета
  // (`lib/tls/local.js`) — разъедутся, и QR молча перестанет работать.
  ...PUBLIC_HTTP_ROUTES,
]);

// Артефакты приёмки (`/shots/*`) — это скриншоты тестируемого приложения: данные
// проектов, содержимое задач, всё что было на экране.
// Имена предсказуемы (`t<номер задачи>-…`), листинг не нужен. Закрываем наравне с API:
// раньше они отдавались без сессии (проверено — реальный PNG приходил анонимно).
const PROTECTED_STATIC = ['/shots/'];

/**
 * Значение одной cookie из заголовка. Своими руками, чтобы не тащить @fastify/cookie:
 * нужна ровно одна cookie, и та в одном месте.
 */
export function readCookie(header: unknown, name: string): string | null {
  if (!header) return null;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/**
 * Пришёл ли запрос по защищённой схеме — решается ПО ЗАПРОСУ, а не один раз на старте.
 *
 * Причина: TLS может терминироваться не у нас. За шлюзом (VPS с Caddy) браузер говорит по https,
 * а до нас доезжает обычный http — если смотреть только на локальный TLS, сессионная cookie
 * уедет без флага Secure именно там, где он нужнее всего. `request.protocol` у Fastify учитывает
 * `X-Forwarded-Proto`, но ТОЛЬКО когда включён trustProxy (иначе заголовок игнорируется).
 */
export function isSecureRequest(request: FastifyRequest): boolean {
  return request.protocol === 'https';
}

/**
 * Запрос действительно с этой машины?
 *
 * Нужно для первичной настройки пароля: `setup` публичен по необходимости (иначе пароль не задать),
 * и на сетевом адресе кто угодно успел бы задать его первым, получив вместе с кокпитом PTY-шелл.
 *
 * Двойная проверка сознательно. `request.ip` за доверенным прокси — это уже адрес КЛИЕНТА
 * (Fastify разбирает `X-Forwarded-For`), поэтому удалённый клиент локальным не выглядит. Но если
 * прокси однажды настроят так, что заголовок не добавится, socket-адрес будет `127.0.0.1` —
 * поэтому дополнительно требуем ОТСУТСТВИЕ следов проксирования. Любой признак пересылки —
 * значит запрос пришёл извне, и настройку мы не отдаём.
 */
export function isLocalRequest(request: FastifyRequest): boolean {
  const ip = request.ip || '';
  const local = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  const forwarded = !!(request.headers['x-forwarded-for']
    || request.headers['x-forwarded-proto']
    || request.headers['x-forwarded-host']
    || request.headers.forwarded);
  return local && !forwarded;
}

/**
 * Область действия сессионной cookie.
 *
 * По умолчанию cookie host-only — она уедет только на тот хост, что её поставил. Стенды за
 * шлюзом живут на ПОДДОМЕНАХ (`p5191.<домен>`), и без явного `Domain` браузер к ним cookie
 * не отправит: `forward_auth` не увидит сессию и стенды окажутся недоступны.
 *
 * Ставим `Domain` только когда запрос действительно пришёл на публичный домен. На localhost
 * и на адрес в локальной сети он не нужен и вреден: cookie с чужим `Domain` браузер отбросит,
 * и вход сломается молча.
 *
 * Цена: cookie становится видна всем поддоменам публичного домена. Все они наши (стенды),
 * а `HttpOnly` не даёт прочитать её из JS — приемлемо.
 */
export function cookieDomain(request: FastifyRequest, publicDomain: unknown): string {
  if (!publicDomain) return '';
  const base = String(publicDomain).trim().toLowerCase().replace(/\.$/, '');
  const host = String(request.hostname || '').toLowerCase().replace(/:\d+$/, '');
  if (!base || !host) return '';
  return (host === base || host.endsWith(`.${base}`)) ? base : '';
}

/**
 * Заголовок Set-Cookie для сессии.
 * Secure ставим только когда браузер реально говорит по https: на http он cookie с Secure
 * выбрасывает, и вход сломался бы молча.
 */
export function sessionCookie(id: string, {
  maxAgeSec,
  secure,
  domain,
}: SessionCookieOptions): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(id)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ];
  if (domain) parts.push(`Domain=${domain}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookie({ secure, domain }: Omit<SessionCookieOptions, 'maxAgeSec'>): string {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (domain) parts.push(`Domain=${domain}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

async function authPlugin(fastify: FastifyInstance, opts: AuthPluginOptions): Promise<void> {
  const { authStore, tlsEnabled, trustProxy, internalToken, cliToken } = opts;

  // Provenance успешной авторизации нужен внутренним control-plane ручкам. Наличие
  // валидной сессии само по себе не делает запрос серверным: queue dispatch identity
  // вправе назначать только process-local internal caller.
  fastify.decorateRequest('authKind', null);

  if (!authStore.isConfigured()) {
    fastify.log.warn('Пароль кокпита НЕ задан. Задать можно ТОЛЬКО с этой машины (localhost) — с сети первичная настройка закрыта.');
  }
  if (!tlsEnabled && !trustProxy) {
    fastify.log.warn('Ни TLS, ни доверенного прокси: пароль вне localhost пойдёт открытым текстом. Для доступа снаружи нужен шлюз (COCKPIT_TRUST_PROXY) либо свой сертификат (COCKPIT_TLS_KEY/CERT).');
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
    const routeUrl = request.routeOptions?.url || '';

    // Оболочка (web/dist) остаётся публичной — без неё не показать даже экран входа.
    // Закрываем API и артефакты приёмки; всё остальное статика.
    const guarded = routeUrl.startsWith('/api/')
      || PROTECTED_STATIC.some((p) => routeUrl.startsWith(p));
    if (!guarded) return;

    // Первичная настройка пароля — только с самой машины. Пока пароль не задан, этот эндпоинт
    // обязан быть открытым (иначе его нечем вызвать), и на сетевом адресе им бы завладел первый
    // желающий — вместе с терминалом. Владелец задаёт пароль на мозге, где кокпит и живёт.
    if (routeUrl === '/api/auth/setup') {
      if (isLocalRequest(request)) return;
      return reply.code(403).send({
        error: 'setup_local_only',
        message: 'Первичная настройка пароля возможна только с самой машины (localhost).',
      });
    }

    if (PUBLIC_API.has(routeUrl)) return;

    const sid = readCookie(request.headers.cookie, SESSION_COOKIE);
    if (authStore.isValidSession(sid)) {
      request.authKind = 'session';
      return;
    }

    // Внутренние запросы САМОГО сервера: permission-prompt-tool чата живёт в дочернем
    // процессе claude, cookie у него нет и быть не может, а спросить разрешение он должен.
    // Пускаем по секрету, который живёт только в памяти процесса и передаётся тому child'у.
    if (internalToken && request.headers['x-cockpit-internal'] === internalToken) {
      request.authKind = 'internal';
      return;
    }

    // Локальные CLI-потребители (bin/b24, ship-этап фабрики, скиллы): токен из файла 0600
    // в .state — прочитать его может только владелец машины, которому и так принадлежит
    // всё содержимое .state. Cookie у CLI нет, а публиковать PR/комментарии он обязан.
    if (cliToken && request.headers['x-cockpit-token'] === cliToken) {
      request.authKind = 'cli';
      return;
    }

    // 401 и на upgrade вебсокета тоже: хуки Fastify выполняются и для WS-роутов,
    // так что терминал закрыт тем же гардом, без токена в query (тот утекал в логи).
    // no-store ставится здесь, до module-specific hooks: иначе закрытые private API
    // могли получить закэшированный 401 без своих headers.
    reply.header('Cache-Control', 'no-store');
    reply.code(401).send({
      error: 'unauthorized',
      needsSetup: !authStore.isConfigured(),
      message: 'Требуется вход в кокпит.',
    });
  });
}

export default fp(authPlugin, { name: 'cockpit-auth' });
