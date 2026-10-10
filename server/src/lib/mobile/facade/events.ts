import type { MobileApp } from '../mobileServer.ts';
import { record } from './common.ts';
import type { FacadeDeps } from './common.ts';

const CHAT_KINDS: Record<string, string> = {
  'chat-turn-start': 'turn-start',
  'chat-queued': 'queued',
  'chat-done': 'done',
  'chat-orphan': 'done',
  'chat-assistant-message': 'message',
  'chat-store': 'message',
  'chat-store-meta': 'message',
};
const WAITING = new Set([
  'chat-permission',
  'chat-question',
  'chat-permission-done',
  'permission-waiting',
  'permission-done',
  'question-waiting',
  'question-done',
  'chat-waiting',
]);

type Options = {
  subscribe: FacadeDeps['subscribe'];
  write: (frame: string) => boolean;
  end: () => void;
};

/**
 * SSE передаёт только bounded сигналы перечитывания, без текста разговоров и аргументов инструментов.
 * Slow consumer закрывается при первом backpressure; timers и подписка имеют одного владельца.
 */
export class MobileEventStream {
  private options: Options;
  private unsubscribe = () => {};
  private heartbeat?: ReturnType<typeof setInterval>;
  private tasks?: ReturnType<typeof setTimeout>;
  private progress = new Map<string, ReturnType<typeof setTimeout>>();
  private closed = false;

  constructor(options: Options) {
    this.options = options;
    this.send('ready', { api: 1 });

    if (this.closed) {
      return;
    }

    const unsubscribe = options.subscribe((name, payload) => this.event(name, payload));

    if (this.closed) {
      unsubscribe();

      return;
    }

    this.unsubscribe = unsubscribe;
    this.heartbeat = setInterval(() => this.send('heartbeat', {}), 15000);
    this.heartbeat.unref?.();
  }

  /**
   * Не накапливает собственную очередь поверх TCP writable buffer.
   * Неудачная запись немедленно освобождает listener и закрывает соединение.
   */
  private send(name: string, payload: unknown) {
    if (this.closed) {
      return;
    }

    try {
      if (!this.options.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`)) {
        this.close();
      }
    } catch {
      this.close();
    }
  }

  /**
   * Progress склеивается отдельно на каждый чат; итог и ожидание человека не задерживаются.
   * Идентификатор служит только ресурсным сигналом и проверяется до помещения в bounded map.
   */
  private event(name: string, payload: unknown) {
    if (this.closed) {
      return;
    }

    const data = record(payload);
    const chatId = name === 'chat-store' ? data.id : data.chatKey;
    const validChat = typeof chatId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(chatId);

    const message = CHAT_KINDS[name] === 'message';
    const progress = name === 'chat-step' || name === 'chat-progress';
    const throttleKey = `${message ? 'message' : 'progress'}:${validChat ? chatId : 'all'}`;

    if (progress || message) {
      if ((!validChat && !message) || this.progress.has(throttleKey)) {
        return;
      }
      if (this.progress.size >= 256) {
        this.close();

        return;
      }

      const timer = setTimeout(() => {
        this.progress.delete(throttleKey);

        if (validChat) {
          this.send('chat', {
            chatId,
            kind: message ? 'message' : 'progress',
          });
        } else {
          this.send('chats', {});
        }
      }, 1000);

      timer.unref?.();
      this.progress.set(throttleKey, timer);
    } else if (CHAT_KINDS[name]) {
      if (validChat) {
        this.send('chat', {
          chatId,
          kind: CHAT_KINDS[name],
        });
      }
    } else if (WAITING.has(name)) {
      this.send('waiting', {});
    } else if (name === 'state-change' && !this.tasks) {
      this.tasks = setTimeout(() => {
        this.tasks = undefined;
        this.send('tasks', {});
      }, 2000);
      this.tasks.unref?.();
    }
  }

  /**
   * Закрытие идемпотентно и используется для disconnect, revoke, shutdown и переполнения.
   * После него отложенные callbacks не пишут в завершённый socket.
   */
  close() {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.unsubscribe();
    clearInterval(this.heartbeat);
    clearTimeout(this.tasks);

    for (const timer of this.progress.values()) {
      clearTimeout(timer);
    }

    this.progress.clear();
    this.options.end();
  }
}

/**
 * Использует общую in-process подписку Кокпита, не добавляя watcher или второй источник событий.
 * Закрытие TLS при отзыве телефона автоматически снимает эту подписку.
 */
export function registerEventRoutes(app: MobileApp, deps: Pick<FacadeDeps, 'subscribe'>) {
  const streams = new Set<MobileEventStream>();

  app.get('/api/mobile/v1/events', (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });

    const stream = new MobileEventStream({
      subscribe: deps.subscribe,
      write: (frame) => reply.raw.write(frame),
      end: () => {
        reply.raw.destroy();
      },
    });

    streams.add(stream);
    reply.raw.once('close', () => {
      stream.close();
      streams.delete(stream);
    });
  });
  app.addHook('onClose', async () => {
    for (const stream of streams) {
      stream.close();
    }

    streams.clear();
  });
}
