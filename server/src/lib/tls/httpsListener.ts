// Второй сокет: тот же кокпит, но по HTTPS.
//
// Fastify создаётся БЕЗ опции `https` — иначе основной сокет перестал бы быть http, а порт 8140
// это внутренняя шина (MCP разрешений чата, `bin/b24`, `bin/restart`, dev-прокси Vite, туннель
// шлюза), у которой нет и не должно быть сертификата. Поэтому https поднимается отдельным
// `http.Server`-ом, которому отдаётся тот же роутер.
//
// Что переносится и почему:
//  - `app.routing` — публичная точка входа роутера Fastify; через неё же диспетчерит
//    `@fastify/websocket`, так что маршруты, хуки и гард авторизации работают одинаково на обоих;
//  - слушатели `upgrade` — `@fastify/websocket` вешает свой ровно один раз на `app.server`
//    (в noServer-режиме), и без переноса терминал по `wss://` молча не подключался бы;
//  - таймауты — дефолты Node рвут долгие соединения, а у нас SSE и PTY живут часами.
import https from 'node:https';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

// Что от приложения нужно этому модулю: публичный роутер Fastify и его http-сервер.
// Полный тип Fastify здесь избыточен — переносится ровно роутинг и таймауты.
export interface RoutedApp {
  routing: (request: IncomingMessage, response: ServerResponse) => void;
  server: HttpServer;
}

export interface HttpsPair {
  key: Buffer;
  cert: Buffer;
}

// Итог подъёма: отказ возвращается, а не бросается — занятый порт не повод гасить кокпит.
export type HttpsStart =
  | { ok: true; server: https.Server; port: number }
  | { ok: false; error: string };

/**
 * Собрать https-сервер поверх готового приложения. Слушателей НЕ вешает — вызывать после
 * `app.ready()`/`app.listen()`, иначе плагин вебсокета ещё не зарегистрировал свой upgrade.
 */
export function buildHttpsServer({ app, key, cert }: HttpsPair & { app: RoutedApp }): https.Server {
  const server = https.createServer({ key, cert });
  server.on('request', (req, res) => app.routing(req, res));
  for (const listener of app.server.listeners('upgrade')) {
    server.on('upgrade', listener as (...args: unknown[]) => void);
  }
  server.keepAliveTimeout = app.server.keepAliveTimeout;
  server.headersTimeout = app.server.headersTimeout;
  server.requestTimeout = app.server.requestTimeout;
  return server;
}

/**
 * Поднять https рядом с http.
 *
 * Ошибку возвращает, а не бросает: занятый порт или отказ в биндинге не повод убивать процесс.
 * http при этом продолжает работать без ограничений (см. `decideHttpRequest`: пока https не встал,
 * из сети пускаем всё) — иначе кнопка «выпустить сертификат» в браузере могла бы отрезать
 * единственный доступ к кокпиту, и чинить пришлось бы с консоли мозга.
 */
export async function startHttpsListener({
  app, key, cert, port, host,
}: HttpsPair & { app: RoutedApp; port: number; host: string }): Promise<HttpsStart> {
  const server = buildHttpsServer({ app, key, cert });
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      server.once('error', onError);
      server.listen(port, host, () => {
        server.removeListener('error', onError);
        resolve();
      });
    });
  } catch (err) {
    server.close();

    return { ok: false, error: String((err as { message?: unknown } | null)?.message || err) };
  }

  const address = server.address() as AddressInfo | null;

  return { ok: true, server, port: address?.port ?? port };
}
