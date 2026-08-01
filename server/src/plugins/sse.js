// Плагин SSE — push-обновления окну вместо polling'а.
// `fs.watch` на КАЖДОМ каталоге состояния (с общим дебаунсом) → рассылка события
// `state-change` всем клиентам. Эндпоинт: GET /api/events (text/event-stream).
import fp from 'fastify-plugin';
import fs from 'node:fs';

async function ssePlugin(fastify, opts) {
  // Каталогов больше одного: legacy-состояние и state-v2 живут раздельно (движок
  // требует непересечения). Смотреть надо за всеми, иначе задачи одного поколения
  // молча остаются без push-обновлений.
  const stateDirs = [...new Set((opts.stateDirs || [opts.stateDir]).filter(Boolean))];
  /** @type {Set<import('node:http').ServerResponse>} */
  const clients = new Set();

  function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      try { res.write(payload); } catch { /* мёртвый клиент уберётся на close */ }
    }
  }
  fastify.decorate('sse', { broadcast });

  // Дебаунс общий на все каталоги: файловые изменения приходят пачками, шлём не чаще
  // раза в 300 мс. Событие безадресное («что-то изменилось»), поэтому склейка законна.
  let timer = null;
  const watchers = [];
  const onChange = () => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; broadcast('state-change', { at: Date.now() }); }, 300);
  };
  for (const dir of stateDirs) {
    // Каталога может не быть (поколение ещё не заводили) — это не повод падать,
    // но и не повод молчать: без watcher'а окно живёт до ручной перезагрузки.
    try {
      watchers.push(fs.watch(dir, onChange));
    } catch (err) {
      fastify.log.warn(`fs.watch на ${dir} не запущен: ${err.message}`);
    }
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
    for (const watcher of watchers) watcher.close();
    for (const res of clients) { try { res.end(); } catch { /* уже закрыт */ } }
    clients.clear();
  });
}

export default fp(ssePlugin, { name: 'cockpit-sse' });
