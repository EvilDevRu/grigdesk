#!/usr/bin/env node
// Фейковый сервер Kimi для драйвера хода: REST (сессия, prompt, steer) и WS-события.
//
// Сценарий: основной prompt запускает ход, агент «работает» (одна текстовая дельта), ждёт
// уточнение; после `prompts:steer` отвечает на него и завершает ход событием `turn.ended`.
// Модели нет — проверяется транспорт и порядок событий.
import { createRequire } from 'node:module';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const requireFromServer = createRequire(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../server/package.json'),
);
const Fastify = requireFromServer('fastify');
const websocket = requireFromServer('@fastify/websocket');

const argv = process.argv.slice(2);
const port = Number(argv[argv.indexOf('--port') + 1] || 0);
const home = process.env.KIMI_CODE_HOME || '/tmp';
const token = 'fixture-token-0123456789';
const withApproval = process.env.COCKPIT_KIMI_FIXTURE_APPROVAL === '1';
const realWire = process.env.COCKPIT_KIMI_FIXTURE_REAL_WIRE === '1';
const steersExpected = Math.max(1, Number(process.env.COCKPIT_KIMI_FIXTURE_STEERS) || 1);
const trace = [];
const traceFile = path.join(home, 'fixture-trace.jsonl');

function remember(entry) {
  trace.push(entry);
  appendFileSync(traceFile, `${JSON.stringify(entry)}\n`, 'utf8');
}

mkdirSync(home, { recursive: true });
writeFileSync(path.join(home, 'server.token'), `${token}\n`, 'utf8');

const app = Fastify({ logger: false });

app.post('/api/v1/config', async (request) => {
  remember({ kind: 'config', body: request.body });

  return { code: 0, data: request.body };
});

let socket = null;
let seq = 0;
let promptCount = 0;
let steered = null;
let steerCount = 0;
let emittedWork = false;
let noSteerTimer = null;
let approvalAsked = false;

function send(type, payload) {
  seq += 1;
  socket?.send(JSON.stringify({
    type,
    seq,
    session_id: 'session-fixture-0001',
    payload,
  }));
}

// Если уточнение не пришло, ход завершается сам — как настоящий агент, доделав работу.
function finishWithoutSteer() {
  if (steered) {
    return;
  }
  send('event.assistant.completed', {
    message_id: 'assistant-main',
    content: [{ type: 'text', text: 'Проверка завершена.' }],
  });
  send('event.turn.ended', { reason: 'completed' });
}

function advance() {
  if (!socket) {
    return;
  }
  if (withApproval && !approvalAsked) {
    approvalAsked = true;
    send('event.approval.requested', {
      approval_id: 'approval-1',
      tool_name: 'Bash',
      action: 'exec',
      display: 'rm -rf build',
    });
    return;
  }
  if (!emittedWork) {
    emittedWork = true;
    if (realWire) {
      send('turn.started', { turnId: 1 });
      send('turn.step.started', { turnId: 1, step: 1 });
      send('assistant.delta', { turnId: 1, delta: 'Начинаю проверку.' });
      send('tool.call.started', {
        turnId: 1,
        toolCallId: 'tool-edit-1',
        name: 'Edit',
        args: { path: 'first.txt' },
        display: { kind: 'diff', path: 'first.txt', before: 'старое', after: 'новое' },
      });
      send('tool.result', { turnId: 1, toolCallId: 'tool-edit-1', output: 'Готово.' });
      send('turn.step.completed', { turnId: 1, step: 1 });
      return;
    }
    // Дельта текста идёт БЕЗ префикса event. — как у настоящего сервера для потока агента.
    send('assistant.delta', { message_id: 'assistant-main', delta: 'Начинаю проверку.' });
    send('thinking.delta', { delta: 'Сверяю порядок файлов.' });
    send('event.session.usage_updated', {
      usage: { context_tokens: 12_345, context_limit: 262_144, output_tokens: 42 },
    });
    return;
  }
  if (steered && !steered.answered) {
    steered.answered = true;
    if (realWire) {
      send('turn.step.started', { turnId: 1, step: 2 });
      send('assistant.delta', { turnId: 1, delta: `Отвечаю: ${steered.text}` });
      send('turn.step.completed', { turnId: 1, step: 2 });
      return;
    }
    const answerId = steersExpected === 1 ? 'assistant-steer' : `assistant-steer-${steerCount}`;
    send('assistant.delta', { message_id: answerId, delta: `Отвечаю: ${steered.text}` });
    send('event.assistant.completed', {
      message_id: answerId,
      content: [{ type: 'text', text: `Отвечаю: ${steered.text}` }],
    });
    return;
  }
  if (steered?.answered && !steered.finished) {
    steered.finished = true;
    if (steerCount < steersExpected) {
      steered = null;
      return;
    }
    if (realWire) {
      send('turn.step.started', { turnId: 1, step: 3 });
      send('assistant.delta', { turnId: 1, delta: 'Второй файл проверен.' });
      send('turn.step.completed', { turnId: 1, step: 3 });
      send('turn.ended', { turnId: 1, reason: 'completed' });
      return;
    }
    send('event.assistant.completed', {
      message_id: 'assistant-main',
      content: [{ type: 'text', text: 'Второй файл проверен.' }],
    });
    send('event.turn.ended', { reason: 'completed' });
  }
}

