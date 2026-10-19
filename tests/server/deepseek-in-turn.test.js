// Настоящий адаптер DeepSeek на фейковом web wire: один процесс, один ход,
// steer во время инструмента, промежуточный ответ до финала и продолжение.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { writeDeepSeekMetadataStub } from '../helpers/deepseekBinaryStub.mts';

import deepseek from '../../server/src/lib/executors/deepseek.ts';
import { DeepSeekWebClient } from '../../server/src/lib/deepseek/serverClient.ts';
import { assertInTurnConformance } from './helpers/in-turn-conformance.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const requireServer = createRequire(path.join(ROOT, 'server/package.json'));
const Fastify = requireServer('fastify');
const websocket = requireServer('@fastify/websocket');

/**
 * Wire fixture поднимает только собственный loopback web и совместимый metadata double.
 * Управление steer остаётся настоящим адаптером, модель и subprocess не исполняются.
 */
async function fixture(t, { askQuestion = false, expectedSteers = 1 } = {}) {
  const { binary } = await writeDeepSeekMetadataStub(t);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-deepseek-web-'));
  const app = Fastify();
  await app.register(websocket);
  const sockets = new Map();
  const calls = [];
  let finishSecondStep;
  const continueSecondStep = new Promise((resolve) => { finishSecondStep = resolve; });
  let followSocket;
  let remoteSocket;
  let steerCount = 0;
  const send = (value) => {
    followSocket.send(JSON.stringify({ type: 'item', streamId: sockets.get('session/follow'), value }));
  };
  const event = (type, data) => send({ type: 'event', event: { type, seq: calls.length + 1, time: Date.now(), data } });
  const text = (attemptId, value) => {
    send({ type: 'assistant-stream', frame: { type: 'start', attemptId, revision: 1 } });
    send({ type: 'assistant-stream', frame: { type: 'chunk', attemptId, chunk: { type: 'text-delta', index: 0, text: value } } });
    send({ type: 'assistant-stream', frame: { type: 'chunk', attemptId, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: value } } } });
  };
  app.get('/', (_request, reply) => reply.header('set-cookie', 'dsh_fixture=valid; HttpOnly').code(303).send());
  app.post('/api/*', async (request) => {
    assert.equal(request.headers.cookie, 'dsh_fixture=valid');
    const body = request.body;
    calls.push({ method: body.method, args: body.payload.args });
    let value = {};
    if (body.method === 'session/create') value = { sessionId: 'fixture-session' };
    if (body.method === 'session/prompt') {
      const prompt = body.payload.args.request;
      value = { accepted: true };
      if (prompt.mode === 'queue') {
        queueMicrotask(() => {
          event('turn/start', { turn: 1 });
          event('tool/call', { callId: 'tool-1', name: 'read', arguments: '{}' });
          if (askQuestion) {
            remoteSocket.send(JSON.stringify({
              type: 'item', streamId: sockets.get('$events'),
              value: {
                type: 'waterfall', event: 'user-questions/request', eventId: 'question-fixture',
                request: { questions: [{ id: 'q1', question: 'Как продолжить проверку?', options: [] }] },
              },
            }));
          }
        });
      } else {
        steerCount += 1;
        const currentSteer = steerCount;

        queueMicrotask(() => {
          text(currentSteer === 1 ? 'steer-attempt' : `steer-attempt-${currentSteer}`,
            `Отвечаю на вопрос ${currentSteer}.`);
          // Форма настоящего DSH: id вызова — в source сообщения и в блоке tool-result.
          event('tool/result', {
            message: {
              role: 'user',
              source: {
                kind: 'tool',
                callId: 'tool-1',
              },
              content: [{
                type: 'tool-result',
                toolCallId: 'tool-1',
                content: [],
              }],
            },
          });
          if (currentSteer >= expectedSteers) {
            void continueSecondStep.then(() => {
              text('final-attempt', 'Второй файл проверен.');
              event('turn/end', { turn: 1, reason: { kind: 'completed' } });
            });
          }
        });
      }
    }
    return { type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } };
  });
  app.get('/api/remote.mux', { websocket: true }, (socket, request) => {
    assert.equal(request.headers.cookie, 'dsh_fixture=valid');
    socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type !== 'open') return;
      sockets.set(frame.endpoint, frame.streamId);
      if (frame.endpoint === 'session/follow') {
        followSocket = socket;
        send({ type: 'snapshot', cursor: 0, records: [], assistantStream: { revision: 0 } });
      } else if (frame.endpoint === '$events') {
        remoteSocket = socket;
        socket.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: { type: 'ready', clientId: 'fixture-client' } }));
      }
    });
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const client = await DeepSeekWebClient.authenticate(`${app.listeningOrigin}/?token=fixture`);
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });

  return {
    dir,
    binary,
    client,
    calls,
    finishSecondStep,
  };
}

