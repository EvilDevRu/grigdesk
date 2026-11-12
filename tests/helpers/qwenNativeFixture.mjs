import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { createAcpClient } from '../../server/src/lib/acp/client.ts';
import { qwenFixture, sourceSettings } from './qwenFixture.mjs';

/**
 * Настоящий Qwen видит только локальный OpenAI-compatible API с синтетическим ключом.
 * Ответы задают реальные native tools; их результат наблюдается в файлах и MCP.
 */
export async function qwenNativeFixture(t, { dashscope = false } = {}) {
  const requests = [];
  const actions = [];
  const classifications = [];
  const classifierReplies = [];
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

    const structuredTool = body.tools?.find((tool) => tool.function?.parameters?.properties?.shouldBlock);
    const classifierSchema = structuredTool?.function.parameters ?? body.response_format?.json_schema?.schema;

    if (classifierSchema?.properties?.shouldBlock) {
      classifications.push(body);

      const decision = classifierReplies.shift() ?? false;
      const content = decision === 'unavailable' ? 'synthetic invalid classifier reply' : JSON.stringify({
        shouldBlock: decision,
        ...(classifierSchema.properties.thinking
          ? { thinking: 'Synthetic local policy decision', reason: 'Synthetic local block' } : {}),
      });

      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        id: 'synthetic-classifier',
        object: 'chat.completion',
        created: 1,
        model: body.model,
        choices: [{
          index: 0,
          message: structuredTool ? {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'synthetic-classification',
              type: 'function',
              function: { name: structuredTool.function.name, arguments: content },
            }],
          } : { role: 'assistant', content },
          finish_reason: structuredTool ? 'tool_calls' : 'stop',
        }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      }));

      return;
    }

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
    const action = body.tools?.length ? actions.shift() : null;

    if (action?.http) {
      response.writeHead(action.http, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: {
        message: action.errorText,
        type: 'authentication_error',
        code: 'invalid_api_key',
      } }));

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
      emit(chunk({ role: 'assistant', reasoning_content: 'Проверка локального контракта.' }));
      emit(chunk({ content: 'Ответ настоящего CLI.' }));
      emit({ ...chunk({}, 'stop'), usage: {
        prompt_tokens: 20,
        completion_tokens: 8,
        total_tokens: 28,
      } });
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

  if (dashscope) {
    const wrapper = path.join(fixture.root, 'bwrap-dashscope');
    const baseUrl = settings.modelProviders.openai[0].baseUrl;

    // Штатный proxy переключает native wire-адаптер на DashScope для loopback API.
    // Настоящие домены и ключи не используются; exec сохраняет PID и контракт reader lease.
    await writeFile(wrapper, '#!/bin/sh\n'
      + `exec /usr/bin/bwrap --setenv DASHSCOPE_PROXY_BASE_URL '${baseUrl}' "$@"\n`, { mode: 0o700 });
    process.env.GRIGDESK_QWEN_BWRAP_BIN = wrapper;
  }

  const bwrap = spawnSync('/usr/bin/bwrap', ['--ro-bind', '/', '/', '/usr/bin/true'], {
    encoding: 'utf8', timeout: 5000,
  });

  assert.equal(bwrap.status, 0, `environment: bwrap недоступен: ${bwrap.stderr}`);

  const metadata = await nativeMetadata(fixture);

  return {
    ...fixture,
    requests,
    actions,
    classifications,
    classifierReplies,
    catalog,
    held,
    metadata,
    readMetadata: () => nativeMetadata(fixture),
  };
}

/**
 * Настоящий CLI доказывает доступность ACP и форму metadata ещё на красной базе.
 * Prompt не отправляется; свои home и cwd не содержат сторонних MCP и hooks.
 */
async function nativeMetadata(fixture) {
  const nonce = 'synthetic-metadata-parent';
  const child = spawn(process.execPath, [fixture.bin, '--acp', '--auth-type', 'openai'], {
    cwd: fixture.workspace,
    env: {
      ...fixture.env,
      QWEN_CODE_PRIVATE_ACP_CAPABILITY: nonce,
      QWEN_CODE_PRIVATE_EXTERNAL_TOOL_GUARD: 'required-v1',
      QWEN_CODE_PRIVATE_EXTERNAL_TOOL_GUARD_PROVIDER: 'attached-v1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = new Promise((resolve) => child.once('close', resolve));
  const client = createAcpClient(child, { requestTimeoutMs: 8000 });

  try {
    const initialized = await client.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'GrigDesk-tests', version: '1' },
      clientCapabilities: {},
      _meta: { 'qwen-code/private-parent-capability': nonce },
    });

    assert.equal(initialized._meta?.['qwen-code/external-tool-guard-ready'], 'required-v1',
      'environment: выбранный native CLI должен поддерживать обязательный guard');

    const session = await client.request('session/new', { cwd: fixture.workspace, mcpServers: [] });

    assert.ok(session.models?.availableModels?.length, 'environment: native metadata недоступна');

    return session.models;
  } finally {
    client.close();
    child.stdin.end();
    child.kill('SIGTERM');
    await closed;
  }
}
