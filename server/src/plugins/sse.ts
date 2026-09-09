// Плагин SSE — push-обновления окну вместо polling'а.
// `fs.watch` на единственном каталоге состояния → рассылка события
// `state-change` всем клиентам. Эндпоинт: GET /api/events (text/event-stream).
import fp from 'fastify-plugin';
import fs from 'node:fs';

async function ssePlugin(fastify, opts) {
  const stateDir = opts.stateDir;
  /** @type {Set<import('node:http').ServerResponse>} */
  const clients = new Set();
  // In-process слушатели тех же событий, что уезжают окнам: телеграм-пульт получает
  // state-change/chat-* без второго watcher-а. Ошибка слушателя не рвёт рассылку.
  const listeners = new Set();

  function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      try { res.write(payload); } catch { /* мёртвый клиент уберётся на close */ }
    }
    for (const listener of listeners) {
      try { listener(event, data); } catch { /* слушатель сам отвечает за себя */ }
    }
  }
  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
  fastify.decorate('sse', { broadcast, subscribe });

  // Файловые изменения приходят пачками, шлём не чаще
  // раза в 300 мс. Событие безадресное («что-то изменилось»), поэтому склейка законна.
  let timer = null;
  let watcher = null;
  const onChange = () => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; broadcast('state-change', { at: Date.now() }); }, 300);
  };
  // Каталога может ещё не быть — сервер остаётся доступен, но пишет явное предупреждение.
  try {
    watcher = fs.watch(stateDir, onChange);
  } catch (err) {
    fastify.log.warn(`fs.watch на ${stateDir} не запущен: ${err.message}`);
  }

  fastify.get('/api/events', (request, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
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
    watcher?.close();
    for (const res of clients) { try { res.end(); } catch { /* уже закрыт */ } }
    clients.clear();
  });
}

export default fp(ssePlugin, { name: 'cockpit-sse' });
