import assert from 'node:assert/strict';
import { access, lstat, mkdir, readFile, symlink, truncate, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { acquireCliLease, inspectCliLeases } from '../../server/src/lib/providerInstall/leases.ts';
import { prepareExternalCliRuntime } from '../../server/src/lib/providerInstall/externalCliRuntime.ts';
import { createQwenInTurn } from '../../server/src/lib/qwen/inTurn.ts';
import { readQwenImages } from '../../server/src/lib/qwen/images.ts';
import { CHAT_IMAGE_MAX_BYTES } from '../../server/src/lib/chat/chatImages.ts';
import {
  QWEN_KEY, QWEN_TEST_PNG, qwenAdapter, qwenFixture, qwenImage,
  rejectedTurn, runInput, selectedModel, successful, until,
} from '../helpers/qwenFixture.mjs';

test('Qwen: PNG передаётся байтами; несовместимый CLI отказывает до prompt', async (t) => {
  const fixture = await qwenFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const image = await qwenImage(fixture);
  const input = runInput(fixture, 'shared-model(openai)', {
    attachmentsDir: image.root,
    attachmentPaths: [image.file],
    message: '',
  });
  const result = await adapter.run(input);
  const prompt = (await fixture.records()).find((entry) => entry.frame?.method === 'session/prompt');

  assert.equal(result.reply, 'Новый ответ');
  assert.deepEqual(prompt.frame.params.prompt[1], {
    type: 'image',
    mimeType: 'image/png',
    data: QWEN_TEST_PNG.toString('base64'),
  });
  await fixture.fake({ images: false });

  const before = (await fixture.records()).filter((entry) => entry.frame?.method === 'session/prompt').length;

  await assert.rejects(adapter.run(input), /CLI не поддерживает изображения/);
  assert.equal((await fixture.records()).filter((entry) => entry.frame?.method === 'session/prompt').length,
    before);
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
  const fixture = await qwenFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const envTarget = path.join(fixture.root, 'private-env');
  const settingsTarget = path.join(fixture.root, 'private-qwen');
  const envLink = path.join(fixture.workspace, '.env');
  const settingsLink = path.join(fixture.workspace, '.qwen');
  const hiddenSettings = path.join(settingsLink, 'settings.json');

  await writeFile(envTarget, 'PRIVATE_ENV_CANARY');
  await mkdir(settingsTarget);
  await writeFile(path.join(settingsTarget, 'settings.json'), '{"private":"PRIVATE_SETTINGS_CANARY"}');
  await symlink(envTarget, envLink);
  await symlink('../private-qwen', settingsLink);
  await fixture.fake({ readMasks: [envLink, hiddenSettings] });

  const result = await adapter.run(runInput(fixture, 'shared-model(openai)'));
  const masks = (await fixture.records()).filter((entry) => entry.event === 'mask');

  assert.equal(result.reply, 'Новый ответ');
  assert.deepEqual(masks.map((entry) => [entry.file, entry.text, entry.code]), [
    [envLink, '{}', undefined],
    [hiddenSettings, undefined, 'ENOENT'],
  ]);
  assert.equal(await readFile(envTarget, 'utf8'), 'PRIVATE_ENV_CANARY');
  assert.match(await readFile(path.join(settingsTarget, 'settings.json'), 'utf8'), /PRIVATE_SETTINGS_CANARY/);
  assert.equal((await lstat(envLink)).isSymbolicLink(), true);
  assert.equal((await lstat(settingsLink)).isSymbolicLink(), true);
});

test('qwen-early-sandbox-exit-keeps-cause-and-releases-reader', async (t) => {
  const fixture = await qwenFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const wrapper = path.join(fixture.root, 'failed-bwrap');
  const runtime = await prepareExternalCliRuntime(adapter, fixture.config, fixture.env);

  await writeFile(wrapper, '#!/bin/sh\n'
    + 'echo "synthetic sandbox startup failure $QWEN_TEST_KEY" >&2\nexit 1\n', { mode: 0o700 });
  process.env.GRIGDESK_QWEN_BWRAP_BIN = wrapper;

  const reason = await rejectedTurn(() => adapter.run(runInput(fixture, 'shared-model(openai)')));

  assert.match(reason, /synthetic sandbox startup failure/);
  assert.equal(reason.includes(QWEN_KEY), false, 'Ранний stderr проходит общую маскировку');
  assert.doesNotMatch(reason, /\/proc\/\d+\/stat/, 'Исчезновение child не подменяет причину запуска');

  const leases = await inspectCliLeases({
    directory: runtime.process.leaseDirectory,
    providerId: 'qwen',
    resourceKey: runtime.process.resourceKey,
  });

  assert.equal(leases.length, 0, 'После раннего выхода копия CLI доступна для следующего запуска');
});

test('qwen-acp-steps-and-final', async (t) => {
  const fixture = await qwenFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const model = await selectedModel(adapter, fixture);
  const inputFile = path.join(fixture.workspace, 'input.txt');
  const steps = [];
  let saved = false;

  await writeFile(inputFile, 'Содержимое разрешённого файла');
  await fixture.fake({ tool: { name: 'read_file', args: { file_path: inputFile } } });

  const result = await adapter.run(runInput(fixture, model, {
    onSessionCreated: async (id) => {
      assert.ok(id);
      assert.equal((await fixture.records()).some((item) => item.frame?.method === 'session/prompt'), false);
      saved = true;
    },
    onStep: (step) => {
      if (['think', 'text', 'tool', 'res'].includes(step.k)) {
        assert.equal(saved, true, 'Сессия должна быть сохранена до публикации шага');
      }

      steps.push(step);
    },
  }));

  assert.equal(successful(result), true, JSON.stringify(result));
  assert.equal(result.reply, 'Новый ответ');
  assert.ok(result.sessionId);
  assert.ok(['think', 'text', 'tool', 'res'].every((kind) => steps.some((step) => step.k === kind)));

  const tools = steps.filter((step) => step.k === 'tool');
  const results = steps.filter((step) => step.k === 'res');

  assert.equal(tools.length, 1);
  assert.equal(results.length, 1);
  assert.ok(tools[0].id, 'Идентификатор инструмента не должен быть пустым');
  assert.equal(tools[0].id, results[0].id, 'Результат относится к тому же инструменту');
  assert.equal(results[0].ok, true, 'Лента должна показывать успешный инструмент без отметки ошибки');
  assert.equal(results[0].error, false);

  const handshake = (await fixture.records()).find((item) => item.event === 'handshake');

  assert.equal(handshake.matched, true, 'Native private-parent nonce должен совпадать');
  assert.equal(handshake.guard, 'required-v1');
  assert.equal(handshake.provider, 'attached-v1');

  const modes = await adapter.modes(fixture.config);

  assert.deepEqual(modes.map((mode) => mode.id).sort(), ['auto', 'default', 'plan', 'yolo']);

  const modeCases = [['default', 'default'], ['auto', 'auto'], ['plan', 'plan'], ['yolo', 'yolo']];

  for (const [mode, expected] of modeCases) {
    await fixture.fake();
    await adapter.run(runInput(fixture, model, { permissionMode: mode }));

    const records = await fixture.records();
    const spawn = records.filter((item) => item.event === 'spawn').at(-1);
    const modeFrame = records.filter((item) => item.instance === spawn.instance
      && item.frame?.method === 'session/set_mode').at(-1);
    const nativeMode = modeFrame?.frame.params.modeId
      ?? spawn.argv[spawn.argv.indexOf('--approval-mode') + 1];

    assert.equal(nativeMode, expected, `Режим GrigDesk ${mode} должен применять native ${expected}`);
  }

  const failures = [
    { options: { brokenJson: true }, reason: /ACP|JSON|EOF|поток|процесс|протокол/i },
    { options: { eof: true }, reason: /ACP|EOF|закрыт|заверш|процесс|exit|closed/i },
    { options: { error: `synthetic upstream failure ${QWEN_KEY}`, stderr: QWEN_KEY },
      reason: /synthetic upstream failure/ },
  ];

  for (const failure of failures) {
    await fixture.fake(failure.options);

    const reason = await rejectedTurn(() => adapter.run(runInput(fixture, model)));

    assert.match(reason, failure.reason);
    assert.equal(reason.includes(QWEN_KEY), false);
  }
});

test('qwen-resume-exact-session', async (t) => {
  const fixture = await qwenFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const model = await selectedModel(adapter, fixture);
  const first = await adapter.run(runInput(fixture, model));
  const steps = [];

  assert.equal(successful(first), true);
  assert.ok(first.sessionId);

  const second = await adapter.run(runInput(fixture, model, {
    sessionId: first.sessionId,
    message: 'Продолжи.',
    onStep: (step) => steps.push(step),
  }));
  const records = await fixture.records();
  const loads = records.filter((item) => item.frame?.method === 'session/load');
  const prompts = records.filter((item) => item.frame?.method === 'session/prompt');

  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.reply, 'Новый ответ');
  assert.equal(loads.length, 1);
  assert.equal(loads[0].frame.params.sessionId, first.sessionId);
  assert.equal(prompts.length, 2);

  const processIds = prompts.map((item) => item.instance);

  assert.ok(new Set(processIds).size >= 2);
  assert.equal(JSON.stringify(steps).includes('OLD_REPLAY'), false, 'Replay не является новым ответом');
  assert.equal(typeof adapter.sessionBinding?.authProfileId, 'function');

  const binding = await adapter.sessionBinding.authProfileId(fixture.config);

  process.env.QWEN_TEST_KEY = 'synthetic-rotated-key';

  const changed = await adapter.sessionBinding.authProfileId(fixture.config);

  assert.notEqual(changed, binding, 'Смена ключа должна отделять native память');
  assert.equal(changed.includes('synthetic-rotated-key'), false);

  const before = prompts.length;

  await rejectedTurn(() => adapter.run(runInput(fixture, model, {
    sessionId: '../foreign-session', chatKey: 'foreign-chat',
  })));

  const afterForeign = (await fixture.records()).filter((item) => item.frame?.method === 'session/prompt');

  assert.equal(afterForeign.length, before);
});

