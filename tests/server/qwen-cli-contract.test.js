import assert from 'node:assert/strict';
import { access, mkdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { createWorkTools } from '../../server/src/lib/executors/index.ts';
import { createWorkIpc } from '../../server/src/lib/executors/workIpc.ts';
import { qwenNativeFixture } from '../helpers/qwenNativeFixture.mjs';
import {
  QWEN_KEY, QWEN_TEST_PNG, qwenAdapter, qwenImage, rejectedTurn, runInput, selectedModel, successful,
} from '../helpers/qwenFixture.mjs';

test('Qwen Preview.2 продолжает остановленный первый ход с вложением', {
  timeout: 60000,
}, async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const image = await qwenImage(fixture);
  const controller = new AbortController();
  const original = 'ATTACHMENT_RESUME_ORIGINAL: запомни исходный запрос.';
  const followup = 'ATTACHMENT_RESUME_FOLLOWUP: продолжи тот же разговор.';
  let sessionId;

  fixture.settings.modelProviders.openai[0].generationConfig.modalities = { image: true };
  await fixture.writeSettings(fixture.settings);
  fixture.actions.push({ hold: true });
  t.after(() => controller.abort());

  const running = adapter.run(runInput(fixture, 'shared-model(openai)', {
    attachmentsDir: image.root,
    attachmentPaths: [image.file],
    extraDirs: [image.root],
    message: original,
    signal: controller.signal,
    onSessionCreated(value) {
      sessionId = value;
    },
  }));
  const outcome = running.then((value) => ({ value }), (error) => ({ error }));

  assert.equal(await Promise.race([fixture.held.then(() => 'held'), outcome]), 'held');
  controller.abort();

  const stopped = await outcome;

  assert.equal(stopped.error?.stopped, true);
  assert.equal(stopped.error.sessionId, sessionId);

  const beforeResume = fixture.requests.length;
  const resumed = await adapter.run(runInput(fixture, 'shared-model(openai)', {
    attachmentsDir: image.root,
    sessionId,
    message: followup,
    signal: AbortSignal.timeout(25000),
  }));
  const resumedContext = JSON.stringify(fixture.requests.slice(beforeResume)
    .map((entry) => entry.messages));

  assert.equal(resumed.sessionId, sessionId);
  assert.match(resumed.reply, /Ответ настоящего CLI/);
  assert.ok(resumedContext.includes(original), 'Native resume сохранил исходный запрос');
  assert.ok(resumedContext.includes(followup), 'Продолжение отправлено в ту же память');

  assert.ok(JSON.stringify(fixture.requests[0].messages).includes(QWEN_TEST_PNG.toString('base64')),
    'Картинка первого хода передана настоящему CLI до остановки');
});

test('Qwen Preview.2 сообщает доступные модели без неподтверждённых усилий', {
  timeout: 60000,
}, async (t) => {
  const fixture = await qwenNativeFixture(t);
  const base = fixture.settings.modelProviders.openai[0];
  const ids = ['qwen4-max-preview', 'qwen3.7-max', 'qwen-audio-3.0-asr-flash', 'glm-5.3', 'wan3.0-video'];

  fixture.settings.modelProviders.openai = ids.map((id) => ({
    ...base,
    id,
    name: id,
  }));
  await fixture.writeSettings(fixture.settings);

  const adapter = await qwenAdapter({ runnable: true });
  const catalog = await adapter.catalog(fixture.config);
  const qwen4 = catalog.find((model) => model.name === 'qwen4-max-preview');

  assert.deepEqual(catalog.map(({ name }) => name), ids);
  assert.ok(catalog.every((model) => model.efforts.length === 0));
  assert.equal(qwen4.context, base.generationConfig.contextWindowSize);
  await assert.rejects(adapter.run(runInput(fixture, qwen4.id, { effort: 'xhigh' })), /усилие недоступно/);
  assert.equal(fixture.requests.length, 0);

  const result = await adapter.run(runInput(fixture, 'qwen3.7-max(openai)'));

  assert.match(result.reply, /Ответ настоящего CLI/);
  assert.equal(fixture.requests[0].model, 'qwen3.7-max');
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
  assert.equal(result.contextTokens, undefined);
  assert.equal(result.contextWindow, undefined);
  assert.equal(result.contextCache, undefined);
  assert.equal(progress.at(-1).info.tokensIsEstimate, false);
  assert.equal(progress.at(-1).tokens, 8, 'Выход основного обращения без субагента');
  fixture.catalog.push({ id: 'new-model-without-release' });

  const refreshed = await adapter.catalog(fixture.config, {
    service: { label: 'Локальный API', baseUrl },
  });

  assert.ok(refreshed.some((entry) => entry.id === 'new-model-without-release(openai)'));
  await assert.rejects(access(fixture.file), { code: 'ENOENT' });
  assert.equal(JSON.stringify(result).includes(QWEN_KEY), false);
});

