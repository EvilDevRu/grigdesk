import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { createWorkTools } from '../../server/src/lib/executors/index.ts';
import { createWorkIpc } from '../../server/src/lib/executors/workIpc.ts';
import { qwenNativeFixture } from '../helpers/qwenNativeFixture.mjs';
import { qwenAdapter, runInput, selectedModel, until } from '../helpers/qwenFixture.mjs';

const execute = promisify(execFile);

test('Qwen Preview.2: проверенная поставка, tool permission и продолжение через реальный ACP', {
  skip: !process.env.GRIGDESK_QWEN_PREVIEW_TEST && 'Требуется установленный ELF Qwen Preview.2',
  timeout: 60000,
}, async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });

  fixture.settings.modelProviders.openai.push({
    ...fixture.settings.modelProviders.openai[0],
    id: 'second-model',
    name: 'Вторая локальная модель',
  });
  await fixture.writeSettings(fixture.settings);

  const model = await selectedModel(adapter, fixture, 'Вторая локальная модель');
  const allowed = path.join(fixture.workspace, 'allowed.txt');
  const denied = path.join(fixture.workspace, 'denied.txt');

  assert.deepEqual(await adapter.probe(fixture.config), { ok: true, version: '1.0.0-preview.2' });

  fixture.actions.push({
    name: 'Bash',
    args: { command: 'test -z "$QWEN_TEST_KEY" && test ! -w /tmp/qwen-config && printf ok > allowed.txt' },
  });

  const progress = [];
  const first = await adapter.run(runInput(fixture, model, {
    message: 'Первая реплика smoke Preview.2',
    permissionMode: 'yolo',
    onProgress: (tokens) => progress.push(tokens),
  }));

  assert.equal(await readFile(allowed, 'utf8'), 'ok');
  assert.match(first.reply, /Ответ настоящего CLI/);
  assert.equal(first.actualModel, model);
  assert.ok(progress.some((tokens) => tokens > 0));
  assert.ok(fixture.requests.some((request) => request.model === 'second-model'));

  const nextPrompt = 'Вторая реплика smoke Preview.2';
  const requestsBeforeResume = fixture.requests.length;

  fixture.actions.push({
    name: 'Bash',
    args: { command: 'printf bad > denied.txt' },
    when: (body) => JSON.stringify(body.messages.at(-1)?.content || '').includes(nextPrompt),
  });

  const approvals = [];

  const resumed = await adapter.run(runInput(fixture, model, {
    sessionId: first.sessionId,
    message: nextPrompt,
    permissionMode: 'default',
    onPermission(question) {
      approvals.push(question);

      return { allow: false };
    },
  }));

  assert.equal(resumed.sessionId, first.sessionId);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].name, 'Bash');
  await assert.rejects(access(denied), { code: 'ENOENT' });

  const resumedRequests = fixture.requests.slice(requestsBeforeResume);

  assert.match(JSON.stringify(resumedRequests), /Первая реплика smoke Preview.2/);
});

test('Qwen Preview.2: штатный рабочий MCP доступен через обязательный допуск', {
  skip: !process.env.GRIGDESK_QWEN_PREVIEW_TEST && 'Требуется установленный ELF Qwen Preview.2',
  timeout: 45000,
}, async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const model = await selectedModel(adapter, fixture);
  const actions = [];
  const workTools = createWorkTools({
    invoke: async (_scope, input) => {
      actions.push(input.action);

      return [];
    },
  });
  const ipc = await createWorkIpc({ root: fixture.workspace, workTools });

  fixture.onCleanup(() => ipc.close());

  const action = { match: 'supervised_ssh', args: { action: 'list' } };

  fixture.actions.push(action);

  const reply = await adapter.run(runInput(fixture, model, {
    permissionMode: 'yolo',
    mcpServers: [{ name: 'grigdesk-work', ...ipc.mcpServer }],
  }));

  assert.equal(action.missing, undefined);
  assert.deepEqual(actions, ['list']);
  assert.match(reply.reply, /Ответ настоящего CLI/);
});

