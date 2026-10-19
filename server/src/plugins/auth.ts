// Плагин авторизации GrigDesk.
//
// Модель: ОДИН пользователь, вход только обменом локального ключа окна на сессионную
// httpOnly-cookie. Гард стоит на ВСЁМ `/api`, включая GET и upgrade вебсокета. Модель
// «читать свободно внутри доверенной сети» не годится: GrigDesk отдаёт историю чатов, дифы,
// состояние фабрики, а через терминал — шелл на машину, поэтому чтение закрыто наравне
// с мутациями.
//
// Почему 401, а не редирект на страницу входа: браузерный вход снят, приложение входит
// по ключу, а отказ обязан быть машинно-читаемым ответом, а не HTML.
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { AuthStore } from '../lib/authStore.ts';
import { deviceOf } from '../lib/clientAccess/principal.ts';

export interface AuthPluginOptions {
  authStore: AuthStore;
  // Секрет процесса для дочернего CLI и токен локальных CLI-потребителей.
  internalToken?: string;
  cliToken?: string;
}

// Cookie ограничена выдавшим её хостом; Secure определяется протоколом запроса.
export interface SessionCookieOptions {
  maxAgeSec: number;
  secure: boolean;
}

export const SESSION_COOKIE = 'grigdesk_sid';

// Эндпоинты, доступные без сессии: ТОЛЬКО состояние входа и обмен ключа окна.
// `/api/health` сознательно НЕ здесь: он отдаёт имя хоста и абсолютные пути (`stateDir`,
// `factoryHome`), а до входа его никто не запрашивает.
const PUBLIC_API = new Set([
  '/api/auth/state',
  '/api/auth/window-session',
]);

// Снимки содержат данные проектов и закрываются наравне с API.
// Матченный шаблон не позволяет закодированному префиксу обойти проверку.
const GUARDED_STATIC = ['/shots/'];

// Назначения fetch, для которых ответ — документ, а не данные. Форма отказа зависит
// только от этого: доступ решён раньше и от заголовков не зависит.
const DOCUMENT_DESTINATIONS = new Set(['document', 'iframe', 'frame']);

// Короткая самостоятельная страница отказа: без скриптов, ссылок и личных сведений.
export const APPLICATION_PAGE = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GrigDesk открывается в приложении</title>
  <style>
    body {
      margin: 0;
      background: #0b0d11;
      color: #e4e7ed;
      font: 16px/1.6 system-ui, sans-serif;
    }
    main {
      max-width: 640px;
      margin: 15vh auto;
      padding: 24px;
    }
  </style>
</head>
<body>
  <main>
    <h1>GrigDesk открывается в приложении</h1>
    <p>Запустите ярлык GrigDesk. Из браузера интерфейс больше не открывается.</p>
  </main>
</body>
</html>`;

// Артефакты приёмки (`/shots/*`) — это скриншоты тестируемого приложения: данные
// проектов, содержимое задач, всё что было на экране. Имена предсказуемы
// (`t<номер задачи>-…`), листинг не нужен; закрываются общим списком GUARDED_STATIC.

/**
 * Значение одной cookie из заголовка. Своими руками, чтобы не тащить @fastify/cookie:
 * нужна ровно одна cookie, и та в одном месте.
 *
 * Нечитаемое процентное кодирование — это отсутствие cookie, а не исключение: иначе
 * испорченный заголовок превращал бы отказ входа в 500.
 */
export function readCookie(header: unknown, name: string): string | null {
  if (!header) {
    return null;
  }

  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');

    if (i < 0) {
      continue;
    }

    if (part.slice(0, i).trim() !== name) {
      continue;
    }

    try {
      return decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Путь после декодирования percent-encoding, без query и hash.
 * Это форма ответа 404, а не решение о доступе: доступ уже решён гардом по матченному
 * роуту. Нечитаемая кодировка считается API-подобной — HTML оболочки отдавать нельзя.
 */
export function looksLikeApiPath(rawUrl: unknown): boolean {
  try {
    const pathname = new URL(String(rawUrl ?? '/'), 'http://127.0.0.1').pathname;

    return decodeURIComponent(pathname).startsWith('/api/');
  } catch {
    return true;
  }
}

/**
 * Навигация к документу отличается от запроса данных: браузер сообщает назначение
 * через Sec-Fetch-Dest, а без него — через Accept. Форма сообщения об отказе не меняет
 * само решение о доступе.
 */
function wantsDocument(request: FastifyRequest): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return false;
  }

  const destination = request.headers['sec-fetch-dest'];

  if (typeof destination === 'string') {
    return DOCUMENT_DESTINATIONS.has(destination);
  }

  const accept = request.headers.accept;

  return typeof accept === 'string' && accept.includes('text/html');
}

