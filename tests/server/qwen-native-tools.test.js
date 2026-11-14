import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { createServer as createHttpsServer } from 'node:https';
import { execFile as execFileCallback, spawn as spawnSentinel } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { prepareExternalCliRuntime } from '../../server/src/lib/providerInstall/externalCliRuntime.ts';
import { withExternalCliProcess } from '../../server/src/lib/providerInstall/externalCliProcess.ts';
import { inspectCliLeases } from '../../server/src/lib/providerInstall/leases.ts';
import { createWorkTools } from '../../server/src/lib/executors/index.ts';
import { createWorkIpc } from '../../server/src/lib/executors/workIpc.ts';
import { ChatLiveSessions } from '../../server/src/lib/chat/liveSessions.ts';
import rawQwen from '../../server/src/lib/executors/qwen.ts';
import { qwenNativeFixture } from '../helpers/qwenNativeFixture.mjs';
import {
  QWEN_TEST_PNG, qwenAdapter, qwenImage, runInput, selectedModel, until,
} from '../helpers/qwenFixture.mjs';

const executeFile = promisify(execFileCallback);

/**
 * Используется настоящий штатный discovery/lease, но окружение теста закреплено явно.
 * Синтетический PATH не зависит от .profile владельца и не меняет process.env глобально.
 */
async function hostProbe(fixture, input, overlay = {}) {
  const prepared = await prepareExternalCliRuntime(rawQwen, fixture.config);
  const context = { ...prepared.process, env: { ...prepared.process.env, ...overlay } };
  const spec = { ...input, config: prepared.config };

  return withExternalCliProcess(context, () => {
    if (rawQwen.session?.open) {
      return rawQwen.session.open(spec);
    }

    return {
      send: (turn) => withExternalCliProcess(context, () => rawQwen.run({ ...spec, ...turn })),
      close: async () => {},
    };
  });
}

test('Qwen native Host: процессы и сокеты хоста, ребёнок пишет, SSH остаётся закрыт', {
  timeout: 90000,
}, async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const model = await selectedModel(adapter, fixture);
  const target = path.join(fixture.workspace, 'host-child.txt');
  const socketPath = path.join(fixture.root, 'docker-test.sock');
  const pidFile = path.join(fixture.workspace, 'host-pid');
  const uidFile = path.join(fixture.workspace, 'host-uid');
  const socketFile = path.join(fixture.workspace, 'host-socket');
  const socket = createNetServer((connection) => connection.end());

  socket.listen(socketPath);
  await once(socket, 'listening');
  t.after(() => new Promise((resolve) => socket.close(resolve)));

  const host = { allowHostAccess: true, blockDirectSsh: true };
  const fakeBin = path.join(fixture.root, 'host-bin');
  const sshCanary = path.join(fixture.root, 'ssh-executed');

  await mkdir(fakeBin);
  await writeFile(path.join(fakeBin, 'ssh'), `#!/bin/sh\nprintf BAD > '${sshCanary}'\n`, { mode: 0o700 });

  const handle = await hostProbe(fixture, runInput(fixture, model, {
    providerSettings: host, permissionMode: 'yolo',
  }), { PATH: `${fakeBin}:${process.env.PATH}` });

  t.after(() => handle.close());
  fixture.actions.push({
    name: 'run_shell_command',
    args: { command: `test -S '${socketPath}' && ps -p ${process.pid} -o pid= > '${pidFile}'`
      + ` && id -u > '${uidFile}' && printf SOCKET_SENTINEL > '${socketFile}'` },
  });

  await handle.send({ message: 'Проверь видимость хоста.', signal: AbortSignal.timeout(25000) });
  assert.equal((await readFile(pidFile, 'utf8')).trim(), String(process.pid));
  assert.equal((await readFile(uidFile, 'utf8')).trim(), String(process.getuid()));
  assert.equal(await readFile(socketFile, 'utf8'), 'SOCKET_SENTINEL');

  const agent = { name: 'agent', args: {
    description: 'Проверить инструменты ребёнка',
    prompt: 'Выполни разрешённые проверочные действия.',
    subagent_type: 'general-purpose',
    run_in_background: false,
  } };

  fixture.actions.push(agent, {
    name: 'run_shell_command', args: { command: 'ssh example.invalid true' },
  }, {
    name: 'write_file', args: { file_path: target, content: 'HOST_CHILD_SENTINEL' },
  });

  const result = await handle.send({
    message: 'Выполни проверку ребёнком.',
    signal: AbortSignal.timeout(45000),
  });

  assert.equal(agent.missing, undefined);
  assert.equal(await readFile(target, 'utf8'), 'HOST_CHILD_SENTINEL');
  assert.equal(JSON.stringify(fixture.requests).includes('Tool invocation guard failed'), false);
  assert.match(JSON.stringify(fixture.requests), /denied by host policy/i, 'SSH ребёнка запрещён');
  await assert.rejects(access(sshCanary), { code: 'ENOENT' });
});

