// Область действия HTTP-сокета, когда рядом поднят HTTPS.
//
// Порт 8140 остаётся жить всегда — это внутренняя шина (MCP разрешений чата, `bin/b24`,
// `bin/restart`, dev-прокси Vite, шлюз с VPS). Но как только заработал https, отдавать по
// открытому http данные в СЕТЬ незачем: с loopback — полный доступ, из сети — только корневой
// сертификат (иначе его нечем установить) и `301` на https.
//
// Почему хуком, а не своим `http.Server`-обёрткой: хук проходит по тому же пути, что и гард
// авторизации, значит покрывает и upgrade вебсокета, и percent-encoded пути — Fastify матчит
// роут до хуков, и решение принимается по шаблону роута, а не по сырой строке.
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import type { TLSSocket } from 'node:tls';

import { decideHttpRequest } from '../lib/tls/local.ts';
import type { TlsRuntime } from '../lib/tls/local.ts';

export interface HttpScopeOptions {
  tlsRuntime: TlsRuntime;
}

/**
 * Хост без порта. Значение приходит из заголовка `Host`, то есть от клиента, поэтому
 * пропускаем только литеральный адрес или простое имя: в `Location` не должно уехать ничего,
 * что превратит редирект в переход на чужой сайт.
 */
export function redirectHost(rawHost: unknown): string {
  const value = String(rawHost || '').trim();
  if (!value) return '';
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end < 2) return '';
    const inner = value.slice(1, end);
    return /^[0-9a-fA-F:.]+$/.test(inner) ? `[${inner}]` : '';
  }
  const host = value.split(':')[0] ?? '';

  return /^[a-zA-Z0-9.-]+$/.test(host) ? host : '';
}

async function httpScopePlugin(fastify: FastifyInstance, opts: HttpScopeOptions): Promise<void> {
  const { tlsRuntime } = opts;

  fastify.addHook('onRequest', async (request, reply) => {
    // На https решать нечего; признак шифрования есть только у TLS-сокета.
    if ((request.socket as TLSSocket).encrypted) return;

    const decision = decideHttpRequest({
      // Адрес СОКЕТА, а не `request.ip`: за шлюзом `request.ip` — это клиент из
      // `X-Forwarded-For`, и запросы туннеля улетали бы в редирект на домашний адрес.
      remoteAddress: request.socket.remoteAddress,
      routeUrl: request.routeOptions?.url || '',
      httpsUp: !!tlsRuntime?.up,
      upgrade: !!request.raw.headers.upgrade,
    });
    if (decision === 'pass') return;

    if (decision === 'drop') {
      // Вебсокет по открытому http из сети — это PTY-шелл в открытом виде. Рвём соединение:
      // отвечать 301 бесполезно, `wss://` браузер сам не подставит.
      reply.hijack();
      request.raw.socket.destroy();
      return;
    }

    const host = redirectHost(request.headers.host);
    if (!host) {
      return reply.code(400).send({
        error: 'https_required',
        message: 'Кокпит в сети работает по HTTPS. Откройте адрес с https:// и портом сертификата.',
      });
    }
    return reply
      .code(301)
      .header('location', `https://${host}:${tlsRuntime.port ?? ''}${request.raw.url ?? ''}`)
      .send();
  });
}

export default fp(httpScopePlugin, { name: 'plugin-http-scope' });
