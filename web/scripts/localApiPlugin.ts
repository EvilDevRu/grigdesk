import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Plugin } from 'vite';

import { windowKeyPath } from '../../shared/desktop/windowKeyPath.ts';
import { readWindowKey } from '../../desktop/src/autoLogin.ts';
import { createUpstream } from '../../desktop/src/pipe/upstream.ts';
import { json } from '../../desktop/src/pipe/pipeServer.ts';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Авторизованный dev-вход принимает только свой loopback origin и локальный сокет.
 * Проверка выполняется до обмена ключа и запрещает DNS rebinding и cross-origin ввод.
 */
function allowed(req: IncomingMessage, port: number): boolean {
  if (!LOOPBACK_PEERS.has(req.socket.remoteAddress ?? '')
    || !req.url?.startsWith('/') || req.url.startsWith('//')) {
    return false;
  }

  try {
    const origin = new URL(`http://${req.headers.host}`);
    const site = req.headers['sec-fetch-site'];

    return LOOPBACK_HOSTS.has(origin.hostname) && origin.host === req.headers.host
      && Number(origin.port || 80) === port
      && (!req.headers.origin || req.headers.origin === origin.origin)
      && (site === undefined || site === 'same-origin' || site === 'none');
  } catch {
    return false;
  }
}

/**
 * Проксируются только прежние прикладные пути; Vite и его HMR остаются владельцами статики.
 * URL с внешним authority не может переопределить фиксированную машину upstream.
 */
function proxied(req: IncomingMessage): boolean {
  return /^\/(?:api|shots|vscode)(?:\/|\?|$)/u.test(req.url ?? '');
}

/**
 * Dev-сервер входит тем же локальным ключом, что приложение, без передачи секрета странице.
 * Общий upstream сохраняет потоковые ответы, WebSocket и запрет повторной отправки мутаций.
 */
export default function localApiPlugin(options: {
  port: number;
  env: Record<string, string | undefined>;
}): Plugin {
  return {
    name: 'grigdesk-local-api',
    apply: 'serve',
    /**
     * Вход ограничен loopback даже при переопределении адреса Vite через CLI.
     * Проверки HTTP и upgrade используют реальный порт уже слушающего сервера.
     */
    configureServer(server) {
      const host = server.config.server.host;

      if (server.config.server.https || host === true
        || typeof host === 'string' && host !== '::1' && !LOOPBACK_HOSTS.has(host)) {
        throw new Error('Авторизованный dev-интерфейс GrigDesk доступен только на loopback HTTP.');
      }

      const keyFile = windowKeyPath({
        env: options.env,
        uid: process.getuid?.(),
        port: options.port,
      });
      const upstream = createUpstream({
        address: `http://127.0.0.1:${options.port}`,
        windowKey: async () => await readWindowKey(keyFile) ?? '',
      });
      const port = () => (server.httpServer?.address() as AddressInfo | null)?.port ?? 0;

      server.middlewares.use((req, res, next) => {
        res.setHeader('X-Frame-Options', 'DENY');

        if (!proxied(req)) {
          next();

          return;
        }

        if (!allowed(req, port())) {
          json(res, 403, { error: 'dev_origin_forbidden' });

          return;
        }

        void upstream.request(req, res);
      });
      server.httpServer?.on('upgrade', (req, socket, head) => {
        if (!proxied(req)) {
          return;
        }

        if (!allowed(req, port())) {
          socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');

          return;
        }

        upstream.upgrade(req, socket, head);
      });
      server.httpServer?.once('close', () => upstream.close());
    },
  };
}
