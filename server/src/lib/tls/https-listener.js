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

/**
 * Собрать https-сервер поверх готового приложения. Слушателей НЕ вешает — вызывать после
 * `app.ready()`/`app.listen()`, иначе плагин вебсокета ещё не зарегистрировал свой upgrade.
 */
export function buildHttpsServer({ app, key, cert }) {
  const server = https.createServer({ key, cert });
  server.on('request', (req, res) => app.routing(req, res));
  for (const listener of app.server.listeners('upgrade')) server.on('upgrade', listener);
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
}) {
  const server = buildHttpsServer({ app, key, cert });
  try {
    await new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      server.once('error', onError);
      server.listen(port, host, () => {
        server.removeListener('error', onError);
        resolve();
      });
    });
  } catch (err) {
    server.close();
    return { ok: false, error: err.message };
  }
  return { ok: true, server, port: server.address()?.port ?? port };
}
