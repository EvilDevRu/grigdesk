// Синтетический DSH web wire для HTTP + WebSocket regression tests.
// Запускается из repo-файла через shell-обёртку, чтобы зависимости искались в server/.
import { createRequire } from 'node:module';
import { readFile, appendFile } from 'node:fs/promises';

const requireServer = createRequire(new URL('../../../server/package.json', import.meta.url));
const Fastify = requireServer('fastify');
const websocket = requireServer('@fastify/websocket');
const args = process.argv.slice(2);
const arg = (name, fallback = '') => args[args.indexOf(name) + 1] || fallback;
const port = Number(arg('--port', '0'));
const scenarioFile = arg('--scenario');
const logFile = arg('--log');
const app = Fastify({ logger: false });
await app.register(websocket);
let follow;
let events;
let turn = 0;
let seq = 0;
let pendingApproval = null;
let pendingCancel = false;
const log = async (value) => appendFile(logFile, `${JSON.stringify(value)}\n`);
const send = (socket, streamId, value) => {
  socket.send(JSON.stringify({ type: 'item', streamId, value }));
};
const emit = (type, data) => {
  if (!follow) return;
  send(follow.socket, follow.streamId, {
    type: 'event', event: { type, seq: ++seq, time: Date.now(), data },
  });
};
const streamText = (value) => {
  if (!follow) return;
  const attemptId = `attempt-${turn}-${seq}`;
  send(follow.socket, follow.streamId, {
    type: 'assistant-stream', frame: { type: 'start', attemptId, revision: 1 },
  });
  for (const chunk of [
    { type: 'text-delta', index: 0, text: value },
    { type: 'block-end', index: 0, block: { type: 'text', text: value } },
  ]) {
    send(follow.socket, follow.streamId, {
      type: 'assistant-stream', frame: { type: 'chunk', attemptId, chunk },
    });
  }
};
const finish = (reason = { kind: 'completed' }) => emit('turn/end', { turn, reason });

app.get('/', (_request, reply) => reply.header('set-cookie', 'dsh_fixture=valid; HttpOnly').code(303).send());
app.post('/api/*', async (request) => {
  if (request.headers.cookie !== 'dsh_fixture=valid') {
    return { type: 'server-response', rpcId: request.body?.rpcId, result: {
      ok: false, error: { code: 'unauthorized', message: 'cookie missing', details: {} },
    } };
  }
  const body = request.body;
  const method = body.method;
  const params = body.payload.args;
  await log({ kind: 'request', message: { method, params } });
  let value = {};
  if (method === 'session/create') {
    value = { sessionId: params.request.sessionId || `fake-session-${Date.now()}-${Math.random()}` };
  } else if (method === 'session/selectModel') {
    value = { selected: params.request };
  } else if (method === 'session/prompt') {
    const scenario = JSON.parse(await readFile(scenarioFile, 'utf8'));
    value = { accepted: true };
    turn += 1;
    queueMicrotask(() => {
      emit('turn/start', { turn });
      for (const update of scenario.updates || []) {
        if (update.sessionUpdate === 'agent_message_chunk') {
          streamText(String(update.content?.text || ''));
        }
        if (update.sessionUpdate === 'tool_call') {
          emit('tool/call', {
            turn, step: 1, callId: update.toolCallId,
            name: update.title,
            arguments: JSON.stringify(update.rawInput || {}),
          });
        }
      }
      if (scenario.permission && events) {
        const eventId = `approval-${turn}`;
        pendingApproval = { eventId };
        send(events.socket, events.streamId, {
          type: 'waterfall', event: 'approval/request', eventId,
          agentId: 'fake-agent',
          request: { toolName: 'bash', callId: scenario.permission.toolCallId, reason: 'boundary check' },
        });
      } else if (scenario.promptError) {
        finish({ kind: 'error', error: { code: 'network', message: scenario.promptError.message } });
      } else if (scenario.waitForCancel) {
        pendingCancel = true;
      } else {
        finish();
      }
    });
  } else if (method === '$events/result') {
    if (pendingApproval && params.eventId === pendingApproval.eventId) {
      await log({ kind: 'permission_response', message: { result: params.outcome } });
      pendingApproval = null;
      queueMicrotask(() => finish());
    }
  } else if (method === 'session/cancel') {
    if (pendingCancel) {
      pendingCancel = false;
      queueMicrotask(() => finish({ kind: 'interrupted' }));
    }
    value = { accepted: true };
  }
  return { type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } };
});
app.get('/api/remote.mux', { websocket: true }, (socket) => {
  socket.on('message', (raw) => {
    const frame = JSON.parse(String(raw));
    if (frame.type !== 'open') return;
    if (frame.endpoint === 'session/follow') {
      follow = { socket, streamId: frame.streamId };
      send(socket, frame.streamId, { type: 'snapshot', cursor: 0, records: [] });
    } else if (frame.endpoint === '$events') {
      events = { socket, streamId: frame.streamId };
      send(socket, frame.streamId, { type: 'ready', clientId: 'fake-client' });
    }
  });
});
await app.listen({ host: '127.0.0.1', port });
console.log(`dsh web: http://127.0.0.1:${port}/?token=synthetic-fixture`);
process.on('SIGTERM', () => { void app.close().then(() => process.exit(0)); });
