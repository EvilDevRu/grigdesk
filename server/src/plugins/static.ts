// Статика: собранный фронт (web/dist) + артефакты приёмки из STATE_DIR (/shots).
// @fastify/static регистрируется несколько раз с разными префиксами; повторные — с
// decorateReply:false. shots создаём сами: иначе первый же скриншот, снятый после
// старта сервера, не раздавался бы до рестарта (роут регистрируется только на старте).
import fp from 'fastify-plugin';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

export interface StaticPluginOptions {
  webDist: string;
  stateDir: string;
}

async function staticPlugin(fastify: FastifyInstance, opts: StaticPluginOptions): Promise<void> {
  const { webDist, stateDir } = opts;

  const shotsDir = path.join(stateDir, 'shots');
  fs.mkdirSync(shotsDir, { recursive: true });

  await fastify.register(fastifyStatic, { root: shotsDir, prefix: '/shots/', decorateReply: false });

  // Фронт — последним, на корне. SPA-fallback: неизвестные не-API пути → index.html.
  // Кеш: index.html — no-cache (иначе старый html держит ссылки на старые ассеты);
  // хешированные ассеты (/assets/*) — immutable навсегда.
  if (fs.existsSync(webDist)) {
    await fastify.register(fastifyStatic, {
      root: webDist,
      prefix: '/',
      cacheControl: false, // свой cache-control не ставим — управляем через setHeaders
      setHeaders(res, filePath) {
        const base = path.basename(filePath);
        // SW, воркбокс и манифест — всегда свежие, иначе обновления не подхватываются
        if (filePath.endsWith('.html') || base === 'sw.js' || base.startsWith('workbox-') || base.endsWith('.webmanifest')) {
          res.setHeader('Cache-Control', 'no-cache');
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    });
    fastify.setNotFoundHandler((request, reply) => {
      if (request.raw.url && request.raw.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    });
  } else {
    fastify.log.warn(`web/dist не найден (${webDist}) — фронт не собран. Соберите: cd web && npm run build`);
  }
}

export default fp(staticPlugin, { name: 'cockpit-static' });