test('Qwen native Host: background shell завершается после ответа без второго send', {
  timeout: 90000,
}, async (t) => {
  const fixture = await qwenNativeFixture(t);
  const release = path.join(fixture.workspace, 'release');
  const results = [];
  const action = { name: 'run_shell_command', args: {
    command: `while [ ! -f '${release}' ]; do sleep 0.05; done; printf BACKGROUND_SENTINEL`,
    is_background: true,
  } };

  fixture.actions.push(action);

  const handle = await hostProbe(fixture, runInput(fixture, 'shared-model(openai)', {
    permissionMode: 'yolo',
    providerSettings: { allowHostAccess: true },
    hooks: { onBackground: (result) => results.push(result) },
  }));

  t.after(() => handle.close());

  const first = await handle.send({ message: 'Начни тестовый фон.', signal: AbortSignal.timeout(25000) });
  const pid = handle.pid;

  assert.equal(action.missing, undefined);
  assert.match(first.reply, /Ответ настоящего CLI/);
  assert.equal(results.length, 0);
  await writeFile(release, 'release');
  await until(() => results.length === 1, 'нативный background result без send', 45000);
  assert.equal(handle.pid, pid);
  assert.match(results[0].reply, /Ответ настоящего CLI/);
  assert.ok(JSON.stringify(fixture.requests).includes('BACKGROUND_SENTINEL'));
  await handle.close();
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.doesNotThrow(() => process.kill(process.pid, 0), 'Чужой для handle процесс теста жив');
});

test('Qwen native Host: loop_wakeup переживает ответ и пробуждается без второго send', {
  timeout: 150000,
}, async (t) => {
  const fixture = await qwenNativeFixture(t);
  const results = [];
  const action = { name: 'loop_wakeup', args: { delaySeconds: 60, prompt: 'WAKEUP_SENTINEL' } };

  fixture.actions.push(action);

  const handle = await hostProbe(fixture, runInput(fixture, 'shared-model(openai)', {
    permissionMode: 'yolo',
    providerSettings: { allowHostAccess: true },
    hooks: { onBackground: (result) => results.push(result) },
  }));

  t.after(() => handle.close());
  await handle.send({ message: 'Запланируй пробуждение.', signal: AbortSignal.timeout(25000) });

  const pid = handle.pid;

  assert.equal(action.missing, undefined);
  await until(() => results.length === 1, 'нативный loop wakeup', 120000);
  assert.equal(handle.pid, pid);
  assert.ok(JSON.stringify(fixture.requests).includes('WAKEUP_SENTINEL'));
  assert.match(results[0].reply, /Ответ настоящего CLI/);

  const next = await handle.send({
    message: 'Продолжи обычный разговор.',
    signal: AbortSignal.timeout(25000),
  });

  assert.match(next.reply, /Ответ настоящего CLI/);
  assert.equal(handle.pid, pid);
  assert.equal(results.length, 1, 'Replay wakeup не публикуется повторно');
});

for (const midTurn of [false, true]) {
  test(`Qwen native: изображение в ${midTurn ? 'уточнении' : 'обычном ходе'} доходит до API`, {
    timeout: 60000,
  }, async (t) => {
    const fixture = await qwenNativeFixture(t);
    const adapter = await qwenAdapter({ runnable: true });
    const image = await qwenImage(fixture);
    const controller = new AbortController();
    const entry = fixture.settings.modelProviders.openai[0];
    let port;

    entry.generationConfig.modalities = { image: true };
    await fixture.writeSettings(fixture.settings);

    if (midTurn) {
      fixture.actions.push({ hold: true });
    }

    const running = adapter.run(runInput(fixture, 'shared-model(openai)', {
      attachmentsDir: image.root,
      attachmentPaths: midTurn ? [] : [image.file],
      message: midTurn ? 'Начни работу.' : '',
      signal: controller.signal,
      onInTurnReady(value) {
        port = value;
      },
    }));

    running.catch(() => {});

    try {
      if (midTurn) {
        await fixture.held;

        const delivered = await port.deliver({
          messageId: 'qwen-native-image-in-turn',
          text: '',
          images: [{ path: image.file }],
          sequence: 1,
        });

        assert.deepEqual(delivered, { ok: true, state: 'forwarded' });
      }

      const result = await running;
      const imageCalls = fixture.requests.map((request) => (request.messages ?? [])
        .flatMap((message) => Array.isArray(message.content) ? message.content : [])
        .filter((part) => part.type === 'image_url')).filter((images) => images.length);

      assert.match(result.reply, /Ответ настоящего CLI/);
      assert.ok(imageCalls.length, 'Картинка доходит в запрос модели, а не остаётся файловым путём');

      for (const images of imageCalls) {
        assert.equal(images.length, 1, 'Каждый запрос содержит картинку ровно один раз');
        assert.equal(images[0].image_url.url, `data:image/png;base64,${QWEN_TEST_PNG.toString('base64')}`);
      }
    } finally {
      controller.abort();
      await running.catch(() => {});
    }
  });
}