app.addHook('onRequest', async (request, reply) => {
  if (request.url.startsWith('/api/v1/ws')) {
    return undefined;
  }
  if (request.headers.authorization !== `Bearer ${token}`) {
    return reply.code(401).send({ code: 40101, msg: 'unauthorized' });
  }

  return undefined;
});

app.get('/api/v1/meta', async () => ({
  code: 0,
  data: { server_version: '0.33.0-fixture', capabilities: { websocket: true } },
}));

app.post('/api/v1/sessions', async () => ({ code: 0, data: { id: 'session-fixture-0001' } }));

app.post('/api/v1/sessions/:id/prompts', async (request) => {
  promptCount += 1;
  remember({ kind: 'prompt', text: request.body?.content?.[0]?.text || '', promptId: `prompt-${promptCount}` });

  setTimeout(advance, 20);
  if (promptCount === 1) {
    noSteerTimer = setTimeout(finishWithoutSteer, 1500);
  }

  return {
    code: 0,
    data: {
      prompt_id: `prompt-${promptCount}`,
      user_message_id: `message-${promptCount}`,
      status: promptCount === 1 ? 'running' : 'queued',
    },
  };
});

app.post('/api/v1/sessions/:id/prompts:steer', async (request) => {
  const ids = request.body?.prompt_ids || [];
  const last = trace.filter((entry) => entry.kind === 'prompt').at(-1);

  if (noSteerTimer) {
    clearTimeout(noSteerTimer);
    noSteerTimer = null;
  }
  steerCount += 1;
  steered = { text: last?.text || '', answered: false, finished: false };
  remember({ kind: 'steer', promptIds: ids });
  setTimeout(advance, 20);

  return { code: 0, data: { steered: true, prompt_ids: ids } };
});

app.post('/api/v1/sessions/:id/approvals/:approvalId', async (request) => {
  remember({ kind: 'approval', decision: request.body?.decision || '' });
  send('event.approval.resolved', { approval_id: request.params.approvalId, decision: request.body?.decision || '' });
  setTimeout(advance, 20);

  return { code: 0, data: { resolved: true, resolved_at: '2026-09-29T00:00:00Z' } };
});

app.post('/api/v1/sessions/:id:abort', async () => ({ code: 0, data: { aborted: true } }));

app.get('/api/v1/fixture/trace', async () => ({ code: 0, data: { trace } }));

await app.register(websocket);
app.get('/api/v1/ws', { websocket: true }, (connection) => {
  socket = connection;
});

await app.listen({ host: '127.0.0.1', port });
writeFileSync(path.join(home, 'server.url'), `http://127.0.0.1:${port}\n`, 'utf8');
process.stdout.write(`Kimi server: http://127.0.0.1:${port}/#token=${token}\n`);

process.on('SIGTERM', () => {
  app.close().then(() => process.exit(0));
  setTimeout(() => process.exit(0), 500);
});