/**
 * Secure определяется протоколом сокета для каждого запроса.
 * Fastify не доверяет заголовкам пересылки, поэтому они не меняют схему.
 */
export function isSecureRequest(request: FastifyRequest): boolean {
  return request.protocol === 'https';
}

/**
 * Запрос действительно с этой машины?
 *
 * Нужно обмену ключа окна: ключ читается только владельцем машины, но сетевой адрес
 * обязан быть loopback. Даже у локального обратного прокси адрес сокета будет loopback,
 * поэтому любой forwarded-заголовок по-прежнему запрещает обмен.
 */
export function isLocalRequest(request: FastifyRequest): boolean {
  if (deviceOf(request.raw.socket)) {
    return false;
  }

  const ip = request.ip || '';
  const local = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  const forwarded = !!(request.headers['x-forwarded-for']
    || request.headers['x-forwarded-proto']
    || request.headers['x-forwarded-host']
    || request.headers.forwarded);
  return local && !forwarded;
}

/**
 * Заголовок Set-Cookie для сессии.
 * Secure ставим только когда браузер реально говорит по https: на http он cookie с Secure
 * выбрасывает, и вход сломался бы молча.
 */
export function sessionCookie(id: string, {
  maxAgeSec,
  secure,
}: SessionCookieOptions): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(id)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ];

  if (secure) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

/**
 * Общий гард закрывает API, WebSocket и защищённую статику до модульных обработчиков.
 * Публичны только состояние входа и обмен ключа окна; внутренние вызовы несут отдельные токены.
 */
async function authPlugin(fastify: FastifyInstance, opts: AuthPluginOptions): Promise<void> {
  const { authStore, internalToken, cliToken } = opts;

  // Provenance успешной авторизации нужен внутренним control-plane ручкам. Наличие
  // валидной сессии само по себе не делает запрос серверным: queue dispatch identity
  // вправе назначать только process-local internal caller.
  fastify.decorateRequest('authKind', null);
  fastify.decorateRequest('authPrincipal', null);

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
    // к сообщению о запуске приложения, никаких данных API там нет.
    const routeUrl = request.routeOptions?.url || '';

    // Гард решает по матченному роуту; статика закрывается наравне с API.
    const guarded = routeUrl.startsWith('/api/')
      || GUARDED_STATIC.some((prefix) => routeUrl === prefix || routeUrl.startsWith(prefix));
    if (!guarded) return;

    const device = deviceOf(request.raw.socket);

    if (device) {
      if (device.revoked) {
        return reply.header('Cache-Control', 'no-store').code(403).send({ error: 'device_revoked' });
      }

      request.authKind = 'session';
      request.authPrincipal = {
        kind: 'device',
        deviceId: device.deviceId,
      };

      return;
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
    if (internalToken && request.headers['x-grigdesk-internal'] === internalToken) {
      request.authKind = 'internal';
      return;
    }

    // Локальные CLI-потребители (bin/b24, ship-этап фабрики, скиллы): токен из файла 0600
    // в .state — прочитать его может только владелец машины, которому и так принадлежит
    // всё содержимое .state. Cookie у CLI нет, а публиковать PR/комментарии он обязан.
    if (cliToken && request.headers['x-grigdesk-token'] === cliToken) {
      request.authKind = 'cli';
      return;
    }

    // 401 и на upgrade вебсокета тоже: хуки Fastify выполняются и для WS-роутов,
    // так что терминал закрыт тем же гардом, без токена в query (тот утекал в логи).
    // no-store ставится здесь, до module-specific hooks: иначе закрытые private API
    // могли получить закэшированный 401 без своих headers.
    reply.header('Cache-Control', 'no-store');

    if (wantsDocument(request)) {
      return reply.code(401).type('text/html; charset=utf-8').send(APPLICATION_PAGE);
    }

    reply.code(401).send({
      error: 'unauthorized',
      message: 'Требуется вход в GrigDesk.',
    });
  });
}

export default fp(authPlugin, { name: 'grigdesk-auth' });