test('Qwen native: уточнение прерывает генерацию и получает отдельный ответ', {
  timeout: 60000,
}, async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const controller = new AbortController();
  const blocks = [];
  const live = [];
  let port;

  fixture.actions.push({ hold: true });

  const running = adapter.run(runInput(fixture, 'shared-model(openai)', {
    signal: controller.signal,
    onInTurnReady(value) {
      port = value;
    },
    onStep: (step) => live.push(step),
    onAssistantMessage: (block) => blocks.push(block),
  }));

  running.catch(() => {});

  try {
    await fixture.held;
    assert.ok(port, 'Канал открыт до завершения текущей генерации');

    const delivered = await port.deliver({
      messageId: 'qwen-native-in-turn-message',
      text: 'IN_TURN_SENTINEL: ответь на вопрос и продолжи основную задачу.',
      sequence: 1,
    });
    const result = await running;

    assert.deepEqual(delivered, { ok: true, state: 'forwarded' });
    assert.ok(fixture.requests.some((request) => JSON.stringify(request.messages)
      .includes('IN_TURN_SENTINEL')), 'Уточнение дошло в контекст настоящего CLI');
    assert.deepEqual(blocks.map((block) => block.text), [
      'Начало долгого ответа', 'Ответ настоящего CLI.',
    ]);
    assert.ok(blocks.every((block) => block.complete));
    assert.deepEqual(blocks.map((block) => block.assistantMessageId),
      live.filter((step) => step.k === 'text').map((step) => step.id));
    assert.equal(result.reply, 'Ответ настоящего CLI.');
    assert.equal(result.assistantMessageId, blocks.at(-1).assistantMessageId);
    assert.equal((await port.deliver({
      messageId: 'qwen-native-after-turn',
      text: 'Позднее уточнение',
      sequence: 2,
    })).ok, false);
  } finally {
    controller.abort();
    await running.catch(() => {});
  }
});

test('Qwen native: todo_write сохраняет выполненный план в home разговора', { timeout: 60000 }, async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const model = await selectedModel(adapter, fixture);
  const todos = [{
    id: 'native-todo-sentinel',
    content: 'Проверить допуск',
    status: 'completed',
  }];
  const action = { name: 'todo_write', args: { todos } };

  fixture.actions.push(action);

  const result = await adapter.run(runInput(fixture, model, {
    permissionMode: 'yolo',
    signal: AbortSignal.timeout(45000),
    onPermission: async () => assert.fail('Служебный список не требует разрешения'),
  }));
  const files = await readdir(fixture.config.qwenRuntimeHome, { recursive: true });
  const candidates = files.filter((file) => file.endsWith(`${result.sessionId}.json`));
  const saved = await Promise.all(candidates.map((file) => readFile(
    path.join(fixture.config.qwenRuntimeHome, file), 'utf8',
  )));

  assert.equal(action.missing, undefined);
  assert.ok(saved.some((text) => {
    const value = JSON.parse(text);

    return value.todos?.some((todo) => todo.id === todos[0].id && todo.status === 'completed');
  }), 'Настоящий инструмент должен записать список, а не только перестать показывать отказ');
});

test('Qwen native: вопросы передают мультивыбор и свой текст даже в yolo', { timeout: 60000 }, async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const model = await selectedModel(adapter, fixture);
  const action = { name: 'ask_user_question', args: { questions: [{
    header: 'Выбор',
    question: 'Какие варианты?',
    multiSelect: true,
    options: [
      { label: 'Первый', description: 'Первый вариант' },
      { label: 'Второй', description: 'Второй вариант' },
    ],
  }] } };
  let asked = 0;

  fixture.actions.push(action);

  await adapter.run(runInput(fixture, model, {
    permissionMode: 'yolo',
    signal: AbortSignal.timeout(45000),
    onPermission: async (presentation) => {
      asked += 1;
      assert.equal(presentation.isQuestion, true);
      assert.equal(presentation.questions[0].multiSelect, true);
      assert.equal(presentation.questions[0].allowFreeText, true);

      return { rawAnswers: [{ selected: ['Первый', 'Второй'], text: 'native-answer-sentinel' }] };
    },
  }));

  assert.equal(action.missing, undefined);
  assert.equal(asked, 1);
  assert.ok(fixture.requests.some((request) => JSON.stringify(request.messages)
    .includes('Первый, Второй, native-answer-sentinel')), 'Ответ дошёл до следующего запроса настоящего CLI');
});

