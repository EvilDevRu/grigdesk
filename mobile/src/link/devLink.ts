import type { GrigDeskLink, LinkState, OperationIntent, RequestInput, Listener } from './types.ts';

const endpoint = import.meta.env.VITE_EMULATOR_URL || '/__mobile';
const token = import.meta.env.VITE_EMULATOR_TOKEN || '';

/**
 * Только dev-сборка обращается к отдельному localhost эмулятору с его случайным токеном.
 * Release исключает этот модуль; бинарные данные и JSON проходят тот же allowlist эмулятора.
 */
class DevLink {
  private events = new Set<(value: any) => void>();
  private states = new Set<(value: any) => void>();
  private stream: AbortController | null = null;

  /**
   * Разрешённый localhost API эмулятора не является произвольным proxy наружу.
   * Единственный transport owner эмулятора проверяет пины и reconnect к посреднику.
   */
  private async call<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(endpoint + '/link/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'X-Emulator-Token': token,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();

    if (!response.ok) {
      throw new Error(value.message || 'Эмулятор недоступен.');
    }

    return value as T;
  }

  getState() {
    return this.call<LinkState>('state');
  }
  addFromText(input: { text: string }) {
    return this.call<void>('add', input);
  }
  scanQr() {
    return Promise.resolve({ text: '' });
  }
  selectRelay(input: { id: string }) {
    return this.call<void>('select', input);
  }
  removeRelay(input: { id: string }) {
    return this.call<void>('remove', input);
  }
  unlock() {
    return this.call<void>('unlock', {});
  }
  request(input: RequestInput) {
    return this.call<{
      status: number;
      body: string;
      generation: number;
    }>('request', input);
  }
  getOutbox() {
    return this.call<{ items: OperationIntent[] }>('outbox');
  }
  putOutbox(input: { item: OperationIntent }) {
    return this.call<void>('outbox', input);
  }
  removeOutbox(input: { idempotencyKey: string }) {
    return this.call<void>('outbox-remove', input);
  }
  downloadUpdate() {
    return this.call<void>('update', {});
  }
  resetDevice() {
    return this.call<void>('reset', {});
  }

  async fetchMedia(input: { chatId: string; ref: string }) {
    const result = await this.call<{
      file?: string;
      error?: string;
    }>('media', input);

    return result.file
      ? { path: endpoint + '/link/media/' + result.file + '?token=' + token }
      : { error: result.error || 'network' };
  }

  /**
   * Локальный SSE читается без собственного retry loop поверх native эмулятора.
   * Потеря dev HTTP-связи показывает offline и ждёт явного нового startEvents.
   */
  async startEvents() {
    if (this.stream) {
      return;
    }

    const controller = new AbortController();

    this.stream = controller;
    void (async () => {
      try {
        const response = await fetch(endpoint + '/link/events', {
          headers: { 'X-Emulator-Token': token },
          signal: controller.signal,
        });
        const reader = response.body?.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        if (!reader || !response.ok) {
          throw new Error('stream_unavailable');
        }

        while (!controller.signal.aborted) {
          const chunk = await reader.read();

          if (chunk.done) {
            break;
          }

          buffer += decoder.decode(chunk.value, { stream: true });

          if (buffer.length > 65536) {
            throw new Error('stream_limit');
          }

          let boundary;

          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, boundary);

            buffer = buffer.slice(boundary + 2);

            const data = frame
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trim())
              .join('\n');
            const name = frame
              .split('\n')
              .find((line) => line.startsWith('event:'))
              ?.slice(6)
              .trim();

            if (name && data) {
              const value = JSON.parse(data);

              (name === 'linkState' ? this.states : this.events).forEach((callback) =>
                callback(value),
              );
            }
          }
        }
      } catch {
        if (!controller.signal.aborted) {
          this.states.forEach((callback) => callback({ state: 'offline' }));
        }
      }
    })();
  }

  async stopEvents() {
    this.stream?.abort();
    this.stream = null;
  }

  async addListener(
    name: 'linkEvent' | 'linkState',
    callback: (value: any) => void,
  ): Promise<Listener> {
    const listeners = name === 'linkEvent' ? this.events : this.states;

    listeners.add(callback);

    return {
      remove: async () => {
        listeners.delete(callback);
      },
    };
  }
}

export const devLink: GrigDeskLink = new DevLink();
