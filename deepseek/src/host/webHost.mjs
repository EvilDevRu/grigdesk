// Loopback-корень сохраняет штатную cookie authorization без browser application.
// Авторизация и RPC принадлежат исходному Connection service.

export const name = 'grigdesk-web-host';
export const inject = ['webServer', 'connection'];

/**
 * Только корневой GET участвует в штатном обмене process token на cookie.
 * Неизвестные пути остаются 404; host не публикует новую страницу или API.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.registerFallback((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');

    if (url.pathname !== '/' || !['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(404);
      response.end();

      return;
    }

    if (!ctx.connection.authorizeIndex(request, response)) {
      return;
    }

    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(request.method === 'HEAD' ? '' : '{"ok":true}\n');
  }), 'grigdesk-web-host: authentication root');
}
