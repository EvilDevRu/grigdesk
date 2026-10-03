import assert from 'node:assert/strict';
import test from 'node:test';

import { startGlmLoopback } from '../helpers/glmLoopback.mts';

const STREAM = {
  kind: 'stream',
  deltas: [
    { role: 'assistant', reasoning_content: 'Размышление' },
    { tool_calls: [{
      index: 0,
      id: 'call-one',
      type: 'function',
      function: { name: 'read', arguments: '{"pa' },
    }] },
    { tool_calls: [{ index: 0, function: { arguments: 'th":"file"}' } }] },
  ],
  finishReason: 'tool_calls',
  usage: {
    prompt_tokens: 12,
    completion_tokens: 8,
    total_tokens: 20,
  },
};

/**
 * Клиент стенда отправляет только синтетические данные на loopback.
 * Форма запроса соответствует OpenAI completions, который использует маршрут zai.
 */
function requestCompletion(fake, overrides = {}) {
  return fetch(`${fake.endpoint}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer synthetic-glm-key',
    },
    body: JSON.stringify({
      model: 'glm-5.3',
      thinking: {
        type: 'enabled',
        clear_thinking: false,
      },
      tool_stream: true,
      stream: true,
      ...overrides,
    }),
  });
}

test('фейк Z.ai отдаёт reasoning_content, дробные аргументы tool_calls и usage одним потоком', async (t) => {
  const fake = await startGlmLoopback({ scenarios: [STREAM] });

  t.after(fake.stop);

  const response = await requestCompletion(fake);
  const body = await response.text();
  const events = body.split('\n\n').filter((event) => event && event !== 'data: [DONE]')
    .map((event) => JSON.parse(event.slice(6)));

  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  assert.equal(events[0]?.choices[0].delta.reasoning_content, 'Размышление');
  assert.equal(events[1].choices[0].delta.tool_calls[0].function.arguments, '{"pa');
  assert.equal(events[2].choices[0].delta.tool_calls[0].function.arguments, 'th":"file"}');
  assert.equal(events[3].choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(events[3].usage, STREAM.usage);
  assert.equal(body.endsWith('data: [DONE]\n\n'), true);
});

test('фейк Z.ai записывает путь, модель, thinking, tool_stream и совпадение Authorization, не храня ключ',
  async (t) => {
    const fake = await startGlmLoopback({
      prefix: '/api/coding/paas/v4',
      expectedKey: 'synthetic-glm-key',
      scenarios: [STREAM, STREAM],
    });

    t.after(fake.stop);
    await (await requestCompletion(fake)).text();
    await (await requestCompletion(fake, { model: 'glm-4.7' })).text();

    assert.equal(fake.requests.length, 2);
    assert.equal(fake.requests[0].path, '/api/coding/paas/v4/chat/completions');
    assert.equal(fake.requests[0].model, 'glm-5.3');
    assert.deepEqual(fake.requests[0].thinking, { type: 'enabled', clear_thinking: false });
    assert.equal(fake.requests[0].tool_stream, true);
    assert.equal(fake.requests[0].authorizationMatches, true);
    assert.equal(JSON.stringify(fake.requests).includes('synthetic-glm-key'), false);
    assert.equal(fake.requests[1].model, 'glm-4.7');
    assert.equal(new URL(fake.endpoint).hostname, '127.0.0.1');
  });

test('фейк Z.ai по сценарию отвечает 429, 401, обрывом потока и ошибкой переполнения контекста',
  async (t) => {
    const fake = await startGlmLoopback({ scenarios: [
      {
        kind: 'http-error',
        status: 429,
        code: 'rate_limit',
        message: 'Слишком много запросов',
      },
      {
        kind: 'http-error',
        status: 401,
        code: 'invalid_api_key',
        message: 'Неверный ключ',
      },
      { kind: 'disconnect', deltas: [{ role: 'assistant', content: 'Начало' }] },
      {
        kind: 'http-error',
        status: 400,
        code: 'context_length_exceeded',
        message: 'maximum context length exceeded',
      },
    ] });

    t.after(fake.stop);

    for (const status of [429, 401]) {
      const response = await requestCompletion(fake);

      assert.equal(response.status, status);
      assert.equal(typeof (await response.json()).error.code, 'string');
    }

    await assert.rejects(async () => {
      const response = await requestCompletion(fake);

      await response.text();
    });

    const response = await requestCompletion(fake);

    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'context_length_exceeded');
    assert.equal(fake.requests.length, 4);
  });

test('запрос вне сценария или неожиданный путь роняют тест', async (t) => {
  const exhausted = await startGlmLoopback({ scenarios: [] });

  t.after(() => exhausted.stop().catch(() => {}));
  await (await requestCompletion(exhausted)).text();
  assert.throws(exhausted.assertComplete, /вне сценария/u);
  await assert.rejects(exhausted.stop, /вне сценария/u);
  await assert.rejects(() => requestCompletion(exhausted));

  const wrongPath = await startGlmLoopback({ scenarios: [STREAM] });

  t.after(() => wrongPath.stop().catch(() => {}));

  const response = await fetch(`${wrongPath.endpoint}/unexpected`, { method: 'POST', body: '{}' });

  await response.text();
  assert.throws(wrongPath.assertComplete, /Неожиданный путь/u);
  await assert.rejects(wrongPath.stop, /Неожиданный путь/u);
  await assert.rejects(() => requestCompletion(wrongPath));
});
