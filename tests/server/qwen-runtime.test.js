import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, lstat, mkdir, readFile, realpath, symlink, truncate, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { acquireCliLease, inspectCliLeases } from '../../server/src/lib/providerInstall/leases.ts';
import { createQwenInTurn } from '../../server/src/lib/qwen/inTurn.ts';
import { readQwenImages } from '../../server/src/lib/qwen/images.ts';
import { CHAT_IMAGE_MAX_BYTES } from '../../server/src/lib/chat/chatImages.ts';
import { qwenNativeFixture } from '../helpers/qwenNativeFixture.mjs';
import { runQwenPreviewStream } from '../helpers/qwenPreviewStream.mjs';
import {
  QWEN_KEY, QWEN_TEST_PNG, qwenAdapter, qwenFixture, qwenImage,
  rejectedTurn, runInput, selectedModel, successful,
} from '../helpers/qwenFixture.mjs';

test('Qwen Preview.2: PNG проходит через ACP до запроса модели', async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const image = await qwenImage(fixture);

  fixture.settings.modelProviders.openai[0].generationConfig.modalities = { image: true };
  await fixture.writeSettings(fixture.settings);

  const input = runInput(fixture, 'shared-model(openai)', {
    attachmentsDir: image.root,
    attachmentPaths: [image.file],
    message: '',
  });
  const result = await adapter.run(input);
  const wire = JSON.stringify(fixture.requests);

  assert.match(result.reply, /Ответ настоящего CLI/);
  assert.ok(wire.includes(`data:image/png;base64,${QWEN_TEST_PNG.toString('base64')}`));
  assert.equal(wire.includes(image.file), false);
});

test('Qwen: границы картинок, сигнатура, размер, отсутствие файла и отмена', async (t) => {
  const fixture = await qwenFixture(t);
  const image = await qwenImage(fixture);
  const outside = path.join(fixture.workspace, 'outside.png');
  const link = path.join(image.root, 'escape.png');
  const fake = path.join(image.root, 'fake.png');
  const oversized = path.join(image.root, 'oversized.png');

  await writeFile(outside, QWEN_TEST_PNG);
  await symlink(outside, link);
  await writeFile(fake, 'Это не картинка');
  await writeFile(oversized, QWEN_TEST_PNG);
  await truncate(oversized, CHAT_IMAGE_MAX_BYTES + 1);

  for (const file of [outside, link, fake, path.join(image.root, 'missing.png')]) {
    await assert.rejects(readQwenImages([file], image.root), /изображение недоступно/);
  }

  await assert.rejects(readQwenImages([oversized], image.root), /превышает 10 МБ/);
  await truncate(oversized, 9 * 1024 * 1024);
  await assert.rejects(readQwenImages(Array(4).fill(oversized), image.root), /общий размер/);
  await assert.rejects(readQwenImages(Array(11).fill(image.file), image.root), /не больше 10/);
  await assert.rejects(readQwenImages([image.file], undefined), /каталог вложений недоступен/);
  await assert.rejects(readQwenImages([image.file], image.root, AbortSignal.abort()), { name: 'AbortError' });
});

test('Qwen: остановка во время чтения картинки не передаёт позднее уточнение', async () => {
  let finishRead;
  let wakes = 0;
  const inTurn = createQwenInTurn({
    available: () => true,
    sendNow: async () => {
      wakes += 1;
    },
    readImages: () => new Promise((resolve) => {
      finishRead = resolve;
    }),
  });
  const pending = inTurn.port.deliver({
    messageId: 'qwen-image-late',
    text: '',
    images: [{ path: '/synthetic/image.png' }],
    sequence: 1,
  });

  inTurn.close();
  finishRead([]);
  assert.equal((await pending).ok, false);
  assert.equal(wakes, 0);
  assert.deepEqual(inTurn.drain().messages, []);
});

/**
 * Canary принадлежит только тесту; отсутствие файла доказывает запрет эффекта.
 * Ошибки доступа и другие ошибки чтения не принимаются за отсутствие записи.
 */
async function absent(file) {
  await assert.rejects(access(file), { code: 'ENOENT' });
}

