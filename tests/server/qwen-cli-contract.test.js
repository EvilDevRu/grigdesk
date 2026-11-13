import assert from 'node:assert/strict';
import { access, mkdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { createWorkIpc } from '../../server/src/lib/executors/workIpc.ts';
import { qwenNativeFixture } from '../helpers/qwenNativeFixture.mjs';
import {
  QWEN_KEY, qwenAdapter, rejectedTurn, runInput, selectedModel, successful,
} from '../helpers/qwenFixture.mjs';

test('qwen-native-model-specific-efforts-and-dashscope-wire', { timeout: 60000 }, async (t) => {
  const fixture = await qwenNativeFixture(t, { dashscope: true });
  const base = fixture.settings.modelProviders.openai[0];

  fixture.settings.modelProviders.openai = [
    'qwen4-max-preview', 'qwen3.7-max', 'qwen-audio-3.0-asr-flash', 'glm-5.3', 'wan3.0-video',
  ]
    .map((id) => ({
      ...base,
      id,
      name: id,
      generationConfig: {},
    }));
  await fixture.writeSettings(fixture.settings);

  const adapter = await qwenAdapter({ runnable: true });
  const catalog = await adapter.catalog(fixture.config);
  const qwen4 = catalog.find((model) => model.name === 'qwen4-max-preview');

  assert.deepEqual(qwen4.efforts, ['none', 'low', 'medium', 'xhigh']);
  assert.deepEqual(catalog.find((model) => model.name === 'qwen3.7-max').efforts, ['none', 'default']);
  assert.deepEqual(catalog.find((model) => model.name === 'qwen-audio-3.0-asr-flash').efforts, []);
  assert.deepEqual(catalog.find((model) => model.name === 'glm-5.3').efforts, []);
  assert.deepEqual(catalog.find((model) => model.name === 'wan3.0-video').efforts, []);
  assert.ok(qwen4.context > 0 && !qwen4.contextUnverified, 'Размер сообщает native CLI');

  for (const effort of qwen4.efforts) {
    const offset = fixture.requests.length;
    const result = await adapter.run(runInput(fixture, qwen4.id, { effort }));
    const wire = fixture.requests.slice(offset).find((request) => request.tools?.length);

    assert.match(result.reply, /Ответ настоящего CLI/);
    assert.equal(wire.model, 'qwen4-max-preview');
    assert.equal(wire.reasoning_effort, effort, 'Выбранный уровень доходит до API выбранного сервиса');
  }
});

test('qwen-native-clean-install-generated-catalog-and-turn', { timeout: 60000 }, async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const baseUrl = fixture.settings.modelProviders.openai[0].baseUrl;

  await rm(fixture.file);
  delete process.env.GRIGDESK_QWEN_SERVICE;

  const catalog = await adapter.catalog(fixture.config, {
    service: { label: 'Локальный API', baseUrl },
  });

  assert.deepEqual(catalog.map((entry) => entry.id), ['shared-model(openai)']);

  const steps = [];
  const metadata = [];
  const progress = [];
  const result = await adapter.run(runInput(fixture, catalog[0].id, {
    onStep: (step) => steps.push(step),
    onRunMetadata: (value) => metadata.push(value),
    onProgress: (tokens, info) => progress.push({ tokens, info }),
  }));

  assert.equal(successful(result), true, JSON.stringify(result));
  assert.match(result.reply, /Ответ настоящего CLI/);
  assert.ok(steps.some((step) => step.k === 'text'));
  assert.equal(steps.filter((step) => step.k === 'think').length, 1);
  assert.equal(steps.filter((step) => step.k === 'text').length, 1);
  assert.deepEqual(steps, result.steps);
  assert.equal(result.actualModel, catalog[0].id);
  assert.ok(metadata.some((value) => value.actualModelId === catalog[0].id
    && value.modelSource === 'session'));
  assert.equal(result.contextTokens, 20, 'Контекст приходит из usage_update настоящего CLI');
  assert.ok(Number.isSafeInteger(result.contextWindow) && result.contextWindow > 0,
    'Окно объявляет сам CLI, а не каталог');
  assert.equal(result.contextMetric, 'qwen-acp-usage-update');
  assert.deepEqual(result.contextCache, {
    scope: 'request', status: 'reported', readTokens: 0, uncachedTokens: 20,
  });
  assert.ok(progress.some((entry) => entry.info?.contextTokens === 20
    && entry.info?.contextWindow === result.contextWindow), 'Живой замер контекста по ходу');
  assert.equal(progress.at(-1).tokens, 8, 'Выход основного обращения без субагента');
  fixture.catalog.push({ id: 'new-model-without-release' });

  const refreshed = await adapter.catalog(fixture.config, {
    service: { label: 'Локальный API', baseUrl },
  });

  assert.ok(refreshed.some((entry) => entry.id === 'new-model-without-release(openai)'));
  await assert.rejects(access(fixture.file), { code: 'ENOENT' });
  assert.equal(JSON.stringify(result).includes(QWEN_KEY), false);
});