async function waitFor(check) {
  for (let i = 0; i < 500; i += 1) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Не дождались события');
}

test('DeepSeek web: steer отвечает до финала и исходный ход продолжается', async (t) => {
  const f = await fixture(t);
  const blocks = [];
  let port;
  let settled = false;
  const run = deepseek.run({
    config: { deepseekBin: f.binary, deepseekRuntimeHome: path.join(f.dir, 'runtime') },
    env: { ...process.env, DEEPSEEK_API_KEY: 'fixture-key' },
    cwd: f.dir,
    chatKey: 'fixture-chat',
    message: 'Проверь два файла.',
    model: '["deepseek-official","deepseek-v4-flash"]',
    providerSettings: { blockDirectSsh: false },
    onInTurnReady: (value) => { port = value; },
    onAssistantMessage: (value) => blocks.push(value),
    startServer: async () => ({ client: f.client, stop: async () => {} }),
  }).finally(() => { settled = true; });
  await waitFor(() => port);
  const delivered = await port.deliver({
    messageId: 'message-fixture-0001', text: 'Почему первый файл?', sequence: 1,
  });
  assert.deepEqual(delivered, { ok: true, state: 'forwarded' });
  await waitFor(() => blocks.some((block) => block.complete && block.assistantMessageId === 'steer-attempt-0'));
  assert.equal(settled, false);
  const answerBeforeFinal = !settled;
  f.finishSecondStep();
  const result = await run;
  assert.equal(result.reply, 'Второй файл проверен.');
  assert.deepEqual(f.calls.filter((call) => call.method === 'session/prompt')
    .map((call) => call.args.request.mode), ['queue', 'steer']);
  assert.deepEqual(f.calls.find((call) => call.method === 'session/selectModel')?.args.request,
    { sessionId: 'fixture-session', provider: 'deepseek-official', model: 'deepseek-v4-flash' });
  assert.equal(deepseek.inTurnInput.protocol, 1);
  const late = await port.deliver({
    messageId: 'message-fixture-0002', text: 'Поздний вопрос', sequence: 2,
  });
  assertInTurnConformance({
    name: 'DeepSeek', capability: deepseek.inTurnInput,
    turns: f.calls.filter((call) => call.method === 'session/prompt'
      && call.args.request.mode === 'queue').length,
    steers: f.calls.filter((call) => call.method === 'session/prompt'
      && call.args.request.mode === 'steer').length,
    cancels: f.calls.filter((call) => call.method === 'session/cancel').length,
    forwarded: delivered.ok,
    answerBeforeFinal,
    answerCopies: blocks.filter((block) => block.complete
      && block.assistantMessageId === 'steer-attempt-0').length,
    finalReply: result.reply,
    lateRejected: late.ok === false,
  });
});