test('qwen-abort-no-late-effect', async (t) => {
  const fixture = await qwenFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const model = await selectedModel(adapter, fixture);
  const preAborted = new AbortController();

  preAborted.abort();

  const before = (await fixture.records()).filter((item) => item.event === 'spawn').length;

  await assert.rejects(adapter.run(runInput(fixture, model, { signal: preAborted.signal })), (error) => {
    assert.equal(error.stopped, true);
    assert.deepEqual(error.steps, []);

    return true;
  });
  assert.equal((await fixture.records()).filter((item) => item.event === 'spawn').length, before);
  await fixture.fake({ hold: true });

  const controller = new AbortController();
  const live = [];

  t.after(() => controller.abort());

  const outcome = adapter.run(runInput(fixture, model, {
    signal: controller.signal,
    onStep: (step) => live.push(step),
  }));
  const finished = outcome.then(() => 'finished', () => 'failed');
  const reached = until(async () => (await fixture.records())
    .some((entry) => entry.frame?.method === 'session/prompt') ? 'prompt' : '', 'активный prompt');

  assert.equal(await Promise.race([reached, finished]), 'prompt');

  const holders = await inspectCliLeases({
    directory: path.join(fixture.dataHome, 'provider-cli-leases'), providerId: 'qwen',
  });
  const processIds = holders.flatMap((holder) => [holder.childPid, holder.sessionId]).filter(Boolean);

  assert.ok(processIds.length, 'Остановка проверяется по host PID, а не PID внутри bwrap');
  controller.abort();

  let stopped;

  await assert.rejects(outcome, (error) => {
    stopped = error;
    assert.equal(error.stopped, true);
    assert.ok(error.sessionId);
    assert.deepEqual(error.steps, live, 'Сохранённая лента содержит выпущенный при остановке хвост');
    assert.equal(error.steps.at(-1).text, 'Начало');

    return true;
  });

  await until(() => {
    return processIds.every((pid) => {
      try {
        process.kill(pid, 0);

        return false;
      } catch (error) {
        return error.code === 'ESRCH';
      }
    });
  }, 'завершение своего ACP child');

  await fixture.fake();

  const resumed = await adapter.run(runInput(fixture, model, { sessionId: stopped.sessionId }));

  assert.equal(resumed.sessionId, stopped.sessionId);
  assert.equal(resumed.reply, 'Новый ответ');

  const effect = path.join(fixture.workspace, 'late-effect');
  const approvalAbort = new AbortController();
  let lateAllow;

  t.after(() => approvalAbort.abort());

  await fixture.fake({
    ask: true,
    effect,
    tool: { name: 'run_shell_command', args: { command: 'printf allowed' } },
  });

  const pending = adapter.run(runInput(fixture, model, {
    signal: approvalAbort.signal,
    onPermission: () => new Promise((resolve) => {
      lateAllow = resolve;
      approvalAbort.abort();
    }),
  }));

  await rejectedTurn(() => pending);
  assert.equal(typeof lateAllow, 'function', 'Сценарий должен дойти до ожидания разрешения');
  lateAllow({ allow: true });
  await absent(effect);
});

