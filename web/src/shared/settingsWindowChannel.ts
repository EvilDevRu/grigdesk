import {
  decodeSettingsWindowMessage,
  INTENT_TIMEOUT_MS,
  SETTINGS_CHANNEL_NAME,
} from '../../../shared/desktop/desktopWindowContract.ts';
import type { SettingsWindowMessage } from '../../../shared/desktop/desktopWindowContract.ts';

export interface ChannelPort {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export type ChannelFactory = (name: string) => ChannelPort;

export interface SettingsWindowChannel {
  post(message: SettingsWindowMessage): void;
  subscribe(listener: (message: SettingsWindowMessage) => void): () => void;
  close(): void;
}

type ChannelState = {
  closed: boolean;
  closing: Set<() => void>;
};

const states = new WeakMap<SettingsWindowChannel, ChannelState>();

/**
 * Адаптер скрывает полный MessageEvent браузера за минимальным контрактом порта.
 * Нативный канал создаётся только при вызове фабрики, а не при импорте модуля.
 */
function browserChannelPort(name: string): ChannelPort {
  const native = new BroadcastChannel(name);
  const port: ChannelPort = {
    onmessage: null,
    postMessage: (message) => native.postMessage(message),
    close: () => native.close(),
  };

  native.onmessage = (event) => port.onmessage?.({ data: event.data });

  return port;
}

/**
 * Канал создаётся только явным вызовом, импорт не открывает BroadcastChannel.
 * Вход и выход проходят один декодер, слушатели изолированы друг от друга.
 */
export function createSettingsWindowChannel(
  factory: ChannelFactory = browserChannelPort,
): SettingsWindowChannel {
  const port = factory(SETTINGS_CHANNEL_NAME);
  const listeners = new Set<(message: SettingsWindowMessage) => void>();
  const state: ChannelState = { closed: false, closing: new Set() };

  port.onmessage = (event) => {
    const message = decodeSettingsWindowMessage(event.data);

    if (!message || state.closed) {
      return;
    }

    for (const listener of listeners) {
      try {
        listener(message);
      } catch {
        // Один consumer не мешает остальным сообщениям этого канала.
      }
    }
  };

  const channel: SettingsWindowChannel = {
    post(value) {
      const message = decodeSettingsWindowMessage(value);

      if (message && !state.closed) {
        port.postMessage(message);
      }
    },
    subscribe(listener) {
      if (!state.closed) {
        listeners.add(listener);
      }

      return () => {
        listeners.delete(listener);
      };
    },
    /**
     * Закрытие завершает ожидающие намерения до освобождения порта.
     * Повторный cleanup не отправляет сообщения и не закрывает порт второй раз.
     */
    close() {
      if (state.closed) {
        return;
      }

      state.closed = true;
      port.onmessage = null;
      listeners.clear();

      for (const finish of state.closing) {
        finish();
      }

      state.closing.clear();
      port.close();
    },
  };

  states.set(channel, state);

  return channel;
}

/**
 * Идентификатор связывает ответ с одним намерением, не раскрывая состояние формы.
 * UUID удовлетворяет ограничению общего декодера и не сохраняется на диск.
 */
export function newRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Подписка предшествует отправке, поэтому синхронный ответ не теряется.
 * Ответ, таймаут и закрытие канала освобождают один и тот же listener и таймер.
 */
export function requestIntent(
  channel: SettingsWindowChannel,
  message: Extract<SettingsWindowMessage, { requestId: string; type: `${string}-request` }>,
  timeoutMs = INTENT_TIMEOUT_MS,
): Promise<boolean> {
  const state = states.get(channel);

  if (state?.closed) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    let done = false;
    let unsubscribe = () => { };
    /**
     * Любой исход завершает ожидание ровно один раз.
     * Listener, таймер и подписка закрытия освобождаются вместе.
     */
    const finish = (ok: boolean) => {
      if (done) {
        return;
      }

      done = true;
      clearTimeout(timer);
      unsubscribe();
      state?.closing.delete(onClose);
      resolve(ok);
    };
    const onClose = () => finish(false);
    const timer = setTimeout(onClose, timeoutMs);

    state?.closing.add(onClose);
    unsubscribe = channel.subscribe((result) => {
      if (result.type === 'intent-result' && result.requestId === message.requestId) {
        finish(result.ok);
      }
    });

    try {
      channel.post(message);
    } catch {
      finish(false);
    }
  });
}