test('Qwen native: утверждение плана открывает запись в том же ходе', { timeout: 60000 }, async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const model = await selectedModel(adapter, fixture);
  const target = path.join(fixture.workspace, 'after-plan.txt');
  const plan = { name: 'exit_plan_mode', args: { plan: 'Записать проверочный файл' } };
  const write = { name: 'write_file', args: { file_path: target, content: 'approved-plan-sentinel' } };
  const questions = [];

  fixture.actions.push(plan, write);

  await adapter.run(runInput(fixture, model, {
    permissionMode: 'plan',
    signal: AbortSignal.timeout(45000),
    onPermission: async (presentation) => {
      questions.push(presentation);

      return { allow: true, choice: 'proceed_always' };
    },
  }));

  assert.equal(plan.missing, undefined);
  assert.equal(write.missing, undefined);
  assert.equal(questions[0].tool, 'ExitPlanMode');
  assert.equal(questions[0].input.plan, plan.args.plan);
  assert.equal(await readFile(target, 'utf8'), 'approved-plan-sentinel');
});

test('Qwen native: вход в план закрывает запись до утверждения', { timeout: 60000 }, async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const model = await selectedModel(adapter, fixture);
  const blocked = path.join(fixture.workspace, 'before-approval.txt');
  const allowed = path.join(fixture.workspace, 'after-approval.txt');

  fixture.actions.push(
    { name: 'enter_plan_mode', args: { userRequested: true } },
    { name: 'write_file', args: { file_path: blocked, content: 'BAD' } },
    { name: 'exit_plan_mode', args: { plan: 'Теперь можно записать результат' } },
    { name: 'write_file', args: { file_path: allowed, content: 'mode-transition-sentinel' } },
  );
  await adapter.run(runInput(fixture, model, {
    permissionMode: 'yolo',
    signal: AbortSignal.timeout(45000),
    onPermission: async () => ({ allow: true, choice: 'proceed_always' }),
  }));

  await assert.rejects(access(blocked), { code: 'ENOENT' });
  assert.equal(await readFile(allowed, 'utf8'), 'mode-transition-sentinel');
});

test('Qwen native: guard закрывает субагента без контекста', { timeout: 90000 }, async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const model = await selectedModel(adapter, fixture);
  const target = path.join(fixture.workspace, 'subagent.txt');
  const agent = { name: 'agent', args: {
    description: 'Проверить права дочернего агента',
    prompt: 'Выполни проверочные инструменты и заверши работу.',
    subagent_type: 'general-purpose',
  } };
  const ssh = { name: 'run_shell_command', args: { command: 'ssh example.invalid true' } };
  const write = { name: 'write_file', args: { file_path: target, content: 'subagent-sentinel' } };

  fixture.actions.push(agent, ssh, write);

  const result = await adapter.run(runInput(fixture, model, {
    permissionMode: 'yolo',
    signal: AbortSignal.timeout(75000),
    onPermission: async () => assert.fail('Yolo не требует обычных разрешений'),
  }));

  assert.equal(agent.missing, undefined);
  assert.equal(ssh.missing, undefined);
  assert.equal(write.missing, undefined);

  const content = await readFile(target, 'utf8').catch((error) => error.code);

  assert.equal(content, 'ENOENT', 'Отсутствующий guard context не разрешает даже обычную запись');
  assert.ok(JSON.stringify(fixture.requests).includes('Tool invocation guard failed'),
    'CLI 0.27.2 очищает invocation context ребёнка до вызова обязательного guard');
  assert.ok(result.steps.some((step) => step.k === 'tool' && /agent/i.test(step.name)));
});

test('Qwen native: web_fetch читает страницу через штатный инструмент', { timeout: 60000 }, async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const model = await selectedModel(adapter, fixture);
  let fetched = 0;
  const server = createServer((_request, response) => {
    fetched += 1;
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<html><body>native-fetch-sentinel</body></html>');
  });

  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const action = { name: 'web_fetch', args: {
    url: `http://127.0.0.1:${server.address().port}/page`,
    prompt: 'Перескажи содержимое страницы.',
  } };

  fixture.actions.push(action);

  const result = await adapter.run(runInput(fixture, model, {
    permissionMode: 'yolo',
    signal: AbortSignal.timeout(45000),
  }));

  assert.equal(action.missing, undefined);
  assert.equal(fetched, 1);
  assert.ok(fixture.requests.some((request) => JSON.stringify(request.messages)
    .includes('native-fetch-sentinel')));
  assert.ok(result.steps.some((step) => step.k === 'res' && step.ok === true), JSON.stringify(result.steps));
});