test('DeepSeek web: вопрос агента закрывает steer до ответа и открывает после', async (t) => {
  const f = await fixture(t, { askQuestion: true });
  const statuses = [];
  let port;
  let question;
  let answerQuestion;
  const pendingAnswer = new Promise((resolve) => { answerQuestion = resolve; });
  const run = deepseek.run({
    config: { deepseekBin: f.binary, deepseekRuntimeHome: path.join(f.dir, 'runtime') },
    env: { ...process.env, DEEPSEEK_API_KEY: 'fixture-key' },
    cwd: f.dir,
    chatKey: 'fixture-chat',
    message: 'Проверь два файла.',
    providerSettings: { blockDirectSsh: false },
    onInTurnReady: (value) => { port = value; },
    onInTurnAvailability: (value) => statuses.push(value),
    onPermission: (value) => { question = value; return pendingAnswer; },
    startServer: async () => ({ client: f.client, stop: async () => {} }),
  });
  await waitFor(() => question && port);
  assert.equal(question.isQuestion, true);
  assert.equal(question.questions[0].question, 'Как продолжить проверку?');
  assert.ok(statuses.some((status) => status.reason === 'awaiting_answer'));
  const refused = await port.deliver({
    messageId: 'message-fixture-0001', text: 'Почему первый файл?', sequence: 1,
  });
  assert.equal(refused.code, 'awaiting_answer');
  assert.equal(f.calls.filter((call) => call.method === 'session/prompt').length, 1);
  answerQuestion({ rawAnswers: [{ text: 'Продолжай проверку.' }] });
  await waitFor(() => statuses.some((status) => status.available === true));
  const answered = await waitFor(() => f.calls.find((call) => call.method === '$events/result'));
  assert.deepEqual(answered.args, {
    clientId: 'fixture-client', eventId: 'question-fixture',
    outcome: { kind: 'result', value: { answers: [{ id: 'q1', selected: [], custom: 'Продолжай проверку.' }] } },
  });
  const delivered = await port.deliver({
    messageId: 'message-fixture-0002', text: 'Почему первый файл?', sequence: 2,
  });
  assert.equal(delivered.ok, true);
  f.finishSecondStep();
  assert.equal((await run).reply, 'Второй файл проверен.');
  assert.deepEqual(f.calls.filter((call) => call.method === 'session/prompt')
    .map((call) => call.args.request.mode), ['queue', 'steer']);
});

test('DeepSeek web: два steer идут по порядку в одном server session turn', async (t) => {
  const f = await fixture(t, { expectedSteers: 2 });
  const blocks = [];
  let port;
  const turn = deepseek.run({
    config: { deepseekBin: f.binary, deepseekRuntimeHome: path.join(f.dir, 'runtime') },
    env: { ...process.env, DEEPSEEK_API_KEY: 'fixture-key' },
    cwd: f.dir,
    chatKey: 'fixture-chat',
    message: 'Проверь два файла.',
    providerSettings: { blockDirectSsh: false },
    onInTurnReady: (value) => { port = value; },
    onAssistantMessage: (value) => blocks.push(value),
    startServer: async () => ({ client: f.client, stop: async () => {} }),
  });
  await waitFor(() => port);
  assert.equal((await port.deliver({
    messageId: 'message-fixture-0001', text: 'Первый вопрос', sequence: 1,
  })).ok, true);
  await waitFor(() => blocks.some((block) => block.complete
    && block.assistantMessageId === 'steer-attempt-0'));
  assert.equal((await port.deliver({
    messageId: 'message-fixture-0002', text: 'Второй вопрос', sequence: 2,
  })).ok, true);
  await waitFor(() => blocks.some((block) => block.complete
    && block.assistantMessageId === 'steer-attempt-2-0'));
  f.finishSecondStep();
  assert.equal((await turn).reply, 'Второй файл проверен.');
  assert.deepEqual(f.calls.filter((call) => call.method === 'session/prompt')
    .map((call) => ({ mode: call.args.request.mode, text: call.args.request.content[0].text })), [
    { mode: 'queue', text: 'Проверь два файла.' },
    { mode: 'steer', text: 'Первый вопрос' },
    { mode: 'steer', text: 'Второй вопрос' },
  ]);
  assert.equal(f.calls.filter((call) => call.method === 'session/cancel').length, 0);
});