test('qwen-native-prompt-survives-30-seconds', { timeout: 60000 }, async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const model = await selectedModel(adapter, fixture);
  const live = [];

  fixture.actions.push({ delayMs: 31_000 });

  const started = Date.now();
  const result = await adapter.run(runInput(fixture, model, {
    signal: AbortSignal.timeout(45_000),
    onStep: (step) => live.push(step),
  }));

  assert.ok(Date.now() - started >= 31_000, 'Проверяется реальное ожидание, часы не подменены');
  assert.equal(successful(result), true, JSON.stringify(result));
  assert.match(result.reply, /Ответ настоящего CLI/);
  assert.match(live.find((step) => step.k === 'think').text, /Долгое локальное размышление/);
  assert.deepEqual(live, result.steps);
});

test('qwen-native-catalog-stream-resume-abort', { timeout: 60000 }, async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const model = await selectedModel(adapter, fixture);
  const inputFile = path.join(fixture.workspace, 'input.txt');
  const steps = [];
  let created;

  assert.ok(fixture.metadata.availableModels.some((entry) => entry.modelId === model));

  await writeFile(inputFile, 'native read sentinel');
  fixture.actions.push({ name: 'read_file', args: { file_path: inputFile } });

  const first = await adapter.run(runInput(fixture, model, {
    signal: AbortSignal.timeout(25000),
    onSessionCreated: async (id) => {
      created = id;
    },
    onStep: (step) => {
      if (['think', 'text', 'tool', 'res'].includes(step.k)) {
        assert.ok(created, 'Native сессия сохраняется до потока');
      }

      steps.push(step);
    },
    onPermission: async () => ({ allow: true }),
  }));

  assert.equal(successful(first), true, JSON.stringify(first));
  assert.equal(first.sessionId, created);
  assert.match(String(first.reply), /Ответ настоящего CLI/);
  assert.ok(['think', 'text', 'tool', 'res'].every((kind) => steps.some((step) => step.k === kind)));
  assert.ok(steps.some((step) => step.k === 'res' && step.ok === true && step.error === false),
    'Разрешённый read_file должен завершиться чтением, а не ошибкой аргументов или отказом');
  assert.ok(fixture.requests.some((request) =>
    JSON.stringify(request.messages).includes('native read sentinel')),
    'API должен получить содержимое разрешённого файла, отказ чтением не считается');

  const second = await adapter.run(runInput(fixture, model, {
    sessionId: first.sessionId,
    message: 'Продолжи тот же разговор.',
    signal: AbortSignal.timeout(25000),
  }));

  assert.equal(second.sessionId, first.sessionId);
  assert.equal(successful(second), true);

  const controller = new AbortController();

  t.after(() => controller.abort());

  fixture.actions.push({ hold: true });

  const running = adapter.run(runInput(fixture, model, {
    sessionId: second.sessionId, signal: controller.signal,
  }));
  const outcome = running.then((result) => ({ result }), (error) => ({ error }));
  const reached = await Promise.race([fixture.held.then(() => 'held'), outcome]);

  assert.equal(reached, 'held', 'Отмена должна проверяться во время живого native потока');
  controller.abort();
  await rejectedTurn(() => running);

  fixture.settings.modelProviders.openai.push({
    id: 'native-added',
    name: 'Новая модель',
    envKey: 'QWEN_TEST_KEY',
    baseUrl: fixture.settings.modelProviders.openai[0].baseUrl,
  });
  await fixture.writeSettings(`// Источник CLI допускает комментарии\n${JSON.stringify(fixture.settings)}`);

  const expected = await fixture.readMetadata();
  const catalog = await adapter.catalog(fixture.config);

  assert.deepEqual(catalog.map((entry) => entry.id).sort(),
    expected.availableModels.map((entry) => entry.modelId).sort());
  assert.ok(catalog.some((entry) => entry.id === 'native-added(openai)'));

  const systemFile = fixture.env.QWEN_CODE_SYSTEM_SETTINGS_PATH;
  const systemStat = await stat(systemFile);
  const cacheKey = await adapter.catalogCacheKey(fixture.config);
  const baseModel = fixture.settings.modelProviders.openai[0];

  await writeFile(systemFile, JSON.stringify({ modelProviders: { openai: [baseModel, {
    ...baseModel,
    id: 'system-model',
    name: 'Системная модель',
  }] } }));
  await utimes(systemFile, systemStat.atime, systemStat.mtime);

  const nativeSystem = await fixture.readMetadata();
  const merged = await adapter.catalog(fixture.config);

  assert.notEqual(await adapter.catalogCacheKey(fixture.config), cacheKey);
  assert.deepEqual(merged.map((entry) => entry.id).sort(),
    nativeSystem.availableModels.map((entry) => entry.modelId).sort(),
    'Приоритет слоёв берётся из того же CLI, а не из догадки теста');
});