test('Qwen native: правка ячейки блокнота', { timeout: 60000 }, async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const model = await selectedModel(adapter, fixture);
  const file = path.join(fixture.workspace, 'example.ipynb');

  await writeFile(file, JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [{
      id: 'cell-sentinel',
      cell_type: 'markdown',
      metadata: {},
      source: ['Старый текст'],
    }],
  }));

  const edit = { name: 'notebook_edit', args: {
    notebook_path: file,
    cell_id: 'cell-sentinel',
    new_source: 'native-notebook-sentinel',
    edit_mode: 'replace',
  } };

  fixture.actions.push({ name: 'read_file', args: { file_path: file } }, edit);
  await adapter.run(runInput(fixture, model, {
    permissionMode: 'yolo',
    signal: AbortSignal.timeout(45000),
  }));

  assert.equal(edit.missing, undefined);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).cells[0].source.join(''), 'native-notebook-sentinel');
});

const lspSource = `
let buffer = Buffer.alloc(0);
const send = (id, result) => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }));
  process.stdout.write('Content-Length: ' + body.length + '\\r\\n\\r\\n');
  process.stdout.write(body);
};
process.stdin.on('data', (data) => {
  buffer = Buffer.concat([buffer, data]);

  while (true) {
    const at = buffer.indexOf('\\r\\n\\r\\n');

    if (at < 0) {
      return;
    }

    const length = Number(/Content-Length: (\\d+)/i.exec(buffer.subarray(0, at).toString())[1]);

    if (buffer.length < at + 4 + length) {
      return;
    }

    const frame = JSON.parse(buffer.subarray(at + 4, at + 4 + length));

    buffer = buffer.subarray(at + 4 + length);

    if (frame.method === 'initialize') {
      send(frame.id, { capabilities: { documentSymbolProvider: true, textDocumentSync: 1 } });
    } else if (frame.method === 'textDocument/documentSymbol') {
      const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };

      send(frame.id, [{ name: 'LOCAL_LSP_SENTINEL', kind: 12, range, selectionRange: range }]);
    } else if (frame.method === 'exit') {
      process.exit(0);
    } else if (frame.id !== undefined) {
      send(frame.id, null);
    }
  }
});
`;

test('Qwen native Host: настроенный LSP исполняет local server вне sandbox', {
  timeout: 90000,
}, async (t) => {
  const fixture = await qwenNativeFixture(t);
  const server = path.join(fixture.root, 'local-lsp.mjs');
  const file = path.join(fixture.workspace, 'sample.probe');

  await writeFile(server, lspSource);
  await writeFile(file, 'x');
  await writeFile(path.join(fixture.workspace, '.lsp.json'), JSON.stringify({ probe: {
    command: process.execPath,
    args: [server],
    extensionToLanguage: { '.probe': 'probe' },
  } }));

  const action = { name: 'lsp', args: { operation: 'documentSymbol', filePath: file } };

  fixture.actions.push(action);

  const handle = await hostProbe(fixture, runInput(fixture, 'shared-model(openai)', {
    permissionMode: 'yolo', providerSettings: { allowHostAccess: true },
  }));

  t.after(() => handle.close());

  const result = await handle.send({ message: 'Получи символы.', signal: AbortSignal.timeout(60000) });

  assert.equal(action.missing, undefined);
  assert.ok(result.steps.some((step) => step.k === 'res'
    && JSON.stringify(step).includes('LOCAL_LSP_SENTINEL')));
});

test('Qwen native Host: медиа использует ffmpeg и выдаёт настоящий WAV', {
  timeout: 90000,
}, async (t) => {
  const fixture = await qwenNativeFixture(t);
  const input = path.join(fixture.root, 'silence.wav');
  const output = path.join(fixture.workspace, 'clipped');
  const pcm = Buffer.alloc(44 + 32000);

  pcm.write('RIFF', 0);
  pcm.writeUInt32LE(pcm.length - 8, 4);
  pcm.write('WAVEfmt ', 8);
  pcm.writeUInt32LE(16, 16);
  pcm.writeUInt16LE(1, 20);
  pcm.writeUInt16LE(1, 22);
  pcm.writeUInt32LE(8000, 24);
  pcm.writeUInt32LE(16000, 28);
  pcm.writeUInt16LE(2, 32);
  pcm.writeUInt16LE(16, 34);
  pcm.write('data', 36);
  pcm.writeUInt32LE(32000, 40);
  await writeFile(input, pcm);
  await mkdir(output);

  const action = { name: 'omni_clip_audio', args: {
    inputPath: input,
    outputDir: output,
    startMs: 0,
    durationMs: 1000,
    format: 'wav',
  } };

  fixture.actions.push(action);

  const handle = await hostProbe(fixture, runInput(fixture, 'shared-model(openai)', {
    permissionMode: 'yolo', providerSettings: { allowHostAccess: true },
  }));

  t.after(() => handle.close());

  const result = await handle.send({ message: 'Обрежь локальный звук.', signal: AbortSignal.timeout(60000) });
  const files = await readdir(output, { recursive: true });
  const wav = files.find((file) => file.endsWith('.wav'));

  assert.equal(action.missing, undefined);
  assert.ok(wav, JSON.stringify(result));

  const bytes = await readFile(path.join(output, wav));

  assert.equal(bytes.subarray(0, 4).toString(), 'RIFF');
  assert.ok(bytes.length > 1000 && bytes.length < pcm.length);
  assert.ok(result.steps.some((step) => step.k === 'res' && step.ok === true));
});

