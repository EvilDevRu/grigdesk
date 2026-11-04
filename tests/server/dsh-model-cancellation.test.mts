import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createRequire } from 'node:module';

import type WebSocket from '../../server/node_modules/@types/ws/index.d.ts';
import { DeepSeekWebClient } from '../../server/src/lib/deepseek/serverClient.ts';
import { runDeepSeekServerTurn } from '../../server/src/lib/deepseek/serverTurn.ts';

const requireServer = createRequire(new URL('../../server/package.json', import.meta.url));
const { WebSocketServer } = requireServer('ws') as typeof import(
  '../../server/node_modules/@types/ws/index.d.ts'
);

for (const stage of ['create', 'select', 'ready', 'prompt'] as const) {
  test(`DSH-MODEL-CANCEL: отмена удержанного ${stage} до освобождения фикстуры`, {
    timeout: 10000
  }, async (t) => {
    let reached!: () => void;
    const arrived = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let held: (() => void) | undefined;
    let released = false;
    let stopped = false;
    let prompts = 0;
    let subscriptions = 0;
    const sockets = new Set<WebSocket>();
    const http = createServer(async (request, response) => {
      if (request.method === 'GET') {
        response.writeHead(303, {
          'set-cookie': 'fixture=valid; HttpOnly'
        }).end();

        return;
      }

      let body = '';

      for await (const chunk of request) {
        body += String(chunk);
      }

      const frame = JSON.parse(body);
      const reply = (value: unknown) => {
        response.writeHead(200, {
          'content-type': 'application/json'
        }).end(JSON.stringify({
          type: 'server-response',
          rpcId: frame.rpcId,
          result: {
            ok: true,
            value
          },
        }));
      };
      const current = frame.method === 'session/create' ? 'create'
        : frame.method === 'session/selectModel' ? 'select'
          : frame.method === 'session/prompt' ? 'prompt' : '';

      if (current === 'prompt') {
        prompts++;
      }

      const value = current === 'create' ? {
        sessionId: 'synthetic-session'
      } : {
        accepted: true
      };

      if (current === stage) {
        held = () => reply(value);
        reached();
      }
      else {
        reply(value);
      }
    });
    const ws = new WebSocketServer({
      noServer: true
    });

    http.on('upgrade', (request, socket, head) => {
      ws.handleUpgrade(request, socket, head, (client) => {
        ws.emit('connection', client, request);
      });
    });

    const readyItems: Array<() => void> = [];

    ws.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('message', (raw) => {
        const frame = JSON.parse(String(raw));

        subscriptions++;

        const send = () => socket.send(JSON.stringify({
          type: 'item',
          streamId: frame.streamId,
          value: {
            type: 'snapshot',
            records: [],
            projections: {
              values: {}
            }
          },
        }));

        if (stage === 'ready') {
          readyItems.push(send);

          if (subscriptions === 2) {
            held = () => readyItems.forEach((write) => write());
            reached();
          }
        }
        else {
          send();
        }
      });
    });
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');

    const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/?token=fixture`;
    /**
     * Удержанные ответы и сокеты принадлежат только этой синтетической фикстуре.
     * Cleanup завершает оба сервера даже после намеренного отказа проверки.
     */
    const close = async () => {
      for (const socket of sockets) {
        socket.terminate();
      }

      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await new Promise<void>((resolve) => ws.close(() => resolve()));
    };

    t.after(close);

    const client = await DeepSeekWebClient.authenticate(url);
    const controller = new AbortController();
    const pending = runDeepSeekServerTurn({
      bin: '/unused',
      overlayPath: '/unused',
      cwd: '/tmp',
      env: {},
      model: '["deepseek-official","deepseek-v4-flash"]',
      message: 'synthetic',
      signal: controller.signal,
      startServer: async () => ({
        client,
        stop: async () => {
          stopped = true;

          for (const socket of sockets) {
            socket.terminate();
          }

          http.closeAllConnections();
        },
      }),
      variant: {
        interruptOnAbort: true,
        labels: {
          stopped: 'stop',
          blocked: 'block',
          modelError: 'error',
          action: 'model',
          source: 'model'
        },
        autoApprove: () => false,
        classifyModelError: () => new Error('failed'),
      } as any,
    }).then(() => ({
      ok: true
    }), () => ({
      ok: false
    }));

    await arrived;
    controller.abort();
    // Watchdog освобождает собственную фикстуру только для завершения RED на старом коде.
    // Проверяется порядок событий, а не быстродействие машины в миллисекундах.
    const watchdog = setTimeout(() => {
      released = true;
      held?.();
    }, 1500);
    const result = await pending;

    clearTimeout(watchdog);
    assert.equal(result.ok, false);
    assert.equal(stopped, true);
    assert.equal(released, false);
    assert.equal(prompts, stage === 'prompt' ? 1 : 0);
  });
}
