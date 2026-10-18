import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createGlmAdapter } from '../../server/src/lib/executors/glm.ts';
import { glmCompatibilityIdentity } from '../../server/src/lib/glm/contract.ts';
import { describeGlmGeneration } from '../../server/src/lib/glm/generation.ts';
import { artifactsPath } from '../../shared/runtime/dataHome.ts';
import { ensureTestDeepSeekArtifact } from '../helpers/deepseekRuntimeArtifact.mts';
import { startGlmLoopback } from '../helpers/glmLoopback.mts';
import {
  GLM_SERVICE_KEY,
  glmTextReply,
  glmToolCall,
  writeGlmEgressGuard,
} from '../helpers/glmProductionFixture.mts';

const ARTIFACTS = path.join(artifactsPath({ env: process.env, home: os.homedir() }), 'glm/G5/fixtures');
const MODELS = {
  'glm-4.7': ['off', 'minimal', 'low', 'medium', 'high'],
  'glm-5-turbo': ['off', 'minimal', 'low', 'medium', 'high'],
  'glm-5.2': ['off', 'high', 'max'],
  'glm-5.2-highspeed': ['off', 'high', 'max'],
  'glm-5.3': ['low', 'high', 'max'],
  'glm-5.3-flash': ['low', 'high', 'max'],
  'glm-5.3-highspeed': ['low', 'high', 'max'],
};
const model = (name) => JSON.stringify(['zai', name]);

/**
 * Стенд хода через DI-адаптер: настоящая generation, production-профиль и фейк Z.ai.
 * Подменены только адрес модели и сторож внешнего fetch (Р16); допуск — identity этой сборки.
 */
async function fixture(t, loopbackOptions = {}) {
  const artifact = await ensureTestDeepSeekArtifact();

  await fs.mkdir(ARTIFACTS, { recursive: true });

  const root = await fs.mkdtemp(path.join(ARTIFACTS, 'turn-'));
  const cwd = path.join(root, 'project');
  const mock = await startGlmLoopback({
    expectedKey: GLM_SERVICE_KEY,
    ...loopbackOptions,
  });
  const config = {
    rootDir: root,
    deepseekArtifactDir: artifact,
    deepseekRuntimeMode: 'embedded',
    glmRuntimeHome: path.join(root, 'glm-home'),
  };
  const identity = glmCompatibilityIdentity(describeGlmGeneration(config).runtime, 'api');
  const adapter = createGlmAdapter({
    env: {
      PATH: process.env.PATH,
      HOME: root,
      GRIGDESK_GLM_API_MODE: 'api',
      ZAI_API_KEY: GLM_SERVICE_KEY,
    },
    admission: [{ mode: 'api', compatibility: identity }],
    catalog: Object.entries(MODELS).map(([name, efforts]) => ({ id: model(name), efforts })),
    modelEndpoint: mock.endpoint,
    egressGuard: await writeGlmEgressGuard(path.join(root, 'guard')),
  });

  await fs.mkdir(path.join(cwd, '.git'), { recursive: true });
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await mock.stop();
  });

  return {
    cwd,
    mock,
    run: (options = {}) => adapter.run({
      config,
      cwd,
      chatKey: 'fixture-chat',
      message: 'fixture-prompt',
      model: model('glm-5.3'),
      onSessionCreated: async () => {},
      signal: AbortSignal.timeout(60_000),
      ...options,
    }),
  };
}

function httpError(status, message, code = '1000') {
  return {
    kind: 'http-error',
    status,
    code,
    message,
  };
}

function reasoningReply(reasoning) {
  return {
    kind: 'stream',
    deltas: [{ role: 'assistant', reasoning_content: reasoning }, { content: 'first' }],
  };
}

function assistantMessages(payload) {
  return payload.messages.filter((message) => message.role === 'assistant');
}

test('настоящий ход: 401 даёт один запрос и glm_auth_failed', async (t) => {
  const f = await fixture(t, {
    scenarios: [httpError(401, 'Authentication parameter not received in Header')],
  });

  await assert.rejects(f.run(), { code: 'glm_auth_failed' });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(f.mock.requests.length, 1);
});

test('настоящий ход: нехватка баланса даёт один запрос и glm_quota_exhausted', async (t) => {
  const f = await fixture(t, {
    scenarios: [httpError(429, 'Insufficient balance or no resource package. Please recharge.', '1113')],
  });

  await assert.rejects(f.run(), { code: 'glm_quota_exhausted' });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(f.mock.requests.length, 1);
});

test('настоящий ход: обрыв соединения, обрыв потока и 429 повторяются тем же ходом', async (t) => {
  const observed = {};

  for (const [label, failures] of [
    ['reset', [{ kind: 'reset' }, { kind: 'reset' }]],
    ['disconnect', [{ kind: 'disconnect', deltas: [{ content: 'partial' }] }]],
    ['429', [httpError(429, 'Rate limit reached for requests', '1302')]],
  ]) {
    await t.test(label, async (sub) => {
      const f = await fixture(sub, { scenarios: [...failures, glmTextReply('after-retry')] });
      const result = await f.run();

      observed[label] = {
        reply: result.reply,
        deliveryFailure: Boolean(result.deliveryFailure),
        requests: f.mock.requests.length,
      };
    });
  }

  const recovered = (requests) => ({
    reply: 'after-retry',
    deliveryFailure: false,
    requests,
  });

  t.diagnostic(JSON.stringify(observed));
  assert.deepEqual(observed, {
    reset: recovered(3),
    disconnect: recovered(2),
    429: recovered(2),
  });
});

