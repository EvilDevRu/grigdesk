import { createRequire } from 'node:module';

const requireServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireServer('fastify');
const websocket = requireServer('@fastify/websocket');

/**
 * Внутрипроцессный сервер посылает кадры kap-server без запуска CLI или модели.
 * Каждый submitPrompt получает отдельный сценарий при том же id сессии.
 */
export async function kimiUsageWire(t, scripts) {
  const app = Fastify();
  let socket;
  let seq = 0;
  let nextScript = 0;

  await app.register(websocket);
  app.get('/api/v1/ws', { websocket: true }, (connection) => {
    socket = connection;
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => app.close());

  const send = (payload) => {
    socket.send(JSON.stringify({
      type: payload.type,
      seq: ++seq,
      epoch: 'usage-epoch',
      session_id: 'usage-session',
      timestamp: '2030-01-01T00:00:00Z',
      payload: {
        sessionId: 'usage-session',
        agentId: 'main',
        ...payload
      },
    }));
  };
  const client = {
    createSession: async () => ({ id: 'usage-session' }),
    submitPrompt: async () => {
      const script = scripts[nextScript++];

      setTimeout(() => script(send), 0);

      return { prompt_id: `prompt-${nextScript}` };
    },
    abortSession: async () => ({}),
    deliverInTurn: async () => ({ ok: true }),
    respondApproval: async () => ({}),
    respondQuestion: async () => ({}),
  };

  return {
    startServer: async () => ({
      baseUrl: app.listeningOrigin,
      token: 'synthetic-wire',
      client,
      pid: null,
      stop: async () => {},
      logTail: () => '',
    }),
  };
}
