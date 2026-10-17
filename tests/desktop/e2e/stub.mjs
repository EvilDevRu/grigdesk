import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Заглушка обслуживает обычную сеть, popup, разрешения и запрет регистрации SW.
 * Тестовые ключи и cookie не попадают в журнал наблюдаемых HTTP-запросов.
 */
export async function startStub({
  port = 0,
  authKey = null,
  externalOrigin = 'http://127.0.0.1:9',
  packagedCookie = null,
  uiReleasesDir = null,
} = {}) {
  const sessions = new Set();
  const observations = {
    requests: [],
    exchanges: 0,
    swRequests: 0,
    probes: [],
    cookieSets: 0,
  };
  const links = {
    popup: 'https://desktop.example.invalid/popup',
    navigation: 'https://desktop.example.invalid/navigation',
    stand: externalOrigin + '/stand',
    redirect: 'https://desktop.example.invalid/redirect',
  };
  const server = createServer(async (request, response) => {
    try {
      await respond(request, response);
    } catch {
      response.writeHead(500);
      response.end('Ошибка тестовой фикстуры.');
    }
  });

  /**
   * Cookie заглушки разбирается только в памяти её собственного HTTP-сервера.
   * Для входа принимает лишь созданные этой фикстурой постоянные сессии.
   */
  function authenticated(request) {
    const cookie = request.headers.cookie ?? '';
    const value = cookie.match(/(?:^|;\s*)cockpit_sid=([^;]+)/u)?.[1];

    return sessions.has(value);
  }

  /**
   * HTML оставляет браузерные API настоящими и даёт действия с user activation.
   * Вторая страница и её потомок наблюдают общую cookie через сервер.
   */
  function html(request, second) {
    const cookiePresent = (request.headers.cookie ?? '').includes('stub-cookie=present');

    return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Кокпит — тестовое окно</title></head>
<body><h1 id="stub">Тестовое окно</h1>
<p id="kind">${second ? 'Дочернее окно' : 'Главное окно'}</p>
<p id="cookie">cookie:${cookiePresent ? 'yes' : 'no'}</p>
<a id="same" href="/second" target="_blank">Своё окно</a>
<a id="ext" href="${links.popup}" target="_blank">Внешнее окно</a>
<a id="nav-ext" href="${links.navigation}">Внешний переход</a>
<a id="stand" href="${links.stand}">Другой порт</a>
<a id="redirect" href="/redirect">Перенаправление</a>
<button id="notify">Разрешить уведомления</button>
<p id="notification-result"></p>
<script>
document.querySelector('#notify').onclick = async () => {
  document.querySelector('#notification-result').textContent = await Notification.requestPermission();
};
</script></body></html>`;
  }

  /**
   * Каждая ручка даёт наблюдаемый результат без обращения к живому Кокпиту.
   * SW остаётся валидным скриптом: отказ регистрации обязан обеспечивать приложение.
   */
  async function respond(request, response) {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;

    observations.requests.push({
      method: request.method,
      pathname,
      host: request.headers.host,
      authenticated: authenticated(request),
      packagedCookiePresent: packagedCookie !== null &&
        (request.headers.cookie ?? '').split(/;\s*/u).includes(`stub=${packagedCookie}`),
    });
    response.setHeader('Cache-Control', 'no-store');

    if (pathname === '/api/auth/state') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({
        configured: Boolean(authKey),
        authenticated: authenticated(request),
      }));
    } else if (pathname === '/api/auth/window-session' && request.method === 'POST') {
      observations.exchanges += 1;

      if (!authKey || request.headers['x-cockpit-window-key'] !== authKey) {
        response.writeHead(401);
        response.end('{}');

        return;
      }

      const id = randomBytes(24).toString('base64url');

      sessions.add(id);
      response.setHeader('Content-Type', 'application/json');
      response.setHeader('Set-Cookie', `cockpit_sid=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
      response.end('{}');
    } else if (/^\/ui\/[a-f0-9]{64}\/release\.json$/.test(pathname) && uiReleasesDir) {
      if (!authenticated(request)) {
        response.writeHead(401);
        response.end('{}');

        return;
      }

      response.setHeader('Content-Type', 'application/json');
      response.end(await readFile(path.join(uiReleasesDir, pathname.slice(4))));
    } else if (pathname === '/' || pathname === '/second' || /^\/ui\/[a-f0-9]{64}\/$/.test(pathname)) {
      if (!authenticated(request)) {
        response.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end('<h1>Кокпит открывается в приложении</h1>');

        return;
      }

      response.setHeader('Content-Type', 'text/html; charset=utf-8');

      if (packagedCookie !== null) {
        if (observations.cookieSets === 0) {
          response.setHeader('Set-Cookie',
            `stub=${packagedCookie}; Max-Age=3600; Path=/; HttpOnly; SameSite=Lax`);
          observations.cookieSets += 1;
        }

        response.end(`<!doctype html><html lang="ru"><meta charset="utf-8">
<title>Кокпит — пакетная проверка</title><body><h1>Пакетная проверка</h1><script>
(async () => {
  await fetch('/probe/loaded', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      origin: location.origin,
      requireType: typeof require,
      processType: typeof process,
    }),
  });
  window.close();
})();
</script></body></html>`);
      } else {
        response.setHeader('Set-Cookie', 'stub-cookie=present; Path=/; SameSite=Lax; Max-Age=86400');
        response.end(html(request, pathname === '/second'));
      }
    } else if (pathname === '/assets/probe.js') {
      response.setHeader('Content-Type', 'application/javascript');
      response.end('globalThis.desktopNetworkProbe = "loaded";');
    } else if (pathname === '/sw.js') {
      observations.swRequests += 1;
      response.setHeader('Content-Type', 'application/javascript');
      response.end('self.addEventListener("install", () => self.skipWaiting());');
    } else if (pathname === '/redirect') {
      response.writeHead(302, { Location: links.redirect });
      response.end();
    } else if (pathname === '/probe/loaded' && request.method === 'POST') {
      let body = '';

      for await (const chunk of request) {
        body += chunk;
      }

      observations.probes.push(JSON.parse(body));
      response.end('{}');
    } else {
      response.writeHead(404);
      response.end();
    }
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  const address = `http://127.0.0.1:${server.address().port}`;

  /**
   * Остановка принадлежит конкретному server и дожидается закрытия listener.
   * Тест закрывает Electron раньше, поэтому удаление профиля не гоняется с сетью.
   */
  async function close() {
    if (!server.listening) {
      return;
    }

    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  return {
    server,
    address,
    observations,
    links,
    close,
    revokeSessions: () => sessions.clear(),
  };
}