test('Qwen native Host: отсутствующий LSP backend показывает причину', {
  timeout: 90000,
}, async (t) => {
  const fixture = await qwenNativeFixture(t);
  const server = path.join(fixture.root, 'local-lsp.mjs');
  const file = path.join(fixture.workspace, 'sample.probe');

  await writeFile(server, lspSource);
  await writeFile(file, 'x');
  await writeFile(path.join(fixture.workspace, '.lsp.json'), JSON.stringify({ probe: {
    command: path.join(fixture.root, 'missing-language-server'),
    args: [],
    extensionToLanguage: { '.probe': 'probe' },
  } }));

  const action = { name: 'lsp', args: { operation: 'documentSymbol', filePath: file } };

  fixture.actions.push(action);

  const handle = await hostProbe(fixture, runInput(fixture, 'shared-model(openai)', {
    permissionMode: 'yolo', providerSettings: { allowHostAccess: true },
  }));

  t.after(() => handle.close());

  const result = await handle.send({ message: 'Получи символы.', signal: AbortSignal.timeout(60000) });

  assert.equal(action.missing, undefined);
  assert.ok(result.steps.some((step) => step.k === 'res' && step.error === true
    && /ENOENT|not found|failed|available|language server/i.test(JSON.stringify(step))),
  JSON.stringify(result));
});

for (const failing of [false, true]) {
  test(`Qwen native Host: configured search backend, failure=${failing}`, {
    timeout: 120000,
  }, async (t) => {
    const fixture = await qwenNativeFixture(t);
    const cert = path.join(fixture.root, 'search.crt');
    const key = path.join(fixture.root, 'search.key');
    const calls = [];

    await executeFile('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1',
      '-addext', 'subjectAltName=IP:127.0.0.1'], { timeout: 15000 });

    const server = createHttpsServer({ key: await readFile(key), cert: await readFile(cert) },
      async (request, response) => {
        let text = '';

        for await (const chunk of request) {
          text += chunk;
        }

        calls.push({ authorization: request.headers.authorization, body: JSON.parse(text) });

        if (failing) {
          response.writeHead(503, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { message: 'LOCAL_SEARCH_UNAVAILABLE' } }));

          return;
        }

        response.writeHead(200, { 'content-type': 'text/event-stream' });

        const search = {
          type: 'web_search_call',
          id: 'local-search-call',
          status: 'completed',
          action: {
            type: 'search',
            query: 'local probe',
            sources: [{ type: 'url', url: 'https://example.invalid/probe' }],
          },
        };
        const events = [
          { type: 'response.output_item.done', item: search },
          { type: 'response.output_text.delta', delta: 'SEARCH_SENTINEL' },
          {
            type: 'response.completed',
            response: {
              id: 'local-search',
              status: 'completed',
              output: [search],
            },
          },
        ];

        for (const event of events) {
          response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        }

        response.end();
      });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    }));

    const overlay = {
      ENABLE_WEB_SEARCH: 'true',
      WEB_SEARCH_API_KEY: 'synthetic-search-key',
      WEB_SEARCH_MODEL: 'local-search',
      WEB_SEARCH_BASE_URL: `https://127.0.0.1:${server.address().port}/v1`,
      WEB_SEARCH_ALLOWED_HOSTS: '127.0.0.1',
      WEB_SEARCH_TIMEOUT_MS: '10000',
      NODE_EXTRA_CA_CERTS: cert,
    };
    const action = { name: 'web_search', args: { query: 'local probe' } };

    fixture.actions.push(action);

    const handle = await hostProbe(fixture, runInput(fixture, 'shared-model(openai)', {
      permissionMode: 'yolo', providerSettings: { allowHostAccess: true },
    }), overlay);

    t.after(() => handle.close());

    const result = await handle.send({
      message: 'Вызови тестовый поиск.',
      signal: AbortSignal.timeout(90000),
    });

    assert.equal(action.missing, undefined);
    assert.ok(calls.length > 0, 'Вызван именно настроенный backend');
    assert.ok(calls.every((call) => call.authorization === 'Bearer synthetic-search-key'));
    assert.ok(calls.every((call) => call.body.model === 'local-search'));

    if (failing) {
      assert.ok(result.steps.some((step) => step.k === 'res' && step.error === true
        && /LOCAL_SEARCH_UNAVAILABLE|503|failed|unavailable/i.test(JSON.stringify(step))),
      JSON.stringify(result));

      const next = await handle.send({
        message: 'Обычный чат работает.',
        signal: AbortSignal.timeout(15000),
      });

      assert.match(next.reply, /Ответ настоящего CLI/);
    } else {
      assert.ok(result.steps.some((step) => step.k === 'res'
        && JSON.stringify(step).includes('SEARCH_SENTINEL')), JSON.stringify(result));
    }
  });
}