test('настоящий ход: переполнение контекста сжимается и повторяется только после ошибки переполнения',
  async (t) => {
    const overflow = httpError(400, 'maximum context length exceeded', 'context_length_exceeded');

    // Факт G5: со старой историей DSH сжимает её запросом-выжимкой и повторяет запрос хода.
    await t.test('история есть', async (sub) => {
      const f = await fixture(sub, { respond: (_payload, index) => index === 1 ? overflow
        : glmTextReply(['first', null, 'fixture-summary', 'after-compaction'][index]) });
      const first = await f.run();
      const second = await f.run({ sessionId: first.sessionId, message: 'second-prompt' });
      const retried = JSON.stringify(f.mock.requests[3].payload.messages);

      assert.equal(second.reply, 'after-compaction');
      assert.equal(f.mock.requests.length, 4);
      assert.match(JSON.stringify(f.mock.requests[2].payload.messages), /compaction engine/u);
      assert.match(retried, /fixture-summary/u);
      assert.match(retried, /second-prompt/u);
    });

    // В первом ходе сжимать нечего: после запроса-выжимки ход — сбой доставки без повтора.
    await t.test('истории нет', async (sub) => {
      const f = await fixture(sub, { respond: (_payload, index) => index === 0 ? overflow
        : glmTextReply('fixture-summary') });
      const result = await f.run();

      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(result.deliveryFailure, true);
      assert.equal(f.mock.requests.length, 2);
      assert.match(JSON.stringify(f.mock.requests[1].payload.messages), /compaction engine/u);
    });
  });

test('настоящий ход: размышление, дробные аргументы инструмента, результат и следующий запрос с '
  + 'reasoning_content той же модели', async (t) => {
  const f = await fixture(t, { respond: (_payload, index) => index === 0
    ? {
      ...glmToolCall('read', { file_path: 'note.txt' }),
      deltas: [
        { role: 'assistant', reasoning_content: 'fixture-reasoning' },
        ...glmToolCall('read', { file_path: 'note.txt' }).deltas,
      ],
    }
    : glmTextReply('after-tool') });
  const result = await f.run();
  const followUp = f.mock.requests[1].payload;
  const assistant = assistantMessages(followUp)[0];
  const toolResult = followUp.messages.find((message) => message.role === 'tool');

  assert.equal(result.reply, 'after-tool');
  assert.ok(result.steps.some((step) => step.k === 'think' && step.text === 'fixture-reasoning'));
  assert.equal(assistant.reasoning_content, 'fixture-reasoning');
  assert.deepEqual(JSON.parse(assistant.tool_calls[0].function.arguments), { file_path: 'note.txt' });
  assert.equal(toolResult.tool_call_id, 'call-1');
});

test('настоящий ход после resume возвращает модели прежнее reasoning_content той же модели', async (t) => {
  const f = await fixture(t, { respond: (_payload, index) => index === 0
    ? reasoningReply('first-reasoning')
    : glmTextReply('second') });
  const first = await f.run();
  const second = await f.run({ sessionId: first.sessionId, message: 'second-prompt' });
  const assistant = assistantMessages(f.mock.requests[1].payload)[0];

  assert.equal(second.sessionId, first.sessionId);
  assert.equal(assistant.reasoning_content, 'first-reasoning');
});

test('настоящая смена модели между ходами не отправляет чужое reasoning_content как reasoning', async (t) => {
  const f = await fixture(t, { respond: (_payload, index) => index === 0
    ? reasoningReply('foreign-reasoning')
    : glmTextReply('second') });
  const first = await f.run();

  await f.run({
    sessionId: first.sessionId,
    model: model('glm-4.7'),
    message: 'second-prompt',
  });

  const assistants = assistantMessages(f.mock.requests[1].payload);

  t.diagnostic(JSON.stringify(assistants));
  assert.equal(f.mock.requests[1].model, 'glm-4.7');
  assert.ok(assistants.every((message) => message.reasoning_content !== 'foreign-reasoning'));
});

test('настоящий ход без выбранного effort отправляет thinking enabled для каждой модели', async (t) => {
  const f = await fixture(t, { respond: () => glmTextReply() });

  for (const name of Object.keys(MODELS)) {
    await f.run({ model: model(name), chatKey: `chat-${name}` });
  }

  assert.deepEqual(f.mock.requests.map((request) => [request.model, request.thinking]),
    Object.keys(MODELS).map((name) => [name, { type: 'enabled', clear_thinking: false }]));
});

test('настоящий ход не публикует сообщения прошлых ходов как новый ответ', async (t) => {
  const f = await fixture(t, {
    respond: (_payload, index) => glmTextReply(index === 0 ? 'first-answer' : 'second'),
  });
  const first = await f.run();
  const published = [];
  const second = await f.run({
    sessionId: first.sessionId,
    message: 'second-prompt',
    onAssistantMessage: (event) => published.push(event.text),
  });

  assert.equal(second.reply, 'second');
  assert.ok(published.every((text) => !text.includes('first-answer')), JSON.stringify(published));
  assert.ok(second.steps.every((step) => !String(step.text ?? '').includes('first-answer')));
});
