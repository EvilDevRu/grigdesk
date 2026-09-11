// Плагин SSE — push-обновления окну вместо polling'а.
// `fs.watch` на единственном каталоге состояния → рассылка события
// `state-change` всем клиентам. Эндпоинт: GET /api/events (text/event-stream).
// Наружу: `sse.broadcast(name, payload)`, `sse.subscribe(listener)` и `sse.clientCount()` —
// сколько окон держат поток прямо сейчас.
import fp from 'fastify-plugin';
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';

export interface SsePluginOptions {
  stateDir: string;
}

type SseListener = (event: string, data?: unknown) => void;

async function ssePlugin(fastify: FastifyInstance, opts: SsePluginOptions): Promise<void> {
  const stateDir = opts.stateDir;
  const clients = new Set<ServerResponse>();
  // In-process слушатели тех же событий, что уезжают окнам: телеграм-пульт получает
  // state-change/chat-* без второго watcher-а. Ошибка слушателя не рвёт рассылку.
  const listeners = new Set<SseListener>();

  /** Одно событие всем: и открытым вкладкам, и внутренним слушателям процесса. */
  function broadcast(event: string, data?: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      try { res.write(payload); } catch { /* мёртвый клиент уберётся на close */ }
    }
    for (const listener of listeners) {
      try { listener(event, data); } catch { /* слушатель сам отвечает за себя */ }
    }
  }
  function subscribe(listener: SseListener): () => void {
    listeners.add(listener);

    return () => {
      listeners.delete(listener);
    };
  }
  // Сколько окон держат поток. Слушатели процесса (пульт) не в счёте: они подписаны
  // всегда, и фоновой работе по ним не отличить «никто не смотрит» от «смотрят все».
  function clientCount(): number {
    return clients.size;
  }

  fastify.decorate('sse', { broadcast, subscribe, clientCount });

  // Файловые изменения приходят пачками, шлём не чаще
  // раза в 300 мс. Событие безадресное («что-то изменилось»), поэтому склейка законна.
  let timer: NodeJS.Timeout | null = null;
  let watcher: fs.FSWatcher | null = null;
  const onChange = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      broadcast('state-change', { at: Date.now() });
    }, 300);
  };
  // Каталога может ещё не быть — сервер остаётся доступен, но пишет явное предупреждение.
  try {
    watcher = fs.watch(stateDir, onChange);
  } catch (err) {
    const reason = String((err as { message?: unknown } | null)?.message || err);

    fastify.log.warn(`fs.watch на ${stateDir} не запущен: ${reason}`);
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
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* закроется */
      }
    }, 25000);

    request.raw.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
  });

  fastify.addHook('onClose', async () => {
    if (timer) clearTimeout(timer);
    watcher?.close();
    for (const res of clients) {
      try {
        res.end();
      } catch {
        /* уже закрыт */
      }
    }
    clients.clear();
  });
}

export default fp(ssePlugin, { name: 'cockpit-sse' });
