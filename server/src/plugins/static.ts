// Сервер обслуживает API, страницы плагинов и закрытые артефакты приёмки.
// Полный интерфейс приложения хранится в оболочке и не зависит от web/dist сервера.
import fp from 'fastify-plugin';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

import { APPLICATION_PAGE, looksLikeApiPath } from './auth.ts';

export interface StaticPluginOptions {
  stateDir: string;
}

/**
 * Снимки остаются закрыты общим гардом; каталог существует уже при регистрации.
 * Неизвестный документ объясняет запуск приложения, а ресурс получает честный JSON 404.
 */
async function staticPlugin(fastify: FastifyInstance, opts: StaticPluginOptions): Promise<void> {
  const shotsDir = path.join(opts.stateDir, 'shots');

  fs.mkdirSync(shotsDir, { recursive: true });
  await fastify.register(fastifyStatic, { root: shotsDir, prefix: '/shots/', decorateReply: false });

  fastify.setNotFoundHandler((request, reply) => {
    let pathname: string;

    try {
      pathname = decodeURIComponent(new URL(request.raw.url ?? '/', 'http://localhost').pathname);
    } catch {
      return reply.header('Cache-Control', 'no-store').code(404).send({ error: 'not_found' });
    }

    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');

    if ((request.method === 'GET' || request.method === 'HEAD')
      && request.headers.accept?.includes('text/html') && !looksLikeApiPath(request.raw.url)
      && !/^\/(?:api|assets|ui|shots)(?:\/|$)/.test(pathname) && !path.extname(pathname)) {
      return reply.type('text/html; charset=utf-8').send(APPLICATION_PAGE);
    }

    return reply.code(404).send({ error: 'not_found' });
  });
}

export default fp(staticPlugin, { name: 'grigdesk-static' });