test('Qwen native: токеновые размышление и ответ сохраняют цельность', { timeout: 60000 }, async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const thought = 'Проверяю installUiBrowser: компоненты настоящие, импорты есть.';
  const reply = 'Проверка завершена. Компоненты настоящие.';
  const steps = [];

  fixture.actions.push({ deltas: [
    ...Array.from(thought, (text) => ({ reasoning_content: text })),
    ...Array.from(reply, (content) => ({ content })),
  ] });

  const result = await adapter.run(runInput(fixture, 'shared-model(openai)', {
    onStep: (step) => steps.push(step),
  }));

  assert.deepEqual(steps.filter((step) => step.k === 'think').map((step) => step.text), [thought]);
  assert.deepEqual(steps.filter((step) => step.k === 'text').map((step) => step.text), [reply]);
  assert.equal(result.reply, reply);
});

test('Qwen native: чередующиеся каналы не разрезают слова', { timeout: 60000 }, async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const steps = [];
  const messages = [];

  fixture.actions.push({ deltas: [
    { reasoning_content: 'Проверяю ' },
    { content: 'Компоненты настоя' },
    { reasoning_content: 'компоненты ' },
    { content: 'щие, импорты ' },
    { reasoning_content: 'и импорты.' },
    { content: 'есть.' },
  ] });

  const result = await adapter.run(runInput(fixture, 'shared-model(openai)', {
    onStep: (step) => steps.push(step),
    onAssistantMessage: (message) => messages.push(message),
  }));
  const textSteps = steps.filter((step) => ['think', 'text'].includes(step.k));

  assert.deepEqual(textSteps.filter((step) => step.k === 'think').map((step) => step.text), [
    'Проверяю компоненты и импорты.',
  ]);
  assert.deepEqual(textSteps.filter((step) => step.k === 'text').map((step) => step.text), [
    'Компоненты настоящие, импорты есть.',
  ]);
  assert.deepEqual(messages.map((message) => message.text), ['Компоненты настоящие, импорты есть.']);
  assert.equal(result.reply, 'Компоненты настоящие, импорты есть.');
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

  await writeFile(inputFile, 'native read sentinel');
  fixture.actions.push({ name: 'Read', args: { file_path: inputFile } });

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

  const catalog = await adapter.catalog(fixture.config);

  assert.deepEqual(catalog.map((entry) => entry.id).sort(),
    ['native-added(openai)', 'shared-model(openai)']);
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

  const merged = await adapter.catalog(fixture.config);

  assert.notEqual(await adapter.catalogCacheKey(fixture.config), cacheKey);
  assert.deepEqual(merged.map((entry) => entry.id).sort(),
    ['shared-model(openai)', 'system-model(openai)'],
    'Системный слой сохраняет приоритет над пользовательской записью провайдеров');
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

  const ownWrite = { name: 'Write', args: { file_path: own, content: 'native own write' } };
  const shell = { name: 'Bash', args: { command: `printf native-shell > '${shellFile}'` } };

  fixture.actions.push(ownWrite, shell,
    { name: 'Write', args: { file_path: canary, content: 'BAD' } },
    { name: 'Write', args: {
      file_path: path.join(fixture.workspace, 'escape/canary'), content: 'BAD',
    } },
    { name: 'Bash', args: { command: `printf BAD > '${canary}'` } });

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

test('Qwen ждёт рабочий MCP перед новым и восстановленным ходом', { timeout: 90000 }, async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const model = await selectedModel(adapter, fixture);
  const delayed = path.join(fixture.root, 'delayed-work-mcp.mjs');
  const calls = [];
  const workTools = createWorkTools({
    invoke: async (_scope, input) => {
      calls.push(input.action);

      return [{
        sessionId: 'synthetic',
        projectId: 'demo',
        label: 'local',
        role: 'reader',
      }];
    },
  });
  const ipc = await createWorkIpc({ root: fixture.workspace, workTools });

  fixture.onCleanup(() => ipc.close());
  await writeFile(delayed, [
    "import { setTimeout } from 'node:timers/promises';",
    "import { pathToFileURL } from 'node:url';",
    'await setTimeout(5500);',
    'process.argv.splice(1, 1);',
    'await import(pathToFileURL(process.argv[1]));',
  ].join('\n'));

  const mcpServers = [{
    ...ipc.mcpServer,
    name: 'grigdesk-work',
    args: [delayed, ...ipc.mcpServer.args],
  }];
  let sessionId;

  for (const expectedCalls of [1, 2]) {
    const list = { match: 'supervised_ssh', args: { action: 'list' } };

    fixture.actions.push(list);

    const result = await adapter.run(runInput(fixture, model, {
      permissionMode: 'yolo',
      sessionId,
      signal: AbortSignal.timeout(22000),
      mcpServers,
      workTools,
    }));

    assert.equal(list.missing, undefined, 'SSH объявлен уже в первом запросе к модели');
    assert.deepEqual(calls, Array(expectedCalls).fill('list'));
    assert.ok(result.sessionId);

    if (sessionId) {
      assert.equal(result.sessionId, sessionId);
    }

    sessionId = result.sessionId;
  }
});