test('qwen-linked-env-and-project-settings-stay-masked', async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const envTarget = path.join(fixture.root, 'private-env');
  const settingsTarget = path.join(fixture.root, 'private-qwen');
  const envLink = path.join(fixture.workspace, '.env');
  const settingsLink = path.join(fixture.workspace, '.qwen');
  const hiddenSettings = path.join(settingsLink, 'settings.json');
  const resultFile = path.join(fixture.workspace, 'observed-env');

  await writeFile(envTarget, 'PRIVATE_ENV_CANARY');
  await mkdir(settingsTarget);
  await writeFile(path.join(settingsTarget, 'settings.json'), '{"private":"PRIVATE_SETTINGS_CANARY"}');
  await symlink(envTarget, envLink);
  await symlink('../private-qwen', settingsLink);
  fixture.actions.push({
    name: 'Bash',
    args: { command: `test ! -e '${hiddenSettings}' && cat '${envLink}' > '${resultFile}'` },
  });

  const result = await adapter.run(runInput(fixture, 'shared-model(openai)', { permissionMode: 'yolo' }));

  assert.match(result.reply, /Ответ настоящего CLI/);
  assert.equal(await readFile(resultFile, 'utf8'), '{}');
  assert.equal(await readFile(envTarget, 'utf8'), 'PRIVATE_ENV_CANARY');
  assert.match(await readFile(path.join(settingsTarget, 'settings.json'), 'utf8'), /PRIVATE_SETTINGS_CANARY/);
  assert.equal((await lstat(envLink)).isSymbolicLink(), true);
  assert.equal((await lstat(settingsLink)).isSymbolicLink(), true);
});

test('qwen-early-sandbox-exit-keeps-cause-and-releases-reader', async (t) => {
  const fixture = await qwenFixture(t, { native: true });
  const adapter = await qwenAdapter({ runnable: true });
  const wrapper = path.join(fixture.root, 'failed-bwrap');

  await writeFile(wrapper, '#!/bin/sh\n'
    + 'echo "synthetic sandbox startup failure $QWEN_TEST_KEY" >&2\nexit 1\n', { mode: 0o700 });
  process.env.GRIGDESK_QWEN_BWRAP_BIN = wrapper;

  const reason = await rejectedTurn(() => adapter.run(runInput(fixture, 'shared-model(openai)')));

  assert.match(reason, /synthetic sandbox startup failure/);
  assert.equal(reason.includes(QWEN_KEY), false, 'Ранний stderr проходит общую маскировку');
  assert.doesNotMatch(reason, /\/proc\/\d+\/stat/, 'Исчезновение child не подменяет причину запуска');

  const leases = await inspectCliLeases({
    directory: path.join(fixture.dataHome, 'provider-cli-leases'),
    providerId: 'qwen',
  });

  assert.equal(leases.length, 0, 'После раннего выхода копия CLI доступна для следующего запуска');
});

test('Qwen Preview.2: сохранение сессии предшествует ленте инструментов и ответа', async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const inputFile = path.join(fixture.workspace, 'input.txt');
  const steps = [];
  let saved = false;

  await writeFile(inputFile, 'Содержимое разрешённого файла');
  fixture.actions.push({ name: 'Read', args: { file_path: inputFile } });

  const result = await adapter.run(runInput(fixture, 'shared-model(openai)', {
    permissionMode: 'yolo',
    onSessionCreated(id) {
      assert.ok(id);
      assert.equal(fixture.requests.length, 0);
      saved = true;
    },
    onStep(step) {
      if (['think', 'text', 'tool', 'res'].includes(step.k)) {
        assert.equal(saved, true);
      }

      steps.push(step);
    },
  }));

  assert.match(result.reply, /Ответ настоящего CLI/);
  assert.deepEqual(steps, result.steps);
  assert.ok(['think', 'text', 'tool', 'res'].every((kind) => steps.some((step) => step.k === kind)));

  const tool = steps.find((step) => step.k === 'tool');
  const outcome = steps.find((step) => step.k === 'res');

  assert.ok(tool.id);
  assert.equal(outcome.id, tool.id);
  assert.equal(outcome.ok, true);
});

