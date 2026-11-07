// Claude: уточнение уходит в тот же stream-json процесс, ответ приходит до финала.
//
// Проверяем оба режима: живую сессию и разовый запуск, который на время хода поднимает
// stream-json сам. Фикстура синтетическая: модели нет, но протокол и корреляция result те же.
import assert from 'node:assert/strict';
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ChatAssistantMessages } from '../../server/src/lib/chat/assistantMessages.ts';
import { ChatAssistantPublisher } from '../../server/src/lib/chat/assistantPublisher.ts';
import claude, { claudeProviderSettingsArgs } from '../../server/src/lib/executors/claude.ts';
import { claudeSessionArgs, openClaudeStreamSession } from '../../server/src/lib/executors/_claudeStream.ts';
import { parseInTurnCapability } from '../../shared/chat/chatInTurnContracts.ts';
import { assertInTurnConformance } from './helpers/in-turn-conformance.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE = path.join(ROOT, 'tests/fixtures/claude-in-turn/fake-claude.mjs');

/**
 * Каждый тест получает собственный процесс фикстуры и управляемые файловые барьеры.
 * Режимы воспроизводят два подтверждённых порядка событий настоящего CLI.
 */
async function fixture(t, { holdFinal = false, steers = 1, mode = 'merge',
  noLifecycle = false, holdStart = false } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-claude-in-turn-'));
  const bin = path.join(dir, 'claude-fixture');
  const trace = path.join(dir, 'trace.jsonl');

  await copyFile(FIXTURE, bin);
  await chmod(bin, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));

  return {
    dir,
    bin,
    trace,
    env: {
      ...process.env,
      GRIGDESK_CLAUDE_FIXTURE_TRACE: trace,
      ...(holdFinal ? { GRIGDESK_CLAUDE_FIXTURE_HOLD_FINAL: '1' } : {}),
      GRIGDESK_CLAUDE_FIXTURE_MODE: mode,
      ...(noLifecycle ? { GRIGDESK_CLAUDE_FIXTURE_NO_LIFECYCLE: '1' } : {}),
      ...(holdStart ? { GRIGDESK_CLAUDE_FIXTURE_HOLD_START: '1' } : {}),
      ...(steers > 1 ? { GRIGDESK_CLAUDE_FIXTURE_STEERS: String(steers) } : {}),
    },
  };
}