test('Qwen native Host: MCP сохраняет browser/SSH/DB/help и trusted scope', {
  timeout: 90000,
}, async (t) => {
  const fixture = await qwenNativeFixture(t);
  const calls = [];
  const workTools = createWorkTools({
    projectId: 'bound-project',
    chatKey: 'bound-chat',
    pluginEnabled: (id) => id === 'db',
    dbInvoke: async (scope, input) => {
      calls.push({
        tool: 'db',
        scope,
        input,
      });

      return { ok: true, rows: [['DB_SENTINEL']] };
    },
    invoke: async (scope, input) => {
      calls.push({
        tool: 'ssh',
        scope,
        input,
      });

      return { ok: true, output: 'SSH_SENTINEL' };
    },
    browserAvailable: () => true,
    browserOwner: 'bound-browser-owner',
    browserInvoke: async (owner, input) => {
      calls.push({
        tool: 'browser',
        owner,
        input,
      });

      return { ok: true, tabs: [] };
    },
    helpInvoke: async (input) => {
      calls.push({ tool: 'help', input });

      return { ok: true, text: 'HELP_SENTINEL' };
    },
  });
  const work = await createWorkIpc({ root: fixture.workspace, workTools });

  t.after(() => work.close());

  const actions = [
    { match: 'supervised_db', args: {
      action: 'query',
      text: 'SELECT 1',
      projectId: 'foreign',
    } },
    { match: 'supervised_ssh', args: {
      action: 'exec',
      command: 'printf synthetic',
      chatKey: 'foreign',
    } },
    { match: 'grigdesk_browser', args: { action: 'list' } },
    { match: 'grigdesk_help', args: { action: 'index' } },
    { match: 'grigdesk_browser', args: { action: 'list', owner: 'foreign' } },
  ];

  fixture.actions.push(...actions);

  const handle = await hostProbe(fixture, runInput(fixture, 'shared-model(openai)', {
    permissionMode: 'yolo',
    providerSettings: { allowHostAccess: true },
    workTools,
    mcpServers: [{ name: 'grigdesk-work', ...work.mcpServer }],
  }));

  t.after(() => handle.close());

  const result = await handle.send({
    message: 'Вызови только тестовые порты.',
    signal: AbortSignal.timeout(60000),
  });

  assert.ok(actions.every((action) => action.missing === undefined));
  assert.deepEqual(calls.find((call) => call.tool === 'db').scope,
    { projectId: 'bound-project', chatKey: 'bound-chat' });
  assert.deepEqual(calls.find((call) => call.tool === 'ssh').scope, { chatKey: 'bound-chat' });
  assert.equal(calls.filter((call) => call.tool === 'browser').length, 1);
  assert.equal(calls.find((call) => call.tool === 'browser').owner, 'bound-browser-owner');
  assert.equal(calls.filter((call) => call.tool === 'help').length, 1);
  assert.ok(JSON.stringify(result.steps).includes('DB_SENTINEL'));
  assert.ok(JSON.stringify(result.steps).includes('SSH_SENTINEL'));
  assert.ok(JSON.stringify(result.steps).includes('HELP_SENTINEL'));
});

for (const [mode, answer, allowed] of [
  ['default', false, false],
  ['default', true, true],
  ['auto', true, true],
  ['plan', false, false],
  ['yolo', true, true],
]) {
  test(`Qwen native Host: approval ${mode}, answer=${answer}`, { timeout: 90000 }, async (t) => {
    const fixture = await qwenNativeFixture(t);
    const canary = path.join(fixture.workspace, 'approval-canary');
    const action = { name: 'run_shell_command', args: { command: `printf APPROVED > '${canary}'` } };
    let asked = 0;

    fixture.actions.push(action);

    const handle = await hostProbe(fixture, runInput(fixture, 'shared-model(openai)', {
      permissionMode: mode,
      providerSettings: { allowHostAccess: true },
      onPermission: async () => {
        asked += 1;

        return { allow: answer };
      },
    }));

    t.after(() => handle.close());
    await handle.send({ message: 'Выполни разрешённую проверку.', signal: AbortSignal.timeout(60000) });
    assert.equal(action.missing, undefined);

    if (mode === 'default') {
      assert.ok(asked > 0, 'Сохранено native ручное подтверждение');
    }

    if (allowed) {
      assert.equal(await readFile(canary, 'utf8'), 'APPROVED');
    } else {
      await assert.rejects(access(canary), { code: 'ENOENT' });
    }
  });
}