test('Qwen показывает отказ рабочего MCP до обращения к модели', { timeout: 60000 }, async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const model = await selectedModel(adapter, fixture);
  const broken = path.join(fixture.root, 'broken-work-mcp.mjs');

  await writeFile(broken, 'process.exitCode = 17;\n');

  const working = await adapter.run(runInput(fixture, model));
  const before = fixture.requests.length;
  const mcpServers = [{
    name: 'grigdesk-work',
    command: process.execPath,
    args: [broken],
    env: [],
  }];

  for (const input of [{ chatKey: 'new-with-broken-mcp' }, { sessionId: working.sessionId }]) {
    await assert.rejects(adapter.run(runInput(fixture, model, { ...input, mcpServers })),
      /Qwen не смог подключить рабочие инструменты GrigDesk/);
    assert.equal(fixture.requests.length, before, 'Пользовательский запрос ещё не отправлен');
  }
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

  const ssh = { name: 'Bash', args: {
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

test('Qwen Preview.2 хранит текст ребёнка в результате его Agent', {
  timeout: 60000,
}, async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const messages = [];

  fixture.actions.push({
    name: 'Agent',
    args: {
      description: 'Проверить вывод текста',
      prompt: 'Ответь одним предложением без инструментов.',
      subagent_type: 'general-purpose',
      run_in_background: false,
    },
  }, {
    deltas: [
      { role: 'assistant', content: 'CHILD_TEXT_SENTINEL' },
    ],
  });

  const outcome = await adapter.run(runInput(fixture, 'shared-model(openai)', {
    onAssistantMessage: (message) => messages.push(message),
    signal: AbortSignal.timeout(45000),
    permissionMode: 'yolo',
  }));
  const result = outcome.steps.find((step) => step.k === 'res' && step.text === 'CHILD_TEXT_SENTINEL');

  assert.equal(result?.ok, true);
  assert.ok(outcome.steps.some((step) => step.k === 'tool' && step.id === result.id && step.name === 'Agent'));
  assert.deepEqual(messages.map((message) => message.text), ['Ответ настоящего CLI.']);
  assert.equal(outcome.reply, 'Ответ настоящего CLI.');
});