test('Qwen Preview.2: resume использует прежнюю память, смена ключа меняет её identity', async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const model = await selectedModel(adapter, fixture);
  const message = 'Сохрани первую реплику для проверки resume.';
  const first = await adapter.run(runInput(fixture, model, { message }));
  const offset = fixture.requests.length;
  const binding = await adapter.sessionBinding.authProfileId(fixture.config);

  const second = await adapter.run(runInput(fixture, model, {
    sessionId: first.sessionId,
    message: 'Продолжи.',
  }));

  assert.equal(second.sessionId, first.sessionId);
  assert.match(JSON.stringify(fixture.requests.slice(offset)), /Сохрани первую реплику/);

  process.env.QWEN_TEST_KEY = 'synthetic-rotated-key';

  const changed = await adapter.sessionBinding.authProfileId(fixture.config);
  const before = fixture.requests.length;

  assert.notEqual(changed, binding);
  assert.equal(changed.includes('synthetic-rotated-key'), false);
  await assert.rejects(adapter.run(runInput(fixture, model, { sessionId: first.sessionId })), /identity/);
  await assert.rejects(adapter.run(runInput(fixture, model, {
    sessionId: '../foreign-session',
    chatKey: 'foreign-chat',
  })));
  assert.equal(fixture.requests.length, before);
});

test('Qwen Preview.2: отмена до запуска и во время ответа освобождает процесс', async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const model = await selectedModel(adapter, fixture);

  await assert.rejects(adapter.run(runInput(fixture, model, { signal: AbortSignal.abort() })),
    { stopped: true });
  assert.equal(fixture.requests.length, 0);
  fixture.actions.push({ hold: true });

  const controller = new AbortController();
  const running = adapter.run(runInput(fixture, model, { signal: controller.signal }));
  const stopped = assert.rejects(running, (error) => {
    assert.equal(error.stopped, true);
    assert.ok(error.sessionId);

    return true;
  });

  await fixture.held;
  controller.abort();
  await stopped;

  const leases = await inspectCliLeases({
    directory: path.join(fixture.dataHome, 'provider-cli-leases'),
    providerId: 'qwen',
  });

  assert.deepEqual(leases, []);
});

test('Qwen Preview.2: ошибка CLI сохраняет причину и скрывает ключ', async (t) => {
  const failure = new Error(`synthetic failure ${QWEN_KEY}`);

  await assert.rejects(runQwenPreviewStream(t, [], {}, failure), (error) => {
    assert.equal(error.stopped, undefined);
    assert.match(error.message, /synthetic failure/);
    assert.equal(error.message.includes(QWEN_KEY), false);

    return true;
  });
});

test('Qwen: отмена после создания сессии не отправляет prompt', async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const controller = new AbortController();
  let sessionId;

  await assert.rejects(adapter.run(runInput(fixture, 'shared-model(openai)', {
    signal: controller.signal,
    onSessionCreated(value) {
      sessionId = value;
      controller.abort();
    },
  })), (error) => {
    assert.equal(error.stopped, true);
    assert.equal(error.sessionId, sessionId);

    return true;
  });
  assert.equal(fixture.requests.length, 0);
});

test('Qwen: уточнение подтверждается drain один раз; закрытие и отказ снимают ожидание', async () => {
  let available = true;
  let wakes = 0;
  const inTurn = createQwenInTurn({
    available: () => available,
    sendNow: async () => {
      wakes += 1;
    },
  });
  const message = {
    messageId: 'qwen-in-turn-message',
    text: 'Уточнение',
    sequence: 1,
  };
  const delivery = inTurn.port.deliver(message);

  await Promise.resolve();
  assert.equal(wakes, 1);
  available = false;
  assert.deepEqual(inTurn.drain().messages, []);
  assert.equal((await inTurn.port.deliver({ ...message, sequence: 2 })).ok, false);
  available = true;

  const drained = inTurn.drain();

  assert.match(drained.messages[0], /Уточнение/);
  assert.match(drained.messages[0], /вернись к ранее поставленной задаче/);
  assert.deepEqual(await delivery, { ok: true, state: 'forwarded' });
  assert.deepEqual(inTurn.drain().messages, []);

  const pending = inTurn.port.deliver({ ...message, sequence: 3 });

  inTurn.close();
  assert.equal((await pending).ok, false);
  assert.equal((await inTurn.port.deliver({ ...message, sequence: 4 })).ok, false);

  const broken = createQwenInTurn({
    available: () => true,
    sendNow: async () => {
      throw new Error('synthetic RPC failure');
    },
  });

  assert.equal((await broken.port.deliver(message)).ok, false);
  assert.deepEqual(broken.drain().messages, []);
});