test('qwen-native-never-and-filesystem', { timeout: 60000 }, async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const model = await selectedModel(adapter, fixture);
  const sibling = path.join(fixture.root, 'sibling');
  const canary = path.join(sibling, 'canary');
  const own = path.join(fixture.workspace, 'own.txt');
  const shellFile = path.join(fixture.workspace, 'shell.txt');
  let questions = 0;

  await mkdir(sibling);
  await writeFile(canary, 'original');
  await symlink(sibling, path.join(fixture.workspace, 'escape'));

  const ownWrite = { name: 'write_file', args: { file_path: own, content: 'native own write' } };
  const shell = { name: 'run_shell_command', args: { command: `printf native-shell > '${shellFile}'` } };

  fixture.actions.push(ownWrite, shell,
    { name: 'write_file', args: { file_path: canary, content: 'BAD' } },
    { name: 'write_file', args: {
      file_path: path.join(fixture.workspace, 'escape/canary'), content: 'BAD',
    } },
    { name: 'run_shell_command', args: { command: `printf BAD > '${canary}'` } });

  const result = await adapter.run(runInput(fixture, model, {
    permissionMode: 'yolo',
    signal: AbortSignal.timeout(45000),
    onPermission: async () => {
      questions += 1;

      return { allow: false };
    },
  }));

  assert.equal(successful(result), true, JSON.stringify(result));
  assert.equal(ownWrite.missing, undefined, 'Native write_file должен действительно вызываться');
  assert.equal(shell.missing, undefined, 'Native shell должен действительно вызываться');
  assert.equal(await readFile(own, 'utf8'), 'native own write');
  assert.equal(await readFile(shellFile, 'utf8'), 'native-shell');
  assert.equal(await readFile(canary, 'utf8'), 'original');
  assert.equal(questions, 0, 'Режим never не должен задавать человеку вопросы');
});

test('qwen-native-final-guard-fails-closed', { timeout: 60000 }, async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const model = await selectedModel(adapter, fixture);
  const canary = path.join(fixture.workspace, 'ssh-effect');
  const ambient = path.join(fixture.workspace, 'ambient-mcp-started');
  const sourceBefore = await readFile(fixture.file, 'utf8');
  const invocations = [];
  const workTools = {
      descriptors: [{
        name: 'allowed_probe',
        description: 'Локальная проверка MCP',
        inputSchema: { type: 'object', properties: {} },
      }],
      invoke: async (name) => {
        invocations.push(name);

        return { content: [{ type: 'text', text: 'allowed-mcp-sentinel' }] };
      },
  };
  const work = await createWorkIpc({
    root: fixture.workspace,
    workTools,
  });

  t.after(() => work.close());
  await mkdir(path.join(fixture.workspace, '.qwen'));
  await writeFile(path.join(fixture.workspace, '.qwen/settings.json'), JSON.stringify({
    mcpServers: { foreign: { command: '/bin/sh', args: ['-c', `touch '${ambient}'`] } },
  }));

  const ssh = { name: 'run_shell_command', args: {
    command: `ssh example.invalid true; printf BAD > '${canary}'`,
  } };
  const mcp = { match: 'allowed_probe', args: {} };

  fixture.actions.push(ssh, mcp);

  const result = await adapter.run(runInput(fixture, model, {
    permissionMode: 'yolo',
    signal: AbortSignal.timeout(45000),
    providerSettings: { blockDirectSsh: true },
    mcpServers: [{ name: 'grigdesk-work', ...work.mcpServer }],
    workTools,
    onPermission: async () => ({ allow: true }),
  }));

  assert.equal(successful(result), true, JSON.stringify(result));
  assert.equal(ssh.missing, undefined);
  assert.equal(mcp.missing, undefined, 'Разрешённый MCP должен оставаться доступен');
  assert.deepEqual(invocations, ['allowed_probe']);
  await assert.rejects(access(canary), { code: 'ENOENT' });
  await assert.rejects(access(ambient), { code: 'ENOENT' });
  assert.equal(await readFile(fixture.file, 'utf8'), sourceBefore);
  assert.equal(JSON.stringify(result).includes(QWEN_KEY), false);

  const before = fixture.requests.length;

  await rejectedTurn(() => adapter.run(runInput(fixture, model, { sessionId: '../invalid-session' })));
  assert.equal(fixture.requests.length, before, 'Неверная identity отклоняется до обращения к модели');

  fixture.actions.push({ http: 401, errorText: `synthetic unauthorized ${QWEN_KEY}` });

  const reason = await rejectedTurn(() => adapter.run(runInput(fixture, model)));

  assert.match(reason, /401|unauthorized|авторизац|authentication/i);
  assert.equal(reason.includes(QWEN_KEY), false, 'Ошибка API должна сохранять причину без секрета');
});
