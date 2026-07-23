// Статика: собранный фронт (web/dist) + артефакты приёмки из STATE_DIR (/shots, /demo).
// @fastify/static регистрируется несколько раз с разными префиксами; повторные — с
// decorateReply:false. Каждый корень регистрируем только если он существует, иначе
// плагин бросит на старте (dist может быть не собран, shots/demo — не созданы).
import fp from 'fastify-plugin';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';

async function staticPlugin(fastify, opts) {
  const { webDist, stateDir } = opts;

  const shotsDir = path.join(stateDir, 'shots');
  const demoDir = path.join(stateDir, 'demo');

  if (fs.existsSync(shotsDir)) {
    await fastify.register(fastifyStatic, { root: shotsDir, prefix: '/shots/', decorateReply: false });
  }
  if (fs.existsSync(demoDir)) {
    await fastify.register(fastifyStatic, { root: demoDir, prefix: '/demo/', decorateReply: false });
  }

  // Фронт — последним, на корне. SPA-fallback: неизвестные не-API пути → index.html.
  // Кеш: index.html — no-cache (иначе старый html держит ссылки на старые ассеты);
  // хешированные ассеты (/assets/*) — immutable навсегда.
  if (fs.existsSync(webDist)) {
    await fastify.register(fastifyStatic, {
      root: webDist,
      prefix: '/',
      cacheControl: false, // свой cache-control не ставим — управляем через setHeaders
      setHeaders(res, filePath) {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
        else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
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
