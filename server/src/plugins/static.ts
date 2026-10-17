// Статика: собранный фронт (web/dist) + артефакты приёмки из STATE_DIR (/shots).
// @fastify/static регистрируется несколько раз с разными префиксами; повторные — с
// decorateReply:false. shots создаём сами: иначе первый же скриншот, снятый после
// старта сервера, не раздавался бы до рестарта (роут регистрируется только на старте).
import fp from 'fastify-plugin';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

import { looksLikeApiPath } from './auth.ts';

export interface StaticPluginOptions {
  webDist: string;
  stateDir: string;
  uiReleasesDir?: string;
}

/**
 * Версии приложения имеют отдельные неизменяемые адреса и переживают замену рабочей сборки.
 * Рабочая SPA сохраняет собственный корень; отсутствующие ресурсы обеих сборок дают 404.
 */
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
      decorateReply: true,
      prefix: '/',
      cacheControl: false, // свой cache-control не ставим — управляем через setHeaders
      setHeaders(res, filePath) {
        const base = path.basename(filePath);
        // SW, воркбокс и манифест — всегда свежие, иначе обновления не подхватываются
        if (filePath.endsWith('.html') || base === 'sw.js'
          || base.startsWith('workbox-') || base.endsWith('.webmanifest')) {
          res.setHeader('Cache-Control', 'no-cache');
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    });
  } else if (!opts.uiReleasesDir) {
    fastify.log.warn(`web/dist не найден (${webDist}) — фронт не собран. Соберите: cd web && npm run build`);
  }

  if (opts.uiReleasesDir) {
    fs.mkdirSync(opts.uiReleasesDir, { recursive: true, mode: 0o700 });
    await fastify.register(fastifyStatic, {
      root: opts.uiReleasesDir,
      prefix: '/ui/',
      decorateReply: !fs.existsSync(webDist),
      cacheControl: false,
      allowedPath: (pathname) => /^\/?[a-f0-9]{64}(?:\/|$)/.test(pathname),
      setHeaders(res) {
        res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
        res.setHeader('X-Content-Type-Options', 'nosniff');
      },
    });
  }

  fastify.setNotFoundHandler((request, reply) => {
    let pathname = new URL(request.raw.url ?? '/', 'http://localhost').pathname;

    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      return reply.code(404).send({ error: 'not_found' });
    }

    // Отсутствующий ресурс не подменяется HTML: загрузчик должен увидеть честный отказ.
    // SPA-fallback нужен лишь старым адресам навигации рабочего интерфейса.
    if (looksLikeApiPath(request.raw.url) || /^\/(?:assets|ui)(?:\/|$)/.test(pathname)
      || path.extname(pathname) || !fs.existsSync(path.join(webDist, 'index.html'))
      || (request.method !== 'GET' && request.method !== 'HEAD')) {
      return reply.header('Cache-Control', 'no-store').code(404).send({ error: 'not_found' });
    }

    return reply.header('Cache-Control', 'no-cache').sendFile('index.html', webDist);
  });
}

export default fp(staticPlugin, { name: 'cockpit-static' });