test('Qwen native Host: картинка второго send доходит байтами в том же процессе', {
  timeout: 90000,
}, async (t) => {
  const fixture = await qwenNativeFixture(t);
  const image = await qwenImage(fixture);
  const original = await readFile(fixture.file, 'utf8');
  const handle = await hostProbe(fixture, runInput(fixture, 'shared-model(openai)', {
    permissionMode: 'yolo', providerSettings: { allowHostAccess: true },
  }));

  t.after(() => handle.close());
  await handle.send({ message: 'Первый.', signal: AbortSignal.timeout(25000) });

  const pid = handle.pid;
  const before = fixture.requests.length;

  await handle.send({
    message: 'Второй с картинкой.',
    attachmentPaths: [image.file],
    attachmentsDir: image.root,
    signal: AbortSignal.timeout(25000),
  });

  const parts = fixture.requests.slice(before).flatMap((request) => (request.messages || [])
    .flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .filter((part) => part.type === 'image_url'));

  assert.ok(parts.length > 0);
  assert.ok(parts.every((part) => part.image_url.url
    === `data:image/png;base64,${QWEN_TEST_PNG.toString('base64')}`));
  assert.equal(handle.pid, pid);
  assert.equal(await readFile(fixture.file, 'utf8'), original, 'Native не изменил исходные settings');
});

for (const viaPool of [false, true]) {
  test(`Qwen native Host: close гасит активный detached shell и lease, pool=${viaPool}`, {
    timeout: 90000,
  }, async (t) => {
    const fixture = await qwenNativeFixture(t);
    const pidFile = path.join(fixture.workspace, 'background.pid');
    const release = path.join(fixture.workspace, 'background.release');
    const hookRelease = path.join(fixture.workspace, 'hook.release');
    const late = path.join(fixture.workspace, 'late-effect');
    const source = JSON.parse(await readFile(fixture.file, 'utf8'));

    source.hooks = { SessionEnd: [{ hooks: [{ type: 'command',
      command: `while [ ! -f '${hookRelease}' ]; do sleep 0.05; done`,
    }] }] };
    await fixture.writeSettings(source);

    const stranger = spawnSentinel(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });

    t.after(() => stranger.kill('SIGKILL'));

    const action = { name: 'run_shell_command', args: {
      command: `trap '' TERM; echo $$ > '${pidFile}'; `
        + `while [ ! -f '${release}' ]; do sleep 0.05; done; printf BAD > '${late}'`,
      is_background: true,
    } };

    fixture.actions.push(action);

    const handle = await hostProbe(fixture, runInput(fixture, 'shared-model(openai)', {
      permissionMode: 'yolo', providerSettings: { allowHostAccess: true },
    }));
    const pool = new ChatLiveSessions();

    t.after(async () => {
      await handle.close();
      await pool.closeAll();
    });

    const turn = { message: 'Запусти тестовый фон.', signal: AbortSignal.timeout(25000) };

    if (viaPool) {
      await pool.run({
        chatKey: 'owned-close',
        executor: {
          id: 'owned-native',
          session: {
            mode: 'persistent',
            keepAlive: true,
            open: async () => handle,
          },
        },
      }, turn);
    } else {
      await handle.send(turn);
    }

    await until(() => access(pidFile).then(() => true, () => false), 'PID активного native shell');

    const shellPid = Number((await readFile(pidFile, 'utf8')).trim());

    assert.equal(action.missing, undefined);
    assert.doesNotThrow(() => process.kill(shellPid, 0));

    const leases = { directory: path.join(fixture.dataHome, 'provider-cli-leases'), providerId: 'qwen' };

    assert.ok((await inspectCliLeases(leases)).length > 0);

    if (viaPool) {
      await pool.closeAll();
    } else {
      await handle.close();
    }

    await until(() => {
      try {
        process.kill(shellPid, 0);

        return false;
      } catch (error) {
        return error.code === 'ESRCH';
      }
    }, 'detached shell завершён собственным OS scope');
    assert.deepEqual(await inspectCliLeases(leases), []);
    assert.doesNotThrow(() => process.kill(stranger.pid, 0));
    await writeFile(release, 'release');
    await writeFile(hookRelease, 'release');
    await assert.rejects(access(late), { code: 'ENOENT' });
  });
}