test('Qwen Preview.2: обязательное ограничение файлов действует без запроса согласия', async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const target = path.join(fixture.root, 'outside-workspace');

  fixture.actions.push({ name: 'Write', args: { file_path: target, content: 'BAD' } });

  const result = await adapter.run(runInput(fixture, 'shared-model(openai)', {
    permissionMode: 'yolo',
    onPermission() {
      assert.fail('Запись за пределами корней нельзя разрешать');
    },
  }));

  assert.match(result.reply, /Ответ настоящего CLI/);
  assert.equal(fixture.actions.length, 0);
  await absent(target);
});

test('qwen-filesystem-mcp-workdir', async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const capability = typeof adapter.workdir === 'function'
    ? adapter.workdir(fixture.config) : adapter.workdir;

  assert.deepEqual(capability, { switch: 'reseed', roots: 'multi' });
  assert.equal(typeof adapter.validateWorkdir, 'function');

  const sibling = path.join(fixture.root, 'sibling');
  const canary = path.join(sibling, 'canary');

  await mkdir(sibling);
  await writeFile(canary, 'original');
  await symlink(sibling, path.join(fixture.workspace, 'escape'));

  const validation = await adapter.validateWorkdir({
    config: fixture.config,
    cwd: fixture.workspace,
    extraDirs: [sibling],
  });

  assert.equal(validation.error, undefined);
  assert.deepEqual(validation.extraDirs, [sibling]);

  const model = await selectedModel(adapter, fixture);

  for (const file of [canary, path.join(fixture.workspace, 'escape', 'canary')]) {
    fixture.actions.push({ name: 'Write', args: { file_path: file, content: 'bad' } });
    await adapter.run(runInput(fixture, model, { permissionMode: 'yolo' }));
    assert.equal(fixture.actions.length, 0);
    assert.equal(await readFile(canary, 'utf8'), 'original');
  }

  const own = path.join(fixture.workspace, 'own');

  fixture.actions.push({ name: 'Write', args: { file_path: own, content: 'effect' } });
  await adapter.run(runInput(fixture, model, { permissionMode: 'yolo' }));
  assert.equal(await readFile(own, 'utf8'), 'effect', 'Полный запрет tools не заменяет правильную политику');

  const malicious = path.join(fixture.workspace, 'ambient-mcp-started');

  await mkdir(path.join(fixture.workspace, '.qwen'));
  await writeFile(path.join(fixture.workspace, '.qwen/settings.json'), JSON.stringify({
    mcpServers: { hostile: { command: '/bin/sh', args: ['-c', `touch '${malicious}'`] } },
  }));
  await adapter.run(runInput(fixture, model, { mcpServers: [] }));
  await absent(malicious);

  const status = await adapter.mcpStatus(fixture.config);

  assert.equal(JSON.stringify(status).includes(QWEN_KEY), false);
  assert.equal(JSON.stringify(status).includes('"connected":true'), false);
});

test('Qwen Preview.2: reader удерживает проверенный ELF до остановки хода', async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const leaseInput = {
    directory: path.join(fixture.dataHome, 'provider-cli-leases'),
    providerId: 'qwen',
    resourceKey: createHash('sha256').update(await realpath(fixture.bin)).digest('hex'),
  };
  const controller = new AbortController();

  t.after(() => controller.abort());
  fixture.actions.push({ hold: true });

  const running = adapter.run(runInput(fixture, 'shared-model(openai)', { signal: controller.signal }));
  const stopped = assert.rejects(running, { stopped: true });

  await fixture.held;

  const observed = await inspectCliLeases(leaseInput);

  assert.ok(observed.some((holder) => holder.childPid));
  await assert.rejects(acquireCliLease({ ...leaseInput, mode: 'exclusive' }), { code: 'provider_in_use' });
  controller.abort();
  await stopped;
  assert.deepEqual(await inspectCliLeases(leaseInput), []);
});

