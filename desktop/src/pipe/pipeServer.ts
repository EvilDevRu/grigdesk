import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { timingSafeEqual } from 'node:crypto';
import type { ApiVersion } from '../../../shared/client/clientShell.ts';
import { staticUi } from './staticUi.ts';

export interface PipeUpstream {
  request(req: IncomingMessage, res: ServerResponse): void | Promise<void>;
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  state(): unknown;
  close?(): void;
}

export interface ShellHandler {
  handle(req: IncomingMessage, res: ServerResponse): void | Promise<void>;
}

export interface PipeOptions {
  port: number;
  uiDir: string;
  secret: string;
  appApi: ApiVersion;
  upstream: PipeUpstream | null;
  shell?: ShellHandler;
}

/**
 * Ответы управления не кэшируются и имеют единый JSON-тип.
 * Помощник не пишет тела запросов и секреты в журнал.
 */
export function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

/**
 * Cookie сравнивается без зависимости времени от общего префикса секрета.
 * Проверка Host и Origin удерживает все запросы в origin данного профиля.
 */
function authorized(req: IncomingMessage, origin: string, secret: string): boolean {
  const expected = Buffer.from(secret);
  const cookies = req.headers.cookie?.split(';').map((value) => value.trim()) ?? [];
  const site = req.headers['sec-fetch-site'];
  const cookieMatches = cookies.some((value) => {
    if (!value.startsWith('grigdesk_pipe=')) {
      return false;
    }

    const actual = Buffer.from(value.slice('grigdesk_pipe='.length));

    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });

  return Boolean(req.url?.startsWith('/') && !req.url.startsWith('//'))
    && req.headers.host === new URL(origin).host
    && (!req.headers.origin || req.headers.origin === origin)
    && (site === undefined || site === 'same-origin' || site === 'none') && cookieMatches;
}

/**
 * Каждая труба слушает только loopback, а все её пути закрыты одним секретом запуска.
 * Повреждение пакета оставляет доступную диагностику вместо загрузки неверных файлов.
 */
export async function startPipe(options: PipeOptions) {
  let serve: Awaited<ReturnType<typeof staticUi>> | null = null;

  try {
    serve = await staticUi(options.uiDir);
  } catch {
    // Состояние доступно даже при повреждении статического пакета.
  }

  let origin = '';
  const sockets = new Set<Duplex>();
  const server = http.createServer((req, res) => {
    if (!authorized(req, origin, options.secret)) {
      json(res, 403, { error: 'pipe_forbidden' });

      return;
    }

    const pathname = new URL(req.url || '/', origin).pathname;

    if (pathname.startsWith('/__shell/')) {
      if (options.shell) {
        void Promise.resolve(options.shell.handle(req, res)).catch(() => {
          if (!res.headersSent) {
            json(res, 500, { error: 'shell_error', message: 'Не удалось выполнить действие.' });
          }
        });
      } else {
        json(res, 200, {
          rev: 0,
          status: 'none',
          detail: serve ? null : 'Установка повреждена',
        });
      }
    } else if (pathname.startsWith('/api/') || pathname.startsWith('/shots/')) {
      if (options.upstream) {
        void options.upstream.request(req, res);
      } else {
        json(res, 503, { error: 'no_machine' });
      }
    } else if (serve) {
      serve(req, res);
    } else {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>Установка повреждена</h1><p>Переустановите приложение.</p>');
    }
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (req, socket, head) => {
    if (!authorized(req, origin, options.secret)
      || !new URL(req.url || '/', origin).pathname.startsWith('/api/')) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');

      return;
    }

    if (options.upstream) {
      options.upstream.upgrade(req, socket, head);
    } else {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  return {
    origin,
    async close() {
      options.upstream?.close?.();

      for (const socket of sockets) {
        socket.destroy();
      }

      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
