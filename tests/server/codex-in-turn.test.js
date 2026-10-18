// Codex: уточнение уходит в ТОТ ЖЕ активный ход через turn/steer.
//
// Фикстура держит ход открытым: комментарий уже показан, инструмент ещё идёт. Проверяем,
// что steer адресован текущему provider-ходу, второго turn/start нет, отмены нет, а ответ
// на уточнение приходит до финала исходной работы.
import assert from 'node:assert/strict';
import { chmod, copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import codex from '../../server/src/lib/executors/codex.ts';
import { assertInTurnConformance } from './helpers/in-turn-conformance.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE = path.join(ROOT, 'tests/fixtures/codex-app-server/rich-turn-0.149.0.mjs');
// Те же идентификаторы, что объявляет фикстура: ими проверяется адресация steer.
const CODEX_THREAD_ID = '00000000-0000-7000-8000-000000000049';
const CODEX_TURN_ID = '00000000-0000-7000-8000-00000000004a';

async function fixture(t, scenario = 'steer', env = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-codex-in-turn-'));
  const bin = path.join(dir, 'codex-fixture');
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
      GRIGDESK_CODEX_FIXTURE_TRACE: trace,
      GRIGDESK_CODEX_FIXTURE_SCENARIO: scenario,
      GRIGDESK_CODEX_FIXTURE_EXPECT_HOOK: '0',
      ...env,
    },
  };
}

