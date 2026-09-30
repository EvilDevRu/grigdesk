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

import claude from '../../server/src/lib/executors/claude.ts';
import { openClaudeStreamSession } from '../../server/src/lib/executors/_claudeStream.ts';
import { parseInTurnCapability } from '../../shared/chatInTurnContracts.ts';
import { assertInTurnConformance } from './helpers/in-turn-conformance.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE = path.join(ROOT, 'tests/fixtures/claude-in-turn/fake-claude.mjs');

async function fixture(t, { holdFinal = false, steers = 1 } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cockpit-claude-in-turn-'));
  const bin = path.join(dir, 'claude-fixture');
  const trace = path.join(dir, 'trace.jsonl');

  await copyFile(FIXTURE, bin);
  await chmod(bin, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));

  return {
    dir, bin, trace,
    env: { ...process.env, COCKPIT_CLAUDE_FIXTURE_TRACE: trace,
      ...(holdFinal ? { COCKPIT_CLAUDE_FIXTURE_HOLD_FINAL: '1' } : {}),
      ...(steers > 1 ? { COCKPIT_CLAUDE_FIXTURE_STEERS: String(steers) } : {}) },
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
    args: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
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
  assert.ok(
    !processEntry.argv.includes('Проверь два файла.'),
    'текст хода не передан аргументом argv',
  );
});

test('Claude: два уточнения идут по порядку в один stream-json процесс', async (t) => {
  const f = await fixture(t, { holdFinal: true, steers: 2 });
  const session = openClaudeStreamSession({
    bin: f.bin,
    args: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
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
    { protocol: 1, text: true, confirmation: 'consumed' },
  );
});
