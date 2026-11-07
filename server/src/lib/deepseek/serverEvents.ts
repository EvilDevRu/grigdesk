// Один WebSocket на подписку DSH. Отдельные follow и $events позволяют держать
// ответы агента и спросы человека открытыми до завершения исходного хода.
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

import type { DeepSeekWebClient } from './serverClient.ts';

export interface DeepSeekWireFrame {
  type: string;
  [key: string]: unknown;
}

export function openDeepSeekStream({
  client,
  endpoint,
  args,
  onItem,
  onClose,
}: {
  client: DeepSeekWebClient;
  endpoint: string;
  args: Record<string, unknown>;
  onItem: (item: DeepSeekWireFrame) => void;
  onClose: (error: Error) => void;
}) {
  const streamId = randomUUID();
  const wsUrl = new URL('/api/remote.mux', client.baseUrl);
  wsUrl.protocol = 'ws:';
  const socket = new WebSocket(wsUrl, { headers: { Cookie: client.cookie } });
  let closed = false;
  let settled = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const fail = (error: Error) => {
    if (!settled) {
      settled = true;
      rejectReady(error);
    }
    if (!closed) onClose(error);
  };
  socket.on('open', () => {
    socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }));
  });
  socket.on('message', (raw) => {
    let frame: { type?: unknown; streamId?: unknown; value?: unknown; error?: { message?: string } };
    try {
      frame = JSON.parse(String(raw));
    } catch {
      fail(new Error('DeepSeek web прислал неверный кадр'));
      socket.close();
      return;
    }
    if (frame.streamId !== streamId) return;
    if (frame.type === 'error') {
      fail(new Error(String(frame.error?.message || 'DeepSeek web закрыл поток с ошибкой')));
      socket.close();
      return;
    }
    if (frame.type === 'end') {
      fail(new Error('DeepSeek web закрыл поток до завершения хода'));
      return;
    }
    if (frame.type !== 'item' || !frame.value || typeof frame.value !== 'object') return;
    if (!settled) {
      settled = true;
      resolveReady();
    }
    onItem(frame.value as DeepSeekWireFrame);
  });
  socket.on('error', (error) => fail(error));
  socket.on('close', () => fail(new Error('WebSocket DeepSeek закрылся')));
  return {
    ready,
    close() {
      closed = true;
      socket.close();
    },
  };
}
