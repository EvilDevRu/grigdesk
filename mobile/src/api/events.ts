import type { GrigDeskLink, Listener } from '../link/types.ts';

/**
 * SSE reconnect и watchdog принадлежат native; JS только принимает сигналы invalidate.
 * ready вызывает одну сверку, heartbeat ничего не меняет в продуктовых данных.
 */
export class LinkEvents {
  private listeners: Listener[] = [];
  private start: Promise<void> | null = null;
  private link: GrigDeskLink;
  private generation: () => number;
  private epoch = 0;

  constructor(link: GrigDeskLink, generation: () => number) {
    this.link = link;
    this.generation = generation;
  }

  /**
   * Параллельные mount не создают два потока; устаревшие события отбрасываются до parsing.
   * Некорректная схема останавливает поток до явного действия человека.
   */
  listen(signal: (name: string, data: any) => void, state: (value: any) => void, activate = true) {
    if (this.start) {
      return this.start;
    }

    const captured = this.epoch;

    this.start = (async () => {
      const stateListener = await this.link.addListener('linkState', (value) => {
        if (captured === this.epoch) {
          state(value);
        }
      });
      const eventListener = await this.link.addListener('linkEvent', (event) => {
        if (captured !== this.epoch) {
          return;
        }
        if (event.generation !== this.generation() || event.name === 'heartbeat') {
          return;
        }

        try {
          const data = JSON.parse(event.data);

          if (event.name === 'ready' && data.api !== 1) {
            void this.link.stopEvents();
            state({ state: 'contract' });
          } else if (['ready', 'chat', 'chats', 'tasks', 'b24', 'waiting'].includes(event.name)) {
            signal(event.name, data);
          }
        } catch {
          void this.link.stopEvents();
          state({ state: 'contract' });
        }
      });

      if (captured !== this.epoch) {
        await Promise.all([stateListener.remove(), eventListener.remove()]);

        return;
      }

      this.listeners.push(stateListener, eventListener);

      if (activate) {
        await this.link.startEvents();
      }
    })();

    return this.start;
  }

  /**
   * Завершение отменяет позднюю подписку и снимает оба listener текущего потока.
   * Новый mount получает отдельного владельца после закрытия старого.
   */
  async close() {
    this.epoch += 1;
    await this.link.stopEvents();
    await Promise.all(this.listeners.map((listener) => listener.remove()));
    this.listeners = [];
    this.start = null;
  }
}
