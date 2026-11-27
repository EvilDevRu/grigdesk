import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

import { qwenFixture, sourceSettings } from './qwenFixture.mjs';

/**
 * Настоящий Qwen видит только локальный OpenAI-compatible API с синтетическим ключом.
 * Ответы задают реальные native tools; их результат наблюдается в файлах и MCP.
 */
export async function qwenNativeFixture(t) {
  const requests = [];
  const actions = [];
  const catalog = [{ id: 'shared-model' }];
  const connections = new Set();
  let sequence = 0;
  let notifyHeld;
  const held = new Promise((resolve) => {
    notifyHeld = resolve;
  });
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: catalog }));

      return;
    }

    let text = '';

    for await (const chunk of request) {
      text += chunk;
    }

    const body = JSON.parse(text);

    requests.push(body);

    // WebFetch пересказывает страницу обычным JSON-запросом без инструментов.
    // Он не должен потреблять сценарий основного SSE-диалога с моделью.
    if (body.stream === false && !body.tools?.length) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        id: 'synthetic-side-query',
        object: 'chat.completion',
        created: 1,
        model: body.model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Ответ настоящего CLI.' },
          finish_reason: 'stop',
        }],
      }));

      return;
    }

    const chunk = (delta, finishReason = null) => ({
      id: `native-fixture-${sequence}`,
      object: 'chat.completion.chunk',
      created: 1,
      model: 'shared-model',
      choices: [{
        index: 0,
        delta,
        finish_reason: finishReason,
      }],
    });
    const emit = (value) => response.write(`data: ${JSON.stringify(value)}\n\n`);
    const pending = actions[0];
    // Preview оставляет список tools в служебном запросе сжатия. Сценарий действий
    // принадлежит основному ходу и не расходуется на текстовую сводку.
    const compacting = body.messages.at(-1)?.content
      ?.startsWith?.('CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.');
    const action = body.tools?.length && !compacting && (!pending?.when || pending.when(body))
      ? actions.shift() : null;

    if (action?.http) {
      response.writeHead(action.http, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        error: action.error || {
          message: action.errorText,
          type: 'authentication_error',
          code: 'invalid_api_key',
        },
      }));

      return;
    }

    response.writeHead(200, { 'Content-Type': 'text/event-stream' });

    if (action?.hold) {
      emit(chunk({ role: 'assistant', content: 'Начало долгого ответа' }));
      notifyHeld();

      return;
    }

    if (action?.delayMs) {
      emit(chunk({ role: 'assistant', reasoning_content: 'Долгое локальное размышление.' }));
      await delay(action.delayMs);
    }

    if (action?.name || action?.match) {
      const tool = body.tools.find((entry) => action.match
        ? entry.function?.name.includes(action.match) : entry.function?.name === action.name);

      if (!tool) {
        response.end();
        action.missing = body.tools.map((entry) => entry.function?.name);

        return;
      }

      sequence += 1;
      emit(chunk({ role: 'assistant', tool_calls: [{
        index: 0,
        id: `tool-${sequence}`,
        type: 'function',
        function: { name: tool.function.name, arguments: JSON.stringify(action.args) },
      }] }));
      emit(chunk({}, 'tool_calls'));
    } else {
      const deltas = action?.deltas ?? [
        { role: 'assistant', reasoning_content: 'Проверка локального контракта.' },
        { content: 'Ответ настоящего CLI.' },
      ];

      for (const delta of deltas) {
        emit(chunk(delta));
      }

      const usage = {
        prompt_tokens: 20,
        completion_tokens: 8,
        total_tokens: 28,
      };

      emit(chunk({}, 'stop'));
      emit({
        ...chunk({}),
        choices: [],
        usage,
      });
    }

    response.end('data: [DONE]\n\n');
  });

  server.on('connection', (socket) => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
  });
  t.after(async () => {
    for (const socket of connections) {
      socket.destroy();
    }

    await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const settings = sourceSettings(`http://127.0.0.1:${server.address().port}/v1`);

  delete settings.modelProviders.anthropic;

  const fixture = await qwenFixture(t, { native: true, settings });

  const bwrap = spawnSync('/usr/bin/bwrap', ['--ro-bind', '/', '/', '/usr/bin/true'], {
    encoding: 'utf8', timeout: 5000,
  });

  assert.equal(bwrap.status, 0, `environment: bwrap недоступен: ${bwrap.stderr}`);

  return {
    ...fixture,
    requests,
    actions,
    catalog,
    held,
  };
}
