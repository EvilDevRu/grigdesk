export const name = 'grigdesk-web-host';
export const inject = ['webServer'];

/**
 * Корневой запрос после обмена токена проверяет cookie через штатный webserver.
 * HTTP API и все остальные пути принадлежат исходным маршрутам Harness.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/',
    auth: 'required',
    /**
     * Отвечает только на чтение, после проверки авторизации маршрута самим webserver.
     * Ответ HEAD сохраняет заголовки GET и опускает тело.
     */
    handler(request, response) {
      if (!['GET', 'HEAD'].includes(request.method)) {
        response.writeHead(405, { allow: 'GET, HEAD' });
        response.end();

        return;
      }

      response.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      response.end(request.method === 'HEAD' ? undefined : '{"ok":true}\n');
    },
  }), 'grigdesk-web-host: корень после авторизации');
}