async function readTrace(file) {
  let raw = '';

  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return [];
  }

  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function waitFor(check, what, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const value = await check();

    if (value) {
      return value;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error(`не дождались: ${what}`);
}

/** Общая проверка канала: порт, доставка, ответ до финала и подтверждение потребления. */
async function exercisePort(t, { start }) {
  const assistant = [];
  const receipts = [];
  const steps = [];
  let port = null;

  const { run, portReady, releaseFinal } = await start({
    onInTurnReady(given) {
      port = given;
    },
    onInTurnReceipt(event) {
      receipts.push(event);
    },
    onAssistantMessage(event) {
      assistant.push(event);
    },
    onStep(step) {
      steps.push(step);
    },
  });
  let settled = false;
  const completion = run.finally(() => { settled = true; });

  await waitFor(() => port, 'готовый порт уточнений');
  const forwarded = await port.deliver({
    messageId: 'message-fixture-0001', text: 'Почему первый файл?', sequence: 1,
  });

  assert.deepEqual(forwarded, { ok: true, state: 'forwarded' });

  const answer = await waitFor(
    () => assistant.find((event) => event.complete && event.assistantMessageId === 'assistant-injected'),
    'завершённый ответ на уточнение',
  );
  const answerBeforeFinal = !settled;

  assert.match(answer.text, /Отвечаю: Почему первый файл\?/);

  const consumed = await waitFor(
    () => receipts.find((event) => event.state === 'consumed'),
    'подтверждение потребления',
  );

  assert.equal(consumed.messageId, 'message-fixture-0001');

  await releaseFinal?.();

  const result = await completion;

  assert.match(String(result.reply), /Второй файл проверен/, 'исходный ход продолжился и завершился своим ответом');

  const late = await port.deliver({ messageId: 'message-fixture-0002', text: 'Поздний вопрос', sequence: 2 });

  assert.equal(late.ok, false);
  assert.equal(late.code, 'turn_changed');

  return { assistant, steps, portReady, answerBeforeFinal, forwarded, late, result };
}

test('Claude: живая stream-json сессия принимает уточнение в активный ход', async (t) => {
  const f = await fixture(t, { holdFinal: true });
  const session = openClaudeStreamSession({
    bin: f.bin,
    args: claudeSessionArgs({}),
    cwd: f.dir,
    env: f.env,
  });

  t.after(() => session.close());

  const evidence = await exercisePort(t, {
    start: async (callbacks) => {
      const run = session.send({ message: 'Проверь два файла.', ...callbacks });

      return {
        run, portReady: null,
        releaseFinal: () => writeFile(`${f.trace}.release`, ''),
      };
    },
  });

  const trace = await readTrace(f.trace);
  const clientLines = trace.filter((entry) => entry.direction === 'client');

  assert.equal(clientLines.length, 2, 'оба сообщения ушли в один процесс');
  assert.equal(clientLines[1].message.message.content[0].text, 'Почему первый файл?');
  assert.equal(
    trace.find((entry) => entry.direction === 'process').argv.includes('--replay-user-messages'),
    true,
  );
  assert.equal(trace.filter((entry) => entry.message?.type === 'result').length, 1);
  assert.equal(evidence.result.assistantMessageId, 'assistant-final');

  for (const entry of clientLines) {
    assert.match(entry.message.uuid, /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/u);
  }

  assert.notEqual(clientLines[0].message.uuid, clientLines[1].message.uuid);
  assert.equal(trace.filter((entry) => entry.direction === 'process').length, 1, 'второго процесса нет');
  assertInTurnConformance({
    name: 'Claude', capability: claude.inTurnInput,
    turns: trace.filter((entry) => entry.direction === 'process').length,
    steers: clientLines.length - 1,
    cancels: trace.filter((entry) => entry.direction === 'client'
      && JSON.stringify(entry).includes('interrupt')).length,
    forwarded: evidence.forwarded.ok,
    answerBeforeFinal: evidence.answerBeforeFinal,
    answerCopies: evidence.assistant.filter((event) => event.complete
      && event.assistantMessageId === 'assistant-injected').length,
    finalReply: String(evidence.result.reply),
    lateRejected: evidence.late.ok === false,
  });
});

test('Claude: разовый запуск поднимает stream-json на время хода', async (t) => {
  const f = await fixture(t, { holdFinal: true });

  await exercisePort(t, {
    start: async (callbacks) => {
      const run = claude.run({
        config: { claudeBin: f.bin },
        env: f.env,
        message: 'Проверь два файла.',
        cwd: f.dir,
        sessionId: null,
        permissionMode: 'default',
        providerSettings: {},
        ...callbacks,
      });

      return {
        run, portReady: null,
        releaseFinal: () => writeFile(`${f.trace}.release`, ''),
      };
    },
  });

  const trace = await readTrace(f.trace);
  const processEntry = trace.find((entry) => entry.direction === 'process');

  assert.ok(processEntry.argv.includes('--input-format'), 'разовый ход идёт через stream-json');
  assert.ok(processEntry.argv.includes('--replay-user-messages'), 'разовый ход запрашивает lifecycle');
  assert.ok(
    !processEntry.argv.includes('Проверь два файла.'),
    'текст хода не передан аргументом argv',
  );
});

test('Claude: два уточнения идут по порядку в один stream-json процесс', async (t) => {
  const f = await fixture(t, { holdFinal: true, steers: 2 });
  const session = openClaudeStreamSession({
    bin: f.bin,
    args: claudeSessionArgs({}),
    cwd: f.dir,
    env: f.env,
  });
  t.after(() => session.close());
  const assistant = [];
  let port;
  const run = session.send({
    message: 'Проверь два файла.',
    onInTurnReady: (given) => { port = given; },
    onAssistantMessage: (event) => assistant.push(event),
  });
  await waitFor(() => port, 'порт уточнения');
  assert.equal((await port.deliver({
    messageId: 'message-fixture-0001', text: 'Первый вопрос', sequence: 1,
  })).ok, true);
  await waitFor(() => assistant.some((event) => event.complete
    && event.assistantMessageId === 'assistant-injected-1'), 'первый ответ');
  assert.equal((await port.deliver({
    messageId: 'message-fixture-0002', text: 'Второй вопрос', sequence: 2,
  })).ok, true);
  await waitFor(() => assistant.some((event) => event.complete
    && event.assistantMessageId === 'assistant-injected-2'), 'второй ответ');
  await writeFile(`${f.trace}.release`, '');
  assert.match(String((await run).reply), /Второй файл проверен/u);
  const trace = await readTrace(f.trace);
  assert.equal(trace.filter((entry) => entry.direction === 'process').length, 1);
  assert.deepEqual(trace.filter((entry) => entry.direction === 'client')
    .map((entry) => entry.message.message.content[0].text), [
    'Проверь два файла.', 'Первый вопрос', 'Второй вопрос',
  ]);
});

test('Claude: текстовый шаг несёт id блока, а capability подтверждает потребление', async (t) => {
  const f = await fixture(t);
  const steps = [];
  let port = null;
  let releasePort;

  const portReady = new Promise((resolve) => {
    releasePort = resolve;
  });
  const run = claude.run({
    config: { claudeBin: f.bin },
    env: f.env,
    message: 'Проверь два файла.',
    cwd: f.dir,
    sessionId: null,
    permissionMode: 'default',
    providerSettings: {},
    onStep(step) {
      steps.push(step);
    },
    onInTurnReady(given) {
      port = given;
      releasePort();
    },
  });

  await portReady;

  const step = await waitFor(
    () => steps.find((item) => item.k === 'text' && item.text.includes('Начинаю проверку')),
    'шаг с id сообщения',
  );

  assert.equal(step.id, 'assistant-first');

  await port.deliver({ messageId: 'message-fixture-0001', text: 'Вопрос', sequence: 1 });
  await run;

  assert.deepEqual(
    parseInTurnCapability(claude.inTurnInput),
    { protocol: 1, text: true, confirmation: 'consumed', images: true },
  );
});

/**
 * Сценарий собирает транспортный trace, квитанции и ответы реального адаптера.
 * Ошибка хода сразу перехватывается, чтобы красная проверка не теряла teardown.
 */
async function lifecycleFixture(t, options = {}) {
  const f = await fixture(t, options);
  const assistant = [];
  const receipts = [];
  const background = [];
  const backgroundStarts = [];
  const steps = [];
  let port;
  let settled = false;
  const session = openClaudeStreamSession({
    bin: f.bin,
    args: options.withoutFlag
      ? claudeSessionArgs({}).filter((arg) => arg !== '--replay-user-messages')
      : claudeSessionArgs({}),
    cwd: f.dir,
    env: f.env,
    hooks: {
      onBackgroundStart: () => backgroundStarts.push(true),
      onBackground: (event) => background.push(event),
    },
  });

  t.after(() => session.close());

  const run = session.send({
    message: 'Проверь два файла.',
    onInTurnReady: (given) => {
      port = given;
    },
    onAssistantMessage: (event) => assistant.push(event),
    onInTurnReceipt: (event) => receipts.push(event),
    onStep: (step) => steps.push(step),
  });

  void run.then(() => {
    settled = true;
  }, () => {
    settled = true;
  });

  await waitFor(() => port, 'порт уточнения');
  await port.deliver({
    messageId: 'grigdesk-non-uuid',
    text: 'Вопрос',
    sequence: 1,
  });

  return {
    ...f,
    session,
    run,
    port,
    assistant,
    receipts,
    background,
    backgroundStarts,
    steps,
    isSettled: () => settled,
  };
}

test('Claude merge: consumed приходит на started до единственного result, блоки завершены', async (t) => {
  const f = await lifecycleFixture(t, { holdStart: true, holdFinal: true });

  await waitFor(async () => (await readTrace(f.trace))
    .filter((row) => row.message?.state === 'queued').length === 2, 'уточнение в очереди');
  assert.equal(f.receipts.length, 0);

  await writeFile(`${f.trace}.start`, '');
  await waitFor(() => f.receipts.some((event) => event.state === 'consumed'), 'consumed на started');

  assert.deepEqual(f.receipts, [{ messageId: 'grigdesk-non-uuid', state: 'consumed' }]);
  assert.equal((await readTrace(f.trace)).some((row) => row.message?.type === 'result'), false);
  assert.equal(f.isSettled(), false);

  await writeFile(`${f.trace}.release`, '');
  await waitFor(f.isSettled, 'merge закрывает ход на одном result');

  const result = await f.run;
  const complete = f.assistant.filter((event) => event.complete);

  assert.deepEqual(complete.map((event) => event.assistantMessageId), [
    'assistant-first', 'assistant-injected', 'assistant-final',
  ]);
  assert.equal(result.assistantMessageId, 'assistant-final');
  assert.equal(f.session.busy, false);
  assert.equal(f.steps.some((step) => step.k === 'text' && step.text === 'Вопрос'), false);
});

test('Claude next-turn: два result, финал связан с последним блоком', async (t) => {
  const f = await lifecycleFixture(t, { mode: 'next-turn' });

  await waitFor(() => f.assistant.some((event) => event.complete), 'завершённый итог задачи');
  assert.equal(f.isSettled(), false);
  assert.equal(f.session.busy, true);
  assert.equal(f.receipts.length, 0);

  await writeFile(`${f.trace}.next`, '');
  await waitFor(f.isSettled, 'закрытие на втором result');

  const result = await f.run;
  const complete = f.assistant.filter((event) => event.complete);

  assert.deepEqual(complete.map((event) => [event.assistantMessageId, event.text]), [
    ['assistant-final', 'Второй файл проверен.'],
    ['assistant-injected', 'Отвечаю: Вопрос'],
  ]);
  assert.equal(result.reply, 'Отвечаю: Вопрос');
  assert.equal(result.assistantMessageId, 'assistant-injected');
  assert.equal(f.receipts[0]?.state, 'consumed');
  assert.equal(f.backgroundStarts.length, 0);
});

test('Claude: lifecycle и replay вне хода не создают фон, result без lifecycle закрывает ход', async (t) => {
  for (const withoutFlag of [false, true]) {
    const f = await lifecycleFixture(t, { withoutFlag });

    await waitFor(f.isSettled, 'result закрывает ход даже без lifecycle');
    await f.run;
    await waitFor(async () => (await readTrace(f.trace))
      .some((row) => row.message?.type === 'result'), 'финал в trace');
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(f.session.busy, false);
    assert.equal(f.backgroundStarts.length, 0);
    assert.equal(f.background.length, 0);

    if (withoutFlag) {
      assert.equal(f.receipts.length, 0, 'без started нельзя подтверждать consumed');
    }
  }
});

test('Claude: stop очереди даёт failed, поздний запуск CLI сразу прерывается и молчит', async (t) => {
  const f = await lifecycleFixture(t, { holdStart: true });
  const rejected = assert.rejects(f.run, (error) => error.stopped === true);

  await waitFor(async () => (await readTrace(f.trace))
    .filter((row) => row.message?.state === 'queued').length === 2, 'queued без started');
  await f.session.interrupt();
  await waitFor(f.isSettled, 'stop закрыл ход');
  await rejected;

  assert.deepEqual(f.receipts, [{ messageId: 'grigdesk-non-uuid', state: 'failed' }]);
  assert.equal(f.session.busy, false);

  let nextSettled = false;
  const nextAssistant = [];
  const next = f.session.send({
    message: 'Новая задача',
    onAssistantMessage: (event) => nextAssistant.push(event),
  });

  void next.then(() => {
    nextSettled = true;
  }, () => {
    nextSettled = true;
  });

  assert.equal((await f.port.deliver({ messageId: 'late', text: 'Поздний ввод' })).ok, false);
  await waitFor(async () => (await readTrace(f.trace)).filter((row) => row.direction === 'client'
    && row.message.request?.subtype === 'interrupt').length === 2, 'автоматический стоп уточнения');
  await waitFor(() => nextSettled, 'следующий заказанный ход');
  await writeFile(`${f.trace}.background`, '');
  await new Promise((resolve) => setTimeout(resolve, 25));

  const users = (await readTrace(f.trace))
    .filter((row) => row.direction === 'client' && row.message.type === 'user');

  assert.equal(users.length, 3);
  assert.equal(users[2].message.message.content[0].text, 'Новая задача');
  assert.equal((await next).reply, 'Новый ход завершён.');
  assert.equal(f.backgroundStarts.length, 0, 'отменённое уточнение не открывает фоновый ход');
  assert.equal(f.background.length, 0);
  assert.equal(nextAssistant.some((event) => event.assistantMessageId === 'assistant-background'), false);
  assert.equal(f.receipts.some((event) => event.state === 'consumed'), false);
});

test('Claude: stop нового send во время ожидания очереди не отправляет отменённый ввод', async (t) => {
  const f = await lifecycleFixture(t, { holdStart: true });
  const rejected = assert.rejects(f.run, (error) => error.stopped === true);

  await waitFor(async () => (await readTrace(f.trace))
    .filter((row) => row.message?.state === 'queued').length === 2, 'queued без started');
  await f.session.interrupt();
  await rejected;

  const next = f.session.send({ message: 'Отменённая новая задача' });
  const nextRejected = assert.rejects(next, (error) => error.stopped === true);

  assert.equal(f.session.busy, true, 'ожидание очереди считается занятым ходом');
  await f.session.interrupt();
  await nextRejected;
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal((await readTrace(f.trace))
    .filter((row) => row.direction === 'client' && row.message.type === 'user').length, 2);
  assert.equal(f.backgroundStarts.length, 0);
});

test('Claude late: queued после финала даёт consumed, ответ уходит в фон, новый send ждёт', async (t) => {
  const f = await lifecycleFixture(t, { mode: 'late' });
  const result = await f.run;

  assert.equal(result.reply, 'Второй файл проверен.');
  await waitFor(async () => (await readTrace(f.trace))
    .filter((row) => row.message?.state === 'queued').length === 2, 'queued после финала');

  let nextSettled = false;
  const next = f.session.send({ message: 'Новая задача' });

  void next.then(() => {
    nextSettled = true;
  }, () => {
    nextSettled = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(nextSettled, false);
  assert.equal((await readTrace(f.trace))
    .filter((row) => row.direction === 'client' && row.message.type === 'user').length, 2,
  'новый ввод не вливается в запущенное уточнение');

  await writeFile(`${f.trace}.next`, '');
  await waitFor(() => nextSettled, 'новый ход после позднего уточнения');

  assert.deepEqual(f.receipts, [{ messageId: 'grigdesk-non-uuid', state: 'consumed' }]);
  assert.deepEqual(f.background.map((event) => event.reply), ['Отвечаю: Вопрос']);
  assert.equal((await next).reply, 'Новый ход завершён.');
});

const runId = 'synthetic-run-0001';
const chatKey = 'synthetic-chat';
// Вызов инструмента закрывает текст перед ним; текст после вызова с тем же id — новый блок.
const commentaryBlocks = [
  ['commentary-block-1', 'Проверяю документ 1.'],
  ['commentary-block-2', 'Проверяю документ 2.\nПродолжаю проверку.'],
  ['commentary-block-2-2', 'Команда подготовлена.'],
  ['commentary-block-3', 'Проверяю документ 3.'],
];
const commentaryText = commentaryBlocks.map(([, text]) => text);

/**
 * Изолированный процесс использует настоящий адаптер и журнал без вызовов модели.
 * Общий teardown закрывает только процесс этой проверки и удаляет её временные файлы.
 */
async function startFixture(t, { mode = 'session', exit = false, blocks = '1' } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'claude-assistant-blocks-'));
  const bin = path.join(dir, 'claude-fixture');
  const release = path.join(dir, 'release');
  const journalDir = path.join(dir, 'assistant');
  const events = [];
  const published = [];
  const steps = [];
  const messages = new ChatAssistantMessages({ dir: journalDir });
  const env = {
    ...process.env,
    GRIGDESK_CLAUDE_FIXTURE_BLOCKS: blocks,
    CLAUDE_BLOCKS_RELEASE: release,
    CLAUDE_BLOCKS_EXIT: exit ? '1' : '0',
  };
  let sequence = 0;

  await copyFile(FIXTURE, bin);
  await chmod(bin, 0o755);

  const publisher = new ChatAssistantPublisher({
    messages,
    nextSequence: () => sequence += 1,
    onMessage: (block) => published.push(block),
  });
  const options = {
    message: 'Проверь три документа.',
    onStep: (step) => steps.push(step),
    onAssistantMessage(event) {
      events.push(event);

      return publisher.publish(runId, chatKey, event);
    },
  };
  const session = mode === 'session' ? openClaudeStreamSession({
    bin,
    args: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
    cwd: dir,
    env,
  }) : null;

  // Проваленная проверка не дошла до барьера: отпускаем фикстуру, иначе разовый процесс
  // так и ждёт файла и держит весь тестовый файл незавершённым.
  t.after(async () => {
    await writeFile(release, '');
    await run.catch(() => {});
    await session?.close();
    await rm(dir, { recursive: true, force: true });
  });

  const run = session ? session.send(options) : claude.run({
    ...options,
    config: { claudeBin: bin },
    env,
    cwd: dir,
    sessionId: null,
    permissionMode: 'default',
    providerSettings: {},
  });

  return {
    run,
    session,
    release,
    journalDir,
    messages,
    publisher,
    events,
    published,
    steps,
  };
}

for (const mode of ['session', 'run']) {
  test(`Claude: ${mode} завершает три реплики до финала и восстанавливает полный текст`, async (t) => {
    const f = await startFixture(t, { mode });
    let settled = false;
    const run = f.run.finally(() => {
      settled = true;
    });

    await waitFor(
      () => f.steps.filter((step) => step.k === 'res').length === 3,
      'три результата инструментов',
    );
    await f.publisher.flush(runId);

    assert.equal(settled, false, 'Исходный ход ещё работает.');
    assert.equal(f.messages.live(runId).length, 0, 'Готовые реплики больше не показывают «Пишет…».');
    assert.deepEqual(f.messages.byRun(runId).map((block) => block.text), commentaryText);
    assert.equal(f.events.some((event) => event.assistantMessageId === 'subagent-message-1'), false);

    for (const [id, text] of commentaryBlocks) {
      const published = f.published.filter((block) => block.assistantMessageId === id);

      assert.equal(published.at(-1)?.complete, true);
      assert.equal(published.at(-1)?.text, text);
      assert.equal(f.events.filter((event) => event.assistantMessageId === id && event.complete).length, 1);
    }

    await writeFile(f.release, '');

    const result = await run;

    await f.publisher.flush(runId);

    const restored = new ChatAssistantMessages({ dir: f.journalDir });

    await restored.load();

    assert.equal(result.reply, 'Проверка закончена.\nВсе документы проверены.');
    assert.equal(result.assistantMessageId, 'assistant-final', 'Финал дополняет уже показанный блок.');
    assert.equal(restored.byRun(runId).every((block) => block.complete), true);
    assert.deepEqual(restored.byRun(runId).map((block) => block.text), [...commentaryText, result.reply]);
    assert.equal(f.messages.live(runId).length, 0);
  });
}

test('Claude: обрыв процесса сохраняет завершённые реплики и не завершает текущий черновик', async (t) => {
  const f = await startFixture(t, { exit: true });
  const rejected = assert.rejects(f.run, /процесс агента завершился/);

  await waitFor(
    () => f.steps.filter((step) => step.k === 'res').length === 3,
    'три результата инструментов',
  );
  await writeFile(f.release, '');
  await rejected;
  await f.publisher.flush(runId);

  assert.deepEqual(f.messages.byRun(runId).filter((block) => block.complete).map((block) => block.text),
    commentaryText);
  assert.deepEqual(f.messages.live(runId).map((block) => block.assistantMessageId), ['assistant-final']);
  assert.equal(f.events.some((event) => event.assistantMessageId === 'assistant-final'
    && event.complete), false);
});

for (const mode of ['session', 'run']) {
  test(`Claude: ${mode} закрывает реплику на вызове инструмента, не дожидаясь его результата`, async (t) => {
    const f = await startFixture(t, { mode, blocks: 'held-tool' });
    let settled = false;
    const run = f.run.finally(() => {
      settled = true;
    });

    await waitFor(() => f.steps.some((step) => step.k === 'tool'), 'вызов долгой команды');
    await f.publisher.flush(runId);

    assert.equal(settled, false, 'Команда ещё выполняется.');
    assert.equal(f.steps.some((step) => step.k === 'res'), false, 'Результата команды ещё нет.');
    assert.equal(f.messages.live(runId).length, 0, 'Реплика перед командой не висит «Пишет…».');
    assert.deepEqual(f.messages.byRun(runId).map((block) => [block.assistantMessageId, block.text]),
      [['held-tool-message', 'Ветки нет — создам.']]);

    await writeFile(f.release, '');

    const result = await run;

    await f.publisher.flush(runId);

    assert.equal(result.reply, 'Ветка создана.');
    assert.equal(result.assistantMessageId, 'held-tool-final');
    assert.equal(f.events.filter((event) => event.assistantMessageId === 'held-tool-message'
      && event.complete).length, 1, 'Результат команды не завершает реплику повторно.');
    assert.equal(f.messages.byRun(runId).every((block) => block.complete), true);
  });
}

for (const mode of ['session', 'run']) {
  test(`Claude: ${mode} закрывает текст в начале аргументов tool_use`, async (t) => {
    const f = await startFixture(t, { mode, blocks: 'partial-tool' });

    await waitFor(() => f.events.some((event) => event.complete), 'раннее завершение текста');
    await f.publisher.flush(runId);

    assert.deepEqual(f.events.map((event) => [event.text, event.complete]), [
      ['Ветки нет.', false],
      ['Ветки нет.\nСоздам.', false],
      ['Ветки нет.\nСоздам.', true],
    ], 'субагент не закрывает растущий текст, главная граница сохраняет весь блок');
    assert.equal(f.steps.some((step) => step.k === 'tool' && step.id === 'synthetic-held-tool'), false);
    assert.equal(f.messages.live(runId).length, 0);

    const restored = new ChatAssistantMessages({ dir: f.journalDir });

    await restored.load();
    assert.deepEqual(restored.byRun(runId).map((block) => [block.text, block.complete]),
      [['Ветки нет.\nСоздам.', true]], 'журнал восстанавливает законченный текст ещё до вызова');

    await writeFile(f.release, '');
    await f.run;
    await f.publisher.flush(runId);

    assert.equal(f.events.filter((event) => event.assistantMessageId === 'held-tool-message'
      && event.complete).length, 1);
    assert.equal(f.events.some((event) => event.abandoned), false);
    assert.deepEqual(f.messages.byRun(runId).map((block) => [block.assistantMessageId, block.text]), [
      ['held-tool-message', 'Ветки нет.\nСоздам.'],
      ['held-tool-message-2', 'Ветка создана.'],
    ]);
  });
}

/** Настройки, которые адаптер передал процессу фикстуры флагом --settings. */
async function settingsOfProcess(trace) {
  const argv = (await readTrace(trace)).find((entry) => entry.direction === 'process').argv;

  return JSON.parse(argv[argv.lastIndexOf('--settings') + 1]);
}

/**
 * Один ход с уточнением: картинку агент откроет по пути из текста, поэтому запуску
 * нужно только право чтения каталога вложений без вопроса человеку.
 */
async function runWithAttachments(t, open) {
  const f = await fixture(t);
  const attachmentsDir = path.join(f.dir, 'chat attachments');
  let port = null;
  let releasePort;

  const portReady = new Promise((resolve) => {
    releasePort = resolve;
  });
  const run = open(f, attachmentsDir, (given) => {
    port = given;
    releasePort();
  });

  await portReady;
  await port.deliver({ messageId: 'message-fixture-0001', text: 'Вопрос', sequence: 1 });
  await run;

  return { settings: await settingsOfProcess(f.trace), attachmentsDir };
}

test('Claude: папка вложений читается без вопроса, правило не теряет нативные', () => {
  const args = claudeProviderSettingsArgs({}, {
    readOnlyDirs: ['/data/chat attachments'],
    nativeSettings: {
      payload: { permissions: { allow: ['Bash(git status)'], deny: ['WebFetch'] } },
    },
  });
  const payload = JSON.parse(args[args.indexOf('--settings') + 1]);

  assert.deepEqual(payload.permissions, {
    allow: ['Bash(git status)', 'Read(//data/chat attachments/**)'],
    deny: ['WebFetch'],
  });
  assert.equal(
    JSON.parse(claudeProviderSettingsArgs({})[1 + claudeProviderSettingsArgs({}).indexOf('--settings')])
      .permissions,
    undefined,
    'без каталога правил не добавляется',
  );
});

test('Claude: разовый запуск и живая сессия получают чтение папки вложений', async (t) => {
  const once = await runWithAttachments(t, (f, attachmentsDir, onInTurnReady) => claude.run({
    config: { claudeBin: f.bin },
    env: f.env,
    message: 'Проверь два файла.',
    cwd: f.dir,
    sessionId: null,
    permissionMode: 'default',
    providerSettings: {},
    attachmentsDir,
    onInTurnReady,
  }));

  assert.ok(once.settings.permissions.allow.includes(`Read(/${once.attachmentsDir}/**)`));

  const live = await runWithAttachments(t, (f, attachmentsDir, onInTurnReady) => {
    const session = claude.session.open({
      config: { claudeBin: f.bin },
      env: f.env,
      cwd: f.dir,
      permissionMode: 'default',
      providerSettings: {},
      attachmentsDir,
    });

    t.after(() => session.close());

    return session.send({ message: 'Проверь два файла.', onInTurnReady });
  });

  assert.ok(live.settings.permissions.allow.includes(`Read(/${live.attachmentsDir}/**)`));
});

test('Claude: документация плагинов читается без вопроса, смена каталогов переоткрывает сессию', async (t) => {
  const docsDir = '/srv/grigdesk plugins/audit/docs';
  const once = await runWithAttachments(t, (f, attachmentsDir, onInTurnReady) => claude.run({
    config: { claudeBin: f.bin },
    env: f.env,
    message: 'Проверь два файла.',
    cwd: f.dir,
    sessionId: null,
    permissionMode: 'default',
    providerSettings: {},
    attachmentsDir,
    pluginDocsDirs: [docsDir],
    onInTurnReady,
  }));

  assert.ok(once.settings.permissions.allow.includes(`Read(/${once.attachmentsDir}/**)`));
  assert.ok(once.settings.permissions.allow.includes(`Read(/${docsDir}/**)`));

  const live = await runWithAttachments(t, (f, attachmentsDir, onInTurnReady) => {
    const session = claude.session.open({
      config: { claudeBin: f.bin },
      env: f.env,
      cwd: f.dir,
      permissionMode: 'default',
      providerSettings: {},
      attachmentsDir,
      pluginDocsDirs: [docsDir],
    });

    t.after(() => session.close());

    return session.send({ message: 'Проверь два файла.', onInTurnReady });
  });

  assert.ok(live.settings.permissions.allow.includes(`Read(/${docsDir}/**)`));
  assert.ok(claude.session.restartOn.includes('pluginDocsDirs'),
    'право чтения задаётся при запуске процесса — новый набор каталогов требует переоткрытия');
});