test('Qwen Preview.2: entry point фабрики записывает итог хода', {
  skip: !process.env.GRIGDESK_QWEN_PREVIEW_TEST && 'Требуется установленный ELF Qwen Preview.2',
  timeout: 45000,
}, async (t) => {
  const fixture = await qwenNativeFixture(t);
  const script = fileURLToPath(new URL('../../server/scripts/qwenRunner.mts', import.meta.url));
  const runDir = path.join(fixture.root, 'run');
  const requests = path.join(fixture.root, 'status-requests');
  const prompt = path.join(runDir, 'prompt.md');

  await mkdir(runDir);
  await mkdir(requests);
  await writeFile(prompt, 'Локальная проверка Preview.2 в фабрике', { mode: 0o600 });

  const result = await execute(process.execPath, [
    script,
    '--bin', fixture.bin,
    '--cwd', fixture.workspace,
    '--run-dir', runDir,
    '--runtime-home', path.join(runDir, 'qwen-runtime'),
    '--prompt-file', prompt,
    '--mode', 'workspace-write',
    '--model', 'shared-model(openai)',
  ], {
    cwd: fixture.workspace,
    env: {
      ...fixture.env,
      FACTORY_RUN_TASK: '101',
      FACTORY_RUN_STAGE: 'BUILD',
      FACTORY_RUN_ID: 'preview-fixture',
      FACTORY_RUN_EPOCH: '1',
      FACTORY_STATUS_MODE: 'request',
      FACTORY_STATUS_REQUEST_DIR: requests,
    },
    timeout: 20000,
  });

  assert.match(result.stdout, /"stopReason":"end_turn"/);
  assert.match(await readFile(path.join(runDir, 'last.md'), 'utf8'), /Ответ настоящего CLI/);
});

test('Qwen Preview.2: обычный ACP отвечает на уточнение в той же сессии отдельным блоком', {
  skip: !process.env.GRIGDESK_QWEN_PREVIEW_TEST && 'Требуется установленный ELF Qwen Preview.2',
  timeout: 45000,
}, async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const model = await selectedModel(adapter, fixture);
  const assistantBlocks = [];
  const receipts = [];
  let port;

  fixture.actions.push({
    delayMs: 550,
    deltas: [{ content: 'Первый ответ Preview.' }],
  }, {
    when: (body) => JSON.stringify(body.messages.at(-1)?.content || '').includes('Вопрос в очередь'),
    deltas: [{ content: 'Ответ на уточнение Preview.' }],
  });

  const run = adapter.run(runInput(fixture, model, {
    onInTurnReady(value) {
      port = value;
    },
    onAssistantMessage(event) {
      assistantBlocks.push(event.text);
    },
    onInTurnReceipt(event) {
      receipts.push(event);
    },
  }));

  await until(() => port && fixture.requests.length === 1, 'Первый запрос и порт уточнений');

  const forwarded = await port.deliver({
    messageId: 'preview-follow-up',
    text: 'Вопрос в очередь',
    sequence: 1,
  });
  const result = await run;

  assert.equal(forwarded.ok && forwarded.state, 'forwarded');
  assert.deepEqual(assistantBlocks, ['Первый ответ Preview.', 'Ответ на уточнение Preview.']);
  assert.equal(result.reply, 'Ответ на уточнение Preview.');
  assert.deepEqual(result.turnTokens, { inputTokens: 40, outputTokens: 16 });
  assert.deepEqual(receipts, [{ messageId: 'preview-follow-up', state: 'consumed' }]);
});

test('Qwen Preview.2: HTTP 402 в API-режиме отказывает ходу и не подставляет нулевую квоту', {
  skip: !process.env.GRIGDESK_QWEN_PREVIEW_TEST && 'Требуется установленный ELF Qwen Preview.2',
  timeout: 45000,
}, async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const model = await selectedModel(adapter, fixture);
  const resetAt = Math.floor(Date.now() / 1000) + 7200;

  fixture.actions.push({
    http: 402,
    error: {
      message: 'Synthetic model quota exhausted',
      code: 'insufficient_quota',
      quota: { member_type: 'pro', reset_at: resetAt },
    },
  });

  await assert.rejects(adapter.run(runInput(fixture, model)), /Synthetic model quota exhausted/);

  assert.ok(fixture.requests.length > 0);
  assert.equal(fixture.actions.length, 0);
  assert.equal(adapter.usage(fixture.config).state, 'unsupported');
});
