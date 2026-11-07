import { randomUUID } from 'node:crypto';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { WebSocket, WebSocketServer } from 'ws';
import type { FastifyInstance, FastifyRequest } from 'fastify';

type Timing = {
  start: number;
  handler: number;
  sent?: number;
  token: string;
  epoch: number;
  timer?: ReturnType<typeof setTimeout>;
  done: boolean;
  upgraded?: boolean;
};

/**
 * Нормализуем только исходящие заголовки для сохранения всех overload writeHead.
 * Текст запроса/ответа и полученные заголовки не записываются в диагностику.
 */
function responseHeaders(value: unknown): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 2) {
      const name = String(value[index]).toLowerCase();
      const next = String(value[index + 1]);
      const previous = headers[name];

      headers[name] = previous === undefined ? next
        : [...(Array.isArray(previous) ? previous : [String(previous)]), next];
    }
  } else if (value && typeof value === 'object') {
    for (const [name, item] of Object.entries(value)) {
      headers[name.toLowerCase()] = item as string | string[] | number | undefined;
    }
  }

  return headers;
}

/**
 * Числовые этапы и UUID принадлежат серверу, не входящему request-id.
 * Raw writeHead является общей границей и обычного Fastify, и hijacked SSE/plugin ответа.
 */
export function installHttpDiagnostics(app: FastifyInstance) {
  const states = new WeakMap<object, Timing>();
  const upgrades = new WeakMap<IncomingMessage, FastifyRequest>();
  let removeUpgrade: (() => void) | null = null;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let epoch = 0;

  /**
   * Смена политики снимает все отложенные уведомления исходного поколения.
   * Поздние ответы не получают метаданные после off и повторного включения.
   */
  function reset(): void {
    epoch += 1;
    timers.forEach(clearTimeout);
    timers.clear();
  }

  /**
   * Терминал идемпотентен для onResponse и close сырого ответа.
   * sendMs у SSE означает жизнь потока и никогда не классифицируется как фриз.
   */
  function finish(request: FastifyRequest, status: number, outcome: string): void {
    const state = states.get(request);

    if (!state || state.done) {
      return;
    }

    state.done = true;
    clearTimeout(state.timer);

    if (state.timer) {
      timers.delete(state.timer);
    }
    if (state.epoch !== epoch || app.log.level !== 'debug') {
      return;
    }

    const end = performance.now();

    app.log.debug({
      event: 'server.http',
      serverRequest: state.token,
      method: request.method,
      path: request.routeOptions.url?.startsWith('/api') ? request.routeOptions.url : 'other',
      status,
      outcome,
      ms: Math.max(0, end - state.start),
      prepareMs: Math.max(0, state.handler - state.start),
      handlerMs: Math.max(0, (state.sent ?? end) - state.handler),
      sendMs: state.sent === undefined ? 0 : Math.max(0, end - state.sent),
    }, 'Диагностика HTTP');
  }

  app.addHook('onRequest', async (request, reply) => {
    if (app.log.level !== 'debug' || !request.url.startsWith('/api')
      || request.url.startsWith('/api/web-log')) {
      return;
    }

    const start = performance.now();
    const state: Timing = {
      start,
      handler: start,
      token: randomUUID(),
      epoch,
      done: false,
    };

    states.set(request, state);

    if (String(request.headers.upgrade || '').toLowerCase() === 'websocket') {
      upgrades.set(request.raw, request);
    }

    if (timers.size < 128) {
      state.timer = setTimeout(() => {
        timers.delete(state.timer!);

        if (!state.done && state.sent === undefined && state.epoch === epoch
          && app.log.level === 'debug') {
          app.log.debug({
            event: 'server.pending',
            serverRequest: state.token,
            method: request.method,
            path: request.routeOptions.url || 'other',
            ms: Math.max(0, performance.now() - state.start),
          }, 'Ожидание HTTP');
        }
      }, 3000);
      timers.add(state.timer);
      state.timer.unref?.();
    }

    const raw = reply.raw;
    const writeHead = raw.writeHead;

    raw.writeHead = function(this: ServerResponse, statusCode: number, ...rest: unknown[]) {
      if (state.epoch !== epoch || app.log.level !== 'debug') {
        return Reflect.apply(writeHead, this, [statusCode, ...rest]);
      }

      if (state.sent === undefined) {
        state.sent = performance.now();
        clearTimeout(state.timer);

        if (state.timer) {
          timers.delete(state.timer);
        }
      }

      const message = typeof rest[0] === 'string' ? rest[0] : undefined;
      const headers = responseHeaders(rest[message === undefined ? 0 : 1]);
      const previous = headers['server-timing'] ?? raw.getHeader('server-timing');
      const duration = Math.max(0, state.sent - state.start).toFixed(1);

      headers['server-timing'] = [previous, `grigdesk;dur=${duration}`].filter(Boolean).join(', ');
      headers['x-grigdesk-request'] = state.token;

      return Reflect.apply(writeHead, this,
        message === undefined ? [statusCode, headers] : [statusCode, message, headers]);
    } as typeof raw.writeHead;

    raw.once('close', () => finish(request, reply.statusCode,
      state.upgraded ? 'upgraded' : raw.writableFinished ? 'complete' : 'cancelled'));
  });
  app.addHook('preHandler', async (request) => {
    const state = states.get(request);

    if (state) {
      state.handler = performance.now();
    }
  });
  app.addHook('onResponse', async (request, reply) => {
    finish(request, reply.statusCode, 'complete');
  });
  app.addHook('onReady', async () => {
    const server = (app as FastifyInstance & { websocketServer?: WebSocketServer }).websocketServer;

    if (!server) {
      return;
    }

    /**
     * WS пишет 101 напрямую в socket и не вызывает ServerResponse.writeHead.
     * Подтверждённое соединение завершает HTTP ожидание, отказ остаётся обычным HTTP.
     */
    function connected(socket: WebSocket, raw: IncomingMessage): void {
      const request = upgrades.get(raw);
      const state = request ? states.get(request) : undefined;

      if (!request || !state || state.epoch !== epoch || app.log.level !== 'debug') {
        return;
      }

      state.upgraded = true;
      state.sent = performance.now();
      clearTimeout(state.timer);

      if (state.timer) {
        timers.delete(state.timer);
      }

      app.log.debug({
        event: 'server.upgrade',
        serverRequest: state.token,
        method: request.method,
        path: request.routeOptions.url || 'other',
        ms: Math.max(0, state.sent - state.start),
      }, 'Готовность WebSocket');
      socket.once('close', () => finish(request, 101, 'upgraded'));
    }

    server.on('connection', connected);
    removeUpgrade = () => server.off('connection', connected);
  });
  app.addHook('onClose', async () => {
    reset();
    removeUpgrade?.();
  });

  return { reset };
}
