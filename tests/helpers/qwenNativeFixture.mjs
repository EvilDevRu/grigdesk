import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';

import { createAcpClient } from '../../server/src/lib/acp/client.ts';
import { qwenFixture, sourceSettings } from './qwenFixture.mjs';

/**
 * Настоящий Qwen видит только локальный OpenAI-compatible API с синтетическим ключом.
 * Ответы задают реальные native tools; их результат наблюдается в файлах и MCP.
 */
export async function qwenNativeFixture(t) {
  const requests = [];
  const actions = [];
  const connections = new Set();
  let sequence = 0;
  let notifyHeld;
  const held = new Promise((resolve) => {
    notifyHeld = resolve;
  });
  const server = createServer(async (request, response) => {
    let text = '';

    for await (const chunk of request) {
      text += chunk;
    }

    const body = JSON.parse(text);

    requests.push(body);

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

    if (action) {
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
  const bwrap = spawnSync('/usr/bin/bwrap', ['--ro-bind', '/', '/', '/usr/bin/true'], {
    encoding: 'utf8', timeout: 5000,
  });

  assert.equal(bwrap.status, 0, `environment: bwrap недоступен: ${bwrap.stderr}`);

  const metadata = await nativeMetadata(fixture);

  return {
    ...fixture,
    requests,
    actions,
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
