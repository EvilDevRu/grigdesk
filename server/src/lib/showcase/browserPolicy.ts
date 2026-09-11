// Политика браузера: что разрешено записывающему браузеру и как это обеспечивается.
//
// Изоляцию даёт ОТДЕЛЬНЫЙ ограничивающий прокси, а не перехват запросов страницы.
// Опытный прогон захода 0 это и проверял: при выключенном перехвате прокси один
// отклонил все попытки выхода (запрос, картинка, кадр, редирект и WebSocket),
// а при выключенном прокси те же попытки дошли до сервера-мишени. Перехват
// остаётся вторым слоем правил — он проверяет метод и назначение уже разрешённого
// адреса, но обещанием изоляции не является: запросы мимо страницы он не видит.
//
// Ключ `--proxy-bypass-list=<-loopback>` обязателен. Без него Chromium ходит на
// 127.0.0.1 напрямую, и вся проверка границы становится фикцией — а стенды показа
// как раз и живут на loopback.
import dns from 'node:dns/promises';
import http from 'node:http';
import net from 'node:net';

export interface BrowserPolicy {
  allowedOrigins: string[];
  allowedMethods: string[];
}

export interface EgressAttempt {
  kind: 'request' | 'connect';
  target: string;
  at: string;
}

/**
 * Правило allowlist — пара host:port. Порт по умолчанию проставляется заранее:
 * обычный запрос приходит с именем без порта, а CONNECT — всегда с портом, и
 * сравнение строк иначе разошлось бы между этими двумя путями.
 */
function ruleOf(origin: string): string {
  const url = new URL(origin);

  return `${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`;
}

export function browserLaunchArgs(proxyPort: number): string[] {
  return [
    `--proxy-server=http://127.0.0.1:${proxyPort}`,
    // Без этого ключа loopback идёт мимо прокси.
    '--proxy-bypass-list=<-loopback>',
    // UDP мимо прокси — известный обходной путь WebRTC. Запись его не использует,
    // поэтому он выключается на запуске, а не проверяется правилами HTTP.
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--no-first-run',
    '--no-default-browser-check',
  ];
}

/**
 * Ограничивающий выход в сеть. Живёт рядом с браузером на время задания и знает
 * только адреса объявленной политики. Отклонённые попытки копятся в журнале —
 * приёмка сетевой границы читается по нему, а не по тому, что страница поймала
 * в catch: пойманное исключение доказывает лишь неудачу конкретного вызова.
 */
export async function startEgressGuard(policy: BrowserPolicy) {
  const allowed = new Set(policy.allowedOrigins.map(ruleOf));
  const blocked: EgressAttempt[] = [];
  const passed: EgressAttempt[] = [];

  // Адрес закрепляется за именем на всё задание. Повторное разрешение имени и
  // редирект не расширяют область: соединение идёт на тот адрес, который был
  // проверен, а не на тот, который DNS вернёт в момент запроса.
  const pinned = new Map<string, string>();

  async function addressOf(host: string): Promise<string> {
    if (net.isIP(host)) {
      return host;
    }

    const known = pinned.get(host);

    if (known) {
      return known;
    }

    const { address } = await dns.lookup(host);

    pinned.set(host, address);

    return address;
  }

  function isAllowed(host: string, port: string): boolean {
    return allowed.has(`${host}:${port}`);
  }

  const server = http.createServer(async (request, response) => {
    let target: URL | null = null;

    try {
      target = new URL(request.url ?? '');
    } catch {
      target = null;
    }

    const host = target?.hostname ?? '';
    const port = target?.port || (target?.protocol === 'https:' ? '443' : '80');
    // OPTIONS — preflight: вопрос браузера «можно ли», а не действие страницы.
    // Без него не состоится ни один cross-origin запрос с заголовком авторизации,
    // а мутации всё равно останавливает проверка самого метода.
    const method = request.method ?? '';
    const allowedMethod = policy.allowedMethods.includes(method) || method === 'OPTIONS';

    if (!target || !isAllowed(host, port) || !allowedMethod) {
      blocked.push({ kind: 'request', target: String(request.url), at: new Date().toISOString() });
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('egress запрещён политикой показа');

      return;
    }

    passed.push({ kind: 'request', target: String(request.url), at: new Date().toISOString() });

    const address = await addressOf(host).catch(() => host);
    const upstream = http.request({
      host: address,
      port,
      method: request.method,
      path: target.pathname + target.search,
      headers: request.headers,
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });

    upstream.on('error', () => {
      response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('адрес показа недоступен');
    });

    request.pipe(upstream);
  });

  // CONNECT — это и TLS, и WebSocket, и попытка туннеля в обход правил HTTP.
  // Отказ закрывает сокет: ответить «200 Connection Established» и надеяться на
  // проверку выше по стеку значило бы отдать туннель до проверки назначения.
  server.on('connect', async (request, socket, head) => {
    const [host, rawPort] = String(request.url ?? '').split(':');
    const port = rawPort || '443';

    if (!host || !isAllowed(host, port)) {
      blocked.push({ kind: 'connect', target: String(request.url), at: new Date().toISOString() });
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');

      return;
    }

    passed.push({ kind: 'connect', target: String(request.url), at: new Date().toISOString() });

    const address = await addressOf(host).catch(() => host);
    const upstream = net.connect(Number(port), address, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });

    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('ограничитель сети не занял порт');
  }

  return {
    port: address.port,
    blocked,
    passed,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
    }),
  };
}

export type EgressGuard = Awaited<ReturnType<typeof startEgressGuard>>;
