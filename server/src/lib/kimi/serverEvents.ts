// Поток событий сервера Kimi: WebSocket-мультиплексор `/api/v1/ws`.
//
// Через него приходят видимый текст, завершение хода, вопросы и разрешения — то, из чего
// складывается промежуточный ответ. Токен сервер ждёт не заголовком (браузерный WebSocket
// их не умеет), а подпротоколом `kimi-code.bearer.<token>`; подписка на сессии — кадром
// `{type:'subscribe', payload:{session_ids}}`.
// Контракт: 0.33.0 + heartbeat протокола v2 (2.3.1). На серверный ping отвечаем pong
// с тем же nonce; служебный heartbeat не попадает к подписчику событий хода.

// Кадр сервера: тип события, номер в потоке, сессия и полезная нагрузка. Форма намеренно
// открытая — протокол принадлежит серверу, а разбором конкретных типов занимается драйвер.
export interface KimiRawEvent {
  type: string;
  seq?: number;
  session_id?: string;
  payload?: Record<string, unknown>;
  offset?: number;
  [field: string]: unknown;
}

export interface KimiEventStreamHandle {
  ready: Promise<void>;
  close(): void;
}

// Префикс подпротокола — часть контракта установленного сервера Kimi 0.33.0.
export const KIMI_WS_BEARER_PREFIX = 'kimi-code.bearer.';

/**
 * Адрес WebSocket из базового HTTP-адреса сервера: схема меняется на ws/wss, а client_id
 * уезжает параметром — по нему сервер различает подключения одного и того же окна.
 */
export function kimiEventSocketUrl(baseUrl: string, clientId: string): string {
  const url = new URL(`${String(baseUrl).replace(/\/+$/, '')}/api/v1/ws`);

  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('client_id', clientId);

  return url.toString();
}

export interface KimiEventStreamOptions {
  baseUrl: string;
  token: string;
  sessionIds: readonly string[];
  clientId?: string;
  onEvent: (event: KimiRawEvent) => void;
  onClose?: (info: { code: number; reason: string }) => void;
  onError?: (error: Error) => void;
  WebSocketImpl?: typeof WebSocket;
}

/**
 * Подписка на события сессий. Возвращает handle сразу: `ready` разрешается после отправки
 * подписки, а события идут в `onEvent` до `close()`. Реконнект сознательно не делается
 * здесь — владелец решает, добирать ли пропуск снимком или переподписываться.
 */
export function openKimiEventStream({
  baseUrl,
  token,
  sessionIds,
  clientId = `grigdesk-${Math.random().toString(36).slice(2, 10)}`,
  onEvent,
  onClose,
  onError,
  WebSocketImpl = WebSocket,
}: KimiEventStreamOptions): KimiEventStreamHandle {
  const socket = new WebSocketImpl(
    kimiEventSocketUrl(baseUrl, clientId),
    [`${KIMI_WS_BEARER_PREFIX}${token}`],
  );
  let closed = false;
  let nextId = 1;

  const ready = new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => {
      try {
        socket.send(JSON.stringify({
          type: 'subscribe',
          id: `c_${nextId++}`,
          payload: { session_ids: [...sessionIds] },
        }));
        resolve();
      } catch (error) {
        reject(error as Error);
      }
    });
    socket.addEventListener('error', (event) => {
      const failure = new Error('Kimi event stream: ошибка соединения');

      onError?.(failure);
      reject(failure);
      void event;
    });
  });
  // Отказ соединения не должен выглядеть как необработанный rejection у вызывающего,
  // который уже получил handle: о нём сообщает onError.
  ready.catch(() => {});

  socket.addEventListener('message', (event) => {
    const raw = typeof event.data === 'string' ? event.data : '';

    if (!raw) {
      return;
    }

    try {
      const frame = JSON.parse(raw) as KimiRawEvent;

      if (frame.type === 'ping') {
        const nonce = typeof frame.payload?.nonce === 'string' ? frame.payload.nonce : '';

        try {
          socket.send(JSON.stringify({ type: 'pong', payload: { nonce } }));
        } catch {
          // Сокет мог начать закрываться между получением ping и отправкой pong.
        }

        return;
      }

      onEvent(frame);
    } catch {
      // Нераспознанный кадр не рвёт поток: сервер может добавить служебные сообщения.
    }
  });

  socket.addEventListener('close', (event) => {
    closed = true;
    onClose?.({ code: Number(event.code) || 0, reason: String(event.reason || '') });
  });

  return {
    ready,
    /**
     * Закрыть поток. Повторный вызов безопасен: сокет мог закрыться сам, и это не ошибка
     * вызывающего — событие `close` уже сообщило о причине.
     */
    close() {
      if (closed) {
        return;
      }

      closed = true;

      try {
        socket.close(1000, 'grigdesk');
      } catch {
        // Сокет мог закрыться сам — закрытию это не мешает.
      }
    },
  };
}