test('Qwen: контекст и выход из usage-событий, субагент не меняет метрики', async (t) => {
  const progress = [];
  const lifecycle = (executionId, phase, subagentId) => ({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: '' },
    _meta: {
      executionLifecycle: {
        kind: 'request', executionId, phase,
        ...(subagentId ? { subagentId } : {}),
      },
    },
  });
  const usageChunk = (usage) => ({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: '' },
    _meta: { usage },
  });

  const updates = [
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Думаю' } },
      lifecycle('req-1', 'started'),
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Новый ответ' } },
      lifecycle('req-1', 'ended'),
      usageChunk({ inputTokens: 120, outputTokens: 8, totalTokens: 128, cachedReadTokens: 40 }),
      { sessionUpdate: 'usage_update', used: 120, size: 32768 },
      lifecycle('req-2', 'started'),
      lifecycle('req-2', 'ended'),
      usageChunk({ inputTokens: 140, outputTokens: 5, totalTokens: 145, cachedReadTokens: 120 }),
      { sessionUpdate: 'usage_update', used: 140, size: 32768 },
      usageChunk({ inputTokens: 1.5, outputTokens: -7 }),
      { sessionUpdate: 'usage_update', used: 'много', size: 0 },
      lifecycle('sub-1', 'started', 'extractor'),
      usageChunk({ inputTokens: 900, outputTokens: 90, cachedReadTokens: 0 }),
      { sessionUpdate: 'usage_update', used: 900, size: 32768 },
      lifecycle('sub-1', 'ended', 'extractor'),
  ];

  const result = await runQwenPreviewStream(t, updates, {
    onProgress: (tokens, info) => progress.push({ tokens, info }),
  });

  assert.equal(successful(result), true, JSON.stringify(result));
  assert.ok(progress.some((entry) => entry.info.contextTokens === 120), 'живой замер по ходу');

  const last = progress.at(-1);

  assert.equal(last.tokens, 13, 'выход — сумма обращений основного агента');
  assert.equal(last.info.tokensIsEstimate, false);
  assert.equal(last.info.contextTokens, 140);
  assert.equal(last.info.contextWindow, 32768);
  assert.deepEqual(last.info.contextCache, {
    scope: 'request', status: 'reported', readTokens: 120, uncachedTokens: 20,
  });
  assert.equal(result.contextTokens, 140);
  assert.equal(result.contextWindow, 32768);
  assert.equal(result.contextMetric, 'qwen-acp-usage-update');
  assert.deepEqual(result.contextCache, last.info.contextCache);
});

test('Qwen: документация плагина доступна только для чтения без открытия пакета', async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const plugin = path.join(fixture.root, 'plugin');
  const docs = path.join(plugin, 'docs');
  const index = path.join(docs, 'README.md');
  const outside = path.join(plugin, 'private.txt');
  const attempt = path.join(docs, 'forbidden');
  const report = path.join(fixture.workspace, 'docs-probe');

  await mkdir(docs, { recursive: true });
  await writeFile(index, 'PLUGIN_DOC_SENTINEL');
  await writeFile(outside, 'PLUGIN_PRIVATE_SENTINEL');
  fixture.actions.push(
    { name: 'Bash', args: { command: `test ! -e '${outside}' && cat '${index}' > '${report}'` } },
    { name: 'Write', args: { file_path: attempt, content: 'BAD' } },
  );
  await adapter.run(runInput(fixture, 'shared-model(openai)', {
    permissionMode: 'yolo',
    pluginDocsDirs: [docs, docs],
  }));

  assert.equal(fixture.actions.length, 0);
  assert.equal(await readFile(report, 'utf8'), 'PLUGIN_DOC_SENTINEL');
  assert.equal(await readFile(index, 'utf8'), 'PLUGIN_DOC_SENTINEL');
  await assert.rejects(access(attempt), { code: 'ENOENT' });
});
