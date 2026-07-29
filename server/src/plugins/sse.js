// Плагин SSE — push-обновления окну вместо polling'а.
// `fs.watch` на STATE_DIR (с дебаунсом) → рассылка события `state-change` всем клиентам.
// Эндпоинт: GET /api/events (text/event-stream).
import fp from 'fastify-plugin';
import fs from 'node:fs';

async function ssePlugin(fastify, opts) {
  const stateDir = opts.stateDir;
  /** @type {Set<import('node:http').ServerResponse>} */
  const clients = new Set();

  function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      try { res.write(payload); } catch { /* мёртвый клиент уберётся на close */ }
    }
  }
  fastify.decorate('sse', { broadcast });

  // Дебаунс: файловые изменения приходят пачками, шлём не чаще раза в 300 мс.
  let timer = null;
  let watcher = null;
  try {
    watcher = fs.watch(stateDir, () => {
      if (timer) return;
      timer = setTimeout(() => { timer = null; broadcast('state-change', { at: Date.now() }); }, 300);
    });
  } catch (err) {
    fastify.log.warn(`fs.watch на ${stateDir} не запущен: ${err.message}`);
  }

  fastify.get('/api/events', (request, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      // Поток сигнализирует в том числе об изменении приватных review-данных.
      // Прокси и браузер не должны сохранять его тело даже как revalidation-cache.
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
    clients.add(res);

    // keep-alive пинг раз в 25 с (чтобы прокси не рвали соединение)
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* закроется */ } }, 25000);

    request.raw.on('close', () => { clearInterval(ping); clients.delete(res); });
  });

  fastify.addHook('onClose', async () => {
    if (timer) clearTimeout(timer);
    if (watcher) watcher.close();
    for (const res of clients) { try { res.end(); } catch { /* уже закрыт */ } }
    clients.clear();
  });
}

export default fp(ssePlugin, { name: 'cockpit-sse' });
