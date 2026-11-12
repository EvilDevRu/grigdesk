import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { qwenNativeFixture } from '../helpers/qwenNativeFixture.mjs';
import { qwenAdapter, runInput, selectedModel } from '../helpers/qwenFixture.mjs';

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