function runOptions(f, overrides = {}) {
  return {
    config: { codexBin: f.bin },
    env: f.env,
    message: 'Проверь два файла.',
    cwd: f.dir,
    extraDirs: [],
    model: 'gpt-contract-0.149',
    effort: 'medium',
    sessionId: null,
    compactWindow: 0,
    providerSettings: { blockDirectSsh: false, blockDirectDb: false },
    tokenInfoReader: async () => null,
    ...overrides,
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

async function waitFor(check, what, timeoutMs = 3000) {
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

test('Codex: уточнение доходит в активный ход и не создаёт второй turn/start', async (t) => {
  const f = await fixture(t, 'steer', { GRIGDESK_CODEX_FIXTURE_REQUIRE_RESUME: '1' });
  const statuses = [];
  const assistant = [];
  let port = null;
  let settled = false;
  let answerBeforeFinal = false;
  let releasePort;

  const portReady = new Promise((resolve) => {
    releasePort = resolve;
  });
  const run = codex.run(runOptions(f, {
    onInTurnReady(given) {
      port = given;
      releasePort();
    },
    onInTurnAvailability(status) {
      statuses.push(status);
    },
    onAssistantMessage(event) {
      assistant.push(event);

      // Порядок фиксируется при доставке, а не после следующего опроса таймера:
      // ответ и финал могут прийти в одном чтении stdout.
      if (event.complete && event.assistantMessageId === 'steer-answer-1') {
        answerBeforeFinal = !settled;
      }
    },
  })).finally(() => { settled = true; });

  await portReady;
  assert.ok(port, 'порт получен, когда провайдер назвал id хода');
  assert.deepEqual(statuses[0], { available: true });

  const forwarded = await port.deliver({
    messageId: 'message-fixture-0001',
    text: 'Почему начал с первого файла?',
    sequence: 1,
  });

  assert.deepEqual(forwarded, { ok: true, state: 'forwarded' });

  const answer = await waitFor(
    () => assistant.find((event) => event.complete && event.text.includes('Отвечаю на уточнение')),
    'ответ на уточнение до финала',
  );

  assert.equal(answer.assistantMessageId, 'steer-answer-1');
  assert.match(answer.text, /Почему начал с первого файла\?/);

  const result = await run;

  assert.match(String(result.reply), /Второй файл проверен/);
  assert.ok(
    assistant.findIndex((event) => event.complete
      && event.assistantMessageId === 'answer-after-steer') > assistant.indexOf(answer),
    'завершённый ответ на уточнение доставлен раньше завершённого итогового блока',
  );

  const trace = await readTrace(f.trace);
  const clientMethods = trace
    .filter((entry) => entry.direction === 'client' && entry.message?.method)
    .map((entry) => entry.message.method);

  assert.equal(clientMethods.filter((method) => method === 'turn/start').length, 1);
  assert.equal(clientMethods.filter((method) => method === 'turn/steer').length, 1);
  assert.equal(clientMethods.filter((method) => method === 'turn/interrupt').length, 0);

  const steer = trace.find((entry) => entry.message?.method === 'turn/steer').message;

  assert.equal(steer.params.expectedTurnId, CODEX_TURN_ID);
  assert.equal(steer.params.threadId, CODEX_THREAD_ID);
  assert.equal(steer.params.clientUserMessageId, 'message-fixture-0001');
  assert.equal(steer.params.input[0].text, 'Почему начал с первого файла?');
  assert.match(steer.params.input[1].text, /вернись к ранее поставленной задаче/);

  // После финала порт закрыт: позднее сообщение не уходит в следующий ход.
  const late = await port.deliver({
    messageId: 'message-fixture-0002',
    text: 'Поздний вопрос',
    sequence: 2,
  });

  assert.equal(late.ok, false);
  assert.equal(late.code, 'turn_changed');
  assertInTurnConformance({
    name: 'Codex', capability: codex.inTurnInput,
    turns: clientMethods.filter((method) => method === 'turn/start').length,
    steers: clientMethods.filter((method) => method === 'turn/steer').length,
    cancels: clientMethods.filter((method) => method === 'turn/interrupt').length,
    forwarded: forwarded.ok,
    answerBeforeFinal,
    answerCopies: assistant.filter((event) => event.complete
      && event.assistantMessageId === answer.assistantMessageId).length,
    finalReply: String(result.reply),
    lateRejected: late.ok === false,
  });
});

test('Codex: два уточнения подряд идут в один ход по порядку', async (t) => {
  const f = await fixture(t, 'steer', { GRIGDESK_CODEX_FIXTURE_STEERS: '2' });
  const assistant = [];
  let port = null;
  let releasePort;

  const portReady = new Promise((resolve) => {
    releasePort = resolve;
  });
  const run = codex.run(runOptions(f, {
    onInTurnReady(given) {
      port = given;
      releasePort();
    },
    onAssistantMessage(event) {
      assistant.push(event);
    },
  }));

  await portReady;

  assert.deepEqual(
    await port.deliver({ messageId: 'message-fixture-0001', text: 'Первый вопрос', sequence: 1 }),
    { ok: true, state: 'forwarded' },
  );
  await waitFor(() => assistant.some((event) => event.assistantMessageId === 'steer-answer-1'), 'первый ответ');
  assert.deepEqual(
    await port.deliver({ messageId: 'message-fixture-0002', text: 'Второй вопрос', sequence: 2 }),
    { ok: true, state: 'forwarded' },
  );
  await waitFor(() => assistant.some((event) => event.assistantMessageId === 'steer-answer-2'), 'второй ответ');

  await run;

  const trace = await readTrace(f.trace);
  const steers = trace
    .filter((entry) => entry.message?.method === 'turn/steer')
    .map((entry) => entry.message.params.clientUserMessageId);

  assert.deepEqual(steers, ['message-fixture-0001', 'message-fixture-0002']);
  assert.equal(
    trace.filter((entry) => entry.message?.method === 'turn/start').length,
    1,
    'второго запуска хода нет',
  );
});

test('Codex: видимый комментарий связывает шаг и блок общим id', async (t) => {
  const f = await fixture(t);
  const steps = [];
  let port = null;
  let releasePort;

  const portReady = new Promise((resolve) => {
    releasePort = resolve;
  });
  const run = codex.run(runOptions(f, {
    onStep(step) {
      steps.push(step);
    },
    onInTurnReady(given) {
      port = given;
      releasePort();
    },
  }));

  await portReady;
  const textStep = await waitFor(
    () => steps.find((step) => step.k === 'text' && step.text.includes('Сначала проверяю')),
    'текстовый шаг комментария',
  );

  assert.equal(textStep.id, 'commentary-before-steer');

  await port.deliver({ messageId: 'message-fixture-0001', text: 'Вопрос', sequence: 1 });
  await run;
});

test('Codex: итоговый ответ завершает свой блок и связывается с финалом хода', async (t) => {
  const f = await fixture(t, 'rich');
  const assistant = [];
  const result = await codex.run(runOptions(f, {
    onAssistantMessage(event) {
      assistant.push(event);
    },
  }));
  const final = assistant.filter((event) => event.assistantMessageId === 'answer-1');

  assert.equal(final.at(-1).complete, true, 'итоговый ответ не остаётся черновиком «Пишет…»');
  assert.equal(final.at(-1).text, result.reply);
  assert.equal(final.filter((event) => event.complete).length, 1);
  assert.equal(result.assistantMessageId, 'answer-1');
});

test('Codex: обрыв потока с повтором бросает начатую реплику', async (t) => {
  const f = await fixture(t, 'stream-retry');
  const assistant = [];
  const result = await codex.run(runOptions(f, {
    onAssistantMessage(event) {
      assistant.push(event);
    },
  }));
  const cut = assistant.filter((event) => event.assistantMessageId === 'answer-cut');
  const retry = assistant.filter((event) => event.assistantMessageId === 'answer-retry');

  assert.equal(cut.at(-1).abandoned, true, 'повтор начинает ответ заново, старый текст не допишется');
  assert.equal(cut.at(-1).text, 'Ответ до обр');
  assert.equal(cut.some((event) => event.complete), false);
  assert.equal(retry.at(-1).complete, true);
  assert.equal(result.reply, 'Ответ после повтора.');
  assert.equal(result.assistantMessageId, 'answer-retry');
});

test('Codex: картинка уточнения уходит в тот же ход как localImage', async (t) => {
  const f = await fixture(t, 'steer');
  let port = null;
  let releasePort;

  const portReady = new Promise((resolve) => {
    releasePort = resolve;
  });
  const run = codex.run(runOptions(f, {
    onInTurnReady(given) {
      port = given;
      releasePort();
    },
  }));

  await portReady;

  const forwarded = await port.deliver({
    messageId: 'message-fixture-0001',
    text: 'Сравни с референсом',
    sequence: 1,
    images: [{ path: '/tmp/reference.png' }],
  });

  assert.deepEqual(forwarded, { ok: true, state: 'forwarded' });
  await run;

  const trace = await readTrace(f.trace);
  const steer = trace.find((entry) => entry.message?.method === 'turn/steer').message;

  assert.equal(steer.params.input[0].text, 'Сравни с референсом');
  assert.deepEqual(
    steer.params.input.filter((part) => part.type === 'localImage'),
    [{ type: 'localImage', path: '/tmp/reference.png' }],
  );
  assert.match(steer.params.input.at(-1).text, /вернись к ранее поставленной задаче/);
  assert.equal(codex.inTurnInput.images, true, 'адаптер объявляет картинки в ходе');
});