test('Qwen: native cancelled является остановкой, ошибки CLI сохраняют причину', async (t) => {
  const fixture = await qwenFixture(t);
  const adapter = await qwenAdapter({ runnable: true });

  await fixture.fake({
    ask: true,
    tool: { name: 'run_shell_command', args: { command: 'printf synthetic' } },
  });
  await assert.rejects(adapter.run(runInput(fixture, 'shared-model(openai)')), (error) => {
    assert.equal(error.stopped, true);
    assert.ok(error.sessionId);
    assert.equal(error.steps[0].k, 'start');

    return true;
  });
  await fixture.fake({ error: `synthetic failure ${QWEN_KEY}` });
  await assert.rejects(adapter.run(runInput(fixture, 'shared-model(openai)')), (error) => {
    assert.equal(error.stopped, undefined);
    assert.match(error.message, /synthetic failure/);
    assert.equal(error.message.includes(QWEN_KEY), false);

    return true;
  });
});

test('Qwen: отмена после создания сессии не отправляет prompt', async (t) => {
  const fixture = await qwenFixture(t);
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
  assert.equal((await fixture.records()).some((entry) => entry.frame?.method === 'session/prompt'), false);
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

test('Qwen: чужой drain не забирает уточнение текущего prompt', async (t) => {
  const fixture = await qwenFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const blocks = [];
  let delivery;

  await fixture.fake({ hold: true });

  const result = await adapter.run(runInput(fixture, 'shared-model(openai)', {
    onInTurnReady(port) {
      delivery = port.deliver({
        messageId: 'qwen-synthetic-in-turn',
        text: 'Текущее уточнение',
        sequence: 1,
      });
    },
    onAssistantMessage: (block) => blocks.push(block),
  }));
  const records = await fixture.records();

  assert.deepEqual(await delivery, { ok: true, state: 'forwarded' });
  assert.deepEqual(records.find((entry) => entry.event === 'foreign-drain').result.messages, []);
  assert.match(records.find((entry) => entry.event === 'mid-turn-drain').result.messages[0],
    /Текущее уточнение/);
  assert.equal(result.reply, 'Новый ответ');
  assert.deepEqual(blocks.map((block) => block.text), ['Начало', 'Новый ответ']);
  assert.equal(records.filter((entry) => entry.frame?.method === 'session/prompt').length, 1);
});

test('qwen-final-guard-before-effect', async (t) => {
  const fixture = await qwenFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const model = await selectedModel(adapter, fixture);
  const effect = path.join(fixture.workspace, 'forbidden-effect');

  for (const options of [
    { tool: { name: 'run_shell_command', args: { command: 'ssh example.invalid true' } } },
    { tool: { name: 'unknown_native_tool', args: {} } },
    { foreignSession: true, tool: { name: 'run_shell_command', args: { command: 'printf allowed' } } },
  ]) {
    await fixture.fake({ effect, ...options });

    const before = (await fixture.records()).filter((item) => item.event === 'guard').length;

    await adapter.run(runInput(fixture, model, {
      permissionMode: 'yolo',
      providerSettings: { blockDirectSsh: true },
      onPermission: async () => ({ allow: true }),
    })).catch(() => null);

    const decisions = (await fixture.records()).filter((item) => item.event === 'guard');

    assert.equal(decisions.length, before + 1, 'Проверяется отказ guard, а не сбой до запуска CLI');
    assert.equal(decisions.at(-1).allowed, false);
    await absent(effect);
  }

  await fixture.fake({ noAck: true });

  const before = (await fixture.records()).filter((item) => item.frame?.method === 'session/prompt').length;
  const reason = await rejectedTurn(() => adapter.run(runInput(fixture, model)));

  assert.match(reason, /guard|совмест|протокол|защит/i);

  const afterNoAck = (await fixture.records()).filter((item) => item.frame?.method === 'session/prompt');

  assert.equal(afterNoAck.length, before);
  assert.equal(reason.includes(QWEN_KEY), false);
});

test('qwen-filesystem-mcp-workdir', async (t) => {
  const fixture = await qwenFixture(t);
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
    await fixture.fake({
      effect: file,
      tool: { name: 'write_file', args: { file_path: file, content: 'bad' } },
    });
    await adapter.run(runInput(fixture, model, { permissionMode: 'yolo' })).catch(() => null);
    assert.equal(await readFile(canary, 'utf8'), 'original');
  }

  const own = path.join(fixture.workspace, 'own');

  await fixture.fake({
    effect: own,
    tool: { name: 'write_file', args: { file_path: own, content: 'effect' } },
  });
  await adapter.run(runInput(fixture, model, { permissionMode: 'yolo' }));
  assert.equal(await readFile(own, 'utf8'), 'effect', 'Полный запрет tools не заменяет правильную политику');

  const malicious = path.join(fixture.workspace, 'ambient-mcp-started');

  await mkdir(path.join(fixture.workspace, '.qwen'));
  await writeFile(path.join(fixture.workspace, '.qwen/settings.json'), JSON.stringify({
    mcpServers: { hostile: { command: '/bin/sh', args: ['-c', `touch '${malicious}'`] } },
  }));
  await fixture.fake();
  await adapter.run(runInput(fixture, model, { mcpServers: [] }));
  await absent(malicious);

  const status = await adapter.mcpStatus(fixture.config);

  assert.equal(JSON.stringify(status).includes(QWEN_KEY), false);
  assert.equal(JSON.stringify(status).includes('"connected":true'), false);
});

test('qwen-cli-lease', async (t) => {
  const fixture = await qwenFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const model = await selectedModel(adapter, fixture);

  await fixture.fake({ hold: true });

  const runtime = await prepareExternalCliRuntime(adapter, fixture.config, fixture.env);
  const leaseInput = {
    directory: runtime.process.leaseDirectory,
    providerId: 'qwen',
    resourceKey: runtime.process.resourceKey,
  };
  const controller = new AbortController();

  t.after(() => controller.abort());

  const running = adapter.run(runInput(fixture, model, {
    signal: controller.signal,
  }));
  const outcome = running.then(() => 'ended', () => 'failed');
  const reached = until(async () => (await fixture.records())
    .some((entry) => entry.frame?.method === 'session/prompt') ? 'prompt' : '', 'активный prompt');

  assert.equal(await Promise.race([reached, outcome]), 'prompt');

  const observed = await inspectCliLeases(leaseInput);

  assert.ok(observed.some((holder) => holder.childPid || holder.sessionId), 'bwrap не должен терять reader');
  await assert.rejects(acquireCliLease({ ...leaseInput, mode: 'exclusive' }), { code: 'provider_in_use' });
  controller.abort();
  await rejectedTurn(() => running);
  assert.deepEqual(await inspectCliLeases(leaseInput), []);

  const exclusive = await acquireCliLease({
    ...leaseInput,
    mode: 'exclusive',
  });

  try {
    await fixture.fake();
    await rejectedTurn(() => adapter.run(runInput(fixture, model)));
  } finally {
    await exclusive.release();
  }
});

test('Qwen: контекст и выход из usage-событий, субагент не меняет метрики', async (t) => {
  const fixture = await qwenFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
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

  await fixture.fake({
    stream: [
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
    ],
  });

  const result = await adapter.run(runInput(fixture, 'shared-model(openai)', {
    onProgress: (tokens, info) => progress.push({ tokens, info }),
  }));

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
  const fixture = await qwenFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const plugin = path.join(fixture.root, 'plugin');
  const docs = path.join(plugin, 'docs');
  const index = path.join(docs, 'README.md');
  const outside = path.join(plugin, 'private.txt');
  const attempt = path.join(docs, 'forbidden');

  await mkdir(docs, { recursive: true });
  await writeFile(index, 'PLUGIN_DOC_SENTINEL');
  await writeFile(outside, 'PLUGIN_PRIVATE_SENTINEL');
  await fixture.fake({
    readMasks: [index, outside],
    bounds: { allowed: [], denied: [attempt] },
    tool: { name: 'read_file', args: { file_path: index } },
  });
  await adapter.run(runInput(fixture, 'shared-model(openai)', { pluginDocsDirs: [docs, docs] }));

  const entries = await fixture.records();
  const masks = entries.filter((entry) => entry.event === 'mask');

  assert.equal(masks[0].text, 'PLUGIN_DOC_SENTINEL');
  assert.equal(masks[1].code, 'ENOENT');
  assert.ok(entries.some((entry) => entry.event === 'bounds' && entry.denied === true));
  assert.equal(entries.find((entry) => entry.event === 'guard').allowed, true);
  assert.equal(await readFile(index, 'utf8'), 'PLUGIN_DOC_SENTINEL');
  await assert.rejects(access(attempt), { code: 'ENOENT' });
});
