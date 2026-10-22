// Драйвер хода Kimi: prompt, события, уточнение в активный ход и продолжение задачи.
//
// Фикстура-сервер ведёт себя как настоящий: основной prompt запускает ход, уточнение
// приходит через `prompts:steer`, ответ виден до финала, после финала ход закрывается.
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { kimiUsageWire } from '../helpers/kimiUsageWire.mjs';

import { runKimiServerTurn } from '../../server/src/lib/kimi/serverTurn.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE = path.join(ROOT, 'tests/fixtures/kimi-server/fake-kimi-turn.mjs');

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-kimi-turn-'));
  const bin = path.join(dir, 'kimi-turn-fixture');

  // Обёртка, а не копия: фикстура ищет fastify относительно своего настоящего пути.
  await writeFile(bin, `#!/bin/sh\nexec ${process.execPath} ${FIXTURE} "$@"\n`, 'utf8');
  await chmod(bin, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));

  return { dir, bin, home: path.join(dir, 'home') };
}

async function readTrace(home) {
  let raw = '';

  try {
    raw = await readFile(path.join(home, 'fixture-trace.jsonl'), 'utf8');
  } catch {
    return [];
  }

  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/** Ожидание условия короткими паузами: настоящие задержки в тесте не нужны. */
async function waitFor(check, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const value = await check();

    if (value) {
      return value;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`не дождались: ${what}`);
}

test('Kimi: уточнение уходит в активный ход, ответ виден до финала, задача продолжается', async (t) => {
  const f = await fixture(t);
  const blocks = [];
  const steps = [];
  let port = null;
  let availability = null;

  const turn = runKimiServerTurn({
    bin: f.bin,
    home: f.home,
    cwd: f.dir,
    message: 'Проверь два файла.',
    onStep: (step) => steps.push(step),
    onAssistantMessage: (event) => blocks.push(event),
    onInTurnReady: (given) => {
      port = given;
    },
    onInTurnAvailability: (status) => {
      availability = status;
    },
  });

  await waitFor(() => port, 'готовый порт уточнений');
  assert.deepEqual(availability, { available: true });

  const delivered = await port.deliver({
    messageId: 'message-fixture-0001',
    text: 'Почему начал с первого файла?',
    sequence: 1,
  });

  assert.deepEqual(delivered, { ok: true, state: 'forwarded' });

  const answer = await waitFor(
    () => blocks.find((event) => event.complete && event.assistantMessageId === 'assistant-steer'),
    'завершённый ответ на уточнение',
  );

  assert.equal(answer.text, 'Отвечаю: Почему начал с первого файла?');

  const result = await turn;

  assert.equal(result.reply, 'Второй файл проверен.');
  assert.equal(result.sessionId, 'session-fixture-0001');
  assert.ok(
    steps.some((step) => step.k === 'text' && step.id === 'assistant-main' && step.text.includes('Начинаю проверку')),
    'шаг основного хода несёт id блока',
  );

  const trace = await readTrace(f.home);

  assert.deepEqual(
    trace.map((entry) => entry.kind),
    ['prompt', 'prompt', 'steer'],
    'основной prompt, prompt уточнения и steer',
  );
  assert.equal(trace[2].promptIds.length, 1);
});

test('Kimi: поток отдаёт рассуждение и расход контекста', async (t) => {
  const f = await fixture(t);
  const steps = [];
  const progress = [];

  const turn = runKimiServerTurn({
    bin: f.bin,
    home: f.home,
    cwd: f.dir,
    message: 'Задача с рассуждением',
    onStep: (step) => steps.push(step),
    onProgress: (tokens, info) => progress.push({ tokens, info }),
  });

  await waitFor(() => progress.length > 0, 'замер контекста');

  assert.equal(progress[0].info.contextTokens, 12_345);
  assert.equal(progress[0].info.contextWindow, 262_144);
  assert.equal(progress[0].info.contextMetric, 'kimi-active-input-v1');
  assert.ok(steps.some((step) => step.k === 'text' && step.id === 'assistant-main'));

  await turn;
  assert.ok(steps.some((step) => step.k === 'think' && step.text.includes('Сверяю порядок')));
});

test('Kimi: спрос человека закрывает канал до ответа и открывает после', async (t) => {
  const f = await fixture(t);
  const statuses = [];
  const approvals = [];
  let port = null;
  let respondApproval = null;

  const turn = runKimiServerTurn({
    bin: f.bin,
    home: f.home,
    cwd: f.dir,
    message: 'Задача с риском',
    env: { ...process.env, GRIGDESK_KIMI_FIXTURE_APPROVAL: '1' },
    onInTurnReady: (given) => {
      port = given;
    },
    onInTurnAvailability: (status) => statuses.push(status),
    onApproval: (approval, respond) => {
      approvals.push(approval);
      respondApproval = respond;
    },
  });

  await waitFor(() => approvals.length > 0, 'запрос разрешения');
  assert.equal(approvals[0].tool_name, 'Bash');
  await waitFor(
    () => statuses.some((status) => status.reason === 'awaiting_answer'),
    'закрытие канала на время спроса',
  );

  // Уточнение в этот момент не принимается: это был бы ответ на спрос, а не вопрос о работе.
  const refused = await port.deliver({ messageId: 'message-fixture-0001', text: 'да', sequence: 1 });

  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'awaiting_answer');

  await respondApproval({ decision: 'approve', scope: 'once' });
  await turn;
  assert.ok(statuses.some((status) => status.available === true), 'канал открывался после ответа');
  assert.equal(statuses.at(-1)?.available, false, 'после финала канал закрыт');

  const trace = await readTrace(f.home);
  assert.ok(trace.some((entry) => entry.kind === 'approval'), 'ответ на разрешение дошёл до сервера');
});

test('Kimi: ход без уточнения завершается своим ответом', async (t) => {
  const f = await fixture(t);
  const blocks = [];

  const turn = runKimiServerTurn({
    bin: f.bin,
    home: f.home,
    cwd: f.dir,
    message: 'Короткая задача',
    onAssistantMessage: (event) => blocks.push(event),
  });

  await waitFor(() => blocks.some((event) => event.assistantMessageId === 'assistant-main' && event.complete), 'ответ хода');

  const result = await turn;

  assert.equal(result.reply, 'Проверка завершена.');
  assert.ok(result.steps.length > 0);

  const trace = await readTrace(f.home);

  assert.deepEqual(trace.map((entry) => entry.kind), ['prompt'], 'лишних prompt и steer нет');
});

test('Kimi: реальные границы шага сохраняют текст и rich diff', async (t) => {
  const f = await fixture(t);
  const blocks = [];
  let port = null;

  const turn = runKimiServerTurn({
    bin: f.bin,
    home: f.home,
    cwd: f.dir,
    message: 'Проверь два файла.',
    env: { ...process.env, GRIGDESK_KIMI_FIXTURE_REAL_WIRE: '1' },
    onAssistantMessage: (event) => blocks.push(event),
    onInTurnReady: (given) => {
      port = given;
    },
  });

  await waitFor(() => port, 'порт уточнения');
  await port.deliver({
    messageId: 'message-fixture-0002',
    text: 'Почему первый файл?',
    sequence: 2,
  });

  const result = await turn;
  const complete = blocks.filter((block) => block.complete);
  const edit = result.steps.find((step) => step.k === 'tool' && step.id === 'tool-edit-1');

  assert.equal(result.reply, 'Второй файл проверен.');
  assert.equal(complete.length, 3);
  assert.equal(complete[1].text, 'Отвечаю: Почему первый файл?');
  assert.deepEqual(edit.changes, [{
    path: 'first.txt',
    kind: 'update',
    diff: { old: 'старое', new: 'новое' },
  }]);
  assert.ok(result.steps.some((step) => step.k === 'res' && step.id === 'tool-edit-1'));
});


test('Kimi: шаги основного агента заменяют вклад и не смешиваются с прошлым ходом', async (t) => {
  const wire = await kimiUsageWire(t, [async (send) => {
    send({ type: 'turn.started', turnId: 1 });
    send({
      type: 'turn.step.started',
      turnId: 1,
      step: 1
    });
    send({ type: 'assistant.delta', delta: 'Первый ответ' });
    send({
      type: 'turn.step.completed',
      turnId: 1,
      step: 1,
      stepId: 'a',
      usage: { output: 42 }
    });
    send({
      type: 'turn.step.completed',
      turnId: 1,
      step: 1,
      stepId: 'a',
      usage: { output: 42 }
    });
    send({ type: 'session.usage_updated', usage: { output_tokens: 1000, context_tokens: 900 } });
    send({
      type: 'turn.started',
      agentId: 'sub-1',
      turnId: 99
    });
    send({
      type: 'turn.step.started',
      agentId: 'sub-1',
      turnId: 99,
      step: 1
    });
    send({
      type: 'turn.step.completed',
      agentId: 'sub-1',
      stepId: 'sub',
      usage: { output: 999 }
    });
    send({
      type: 'turn.ended',
      agentId: 'sub-1',
      reason: 'completed'
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    send({ type: 'turn.started', turnId: 2 });
    send({
      type: 'turn.step.started',
      turnId: 2,
      step: 1
    });
    send({ type: 'assistant.delta', delta: 'Последний ответ' });
    send({
      type: 'turn.step.completed',
      turnId: 2,
      step: 1,
      usage: { output: 58 }
    });
    send({
      type: 'turn.step.completed',
      turnId: 2,
      step: 1,
      usage: { output: 58 }
    });
    send({ type: 'turn.ended', reason: 'completed' });
  }, (send) => {
    send({ type: 'turn.started', turnId: 3 });
    send({
      type: 'turn.step.completed',
      turnId: 3,
      step: 1,
      usage: { output: 7 }
    });
    send({ type: 'turn.ended', reason: 'completed' });
  }]);
  const progress = [];
  const base = {
    bin: '/bin/true',
    home: '/tmp',
    message: 'Синтетический ход',
    startServer: wire.startServer,
    onProgress: (tokens, info) => progress.push({ tokens, ...info }),
  };
  const first = await runKimiServerTurn(base);

  assert.equal(first.reply, 'Последний ответ');
  assert.deepEqual(progress.map((item) => item.tokens), [42, 42, 42, 100, 100]);
  assert.ok(progress.every((item) => item.tokensIsEstimate === false));

  progress.length = 0;
  await runKimiServerTurn({ ...base, sessionId: first.sessionId });
  assert.deepEqual(progress.map((item) => item.tokens), [7]);
});


test('Kimi: частичные статусы основного агента сохраняют окно и уменьшение контекста', async (t) => {
  const wire = await kimiUsageWire(t, [(send) => {
    send({
      type: 'turn.step.completed',
      turnId: 1,
      step: 1,
      usage: { output: 42 }
    });
    send({ type: 'agent.status.updated', maxContextTokens: 262144 });
    send({ type: 'agent.status.updated', contextTokens: 12345 });
    send({ type: 'agent.status.updated', usage: { currentTurn: { output: 42 } } });
    send({ type: 'agent.status.updated', planMode: true });
    send({ type: 'agent.status.updated', swarmMode: true });
    send({ type: 'agent.status.updated', model: 'fixture' });
    send({
      type: 'agent.status.updated',
      agentId: 'sub-1',
      contextTokens: 99999,
      maxContextTokens: 100000
    });
    send({ type: 'agent.status.updated', contextTokens: 6000 });
    send({ type: 'agent.status.updated', contextTokens: 0 });
    send({ type: 'turn.ended', reason: 'completed' });
  }]);
  const progress = [];
  const result = await runKimiServerTurn({
    bin: '/bin/true',
    home: '/tmp',
    message: 'Контекст',
    ...wire,
    onProgress: (tokens, info) => progress.push({ tokens, ...info }),
  });
  const samples = progress.filter((item) => item.contextTokens !== undefined);

  assert.deepEqual(samples.map((item) => item.contextTokens), [12345, 6000, 0]);
  assert.ok(samples.every((item) => item.contextWindow === 262144));
  assert.ok(samples.every((item) => item.tokens === 42 && item.tokensIsEstimate === false));
  assert.ok(samples.every((item) => !Object.hasOwn(item, 'contextIsEstimate')));
  assert.equal(result.contextTokens, 0);
  assert.equal(result.contextWindow, 262144);
  assert.equal(result.contextMetric, 'kimi-agent-status-v1');
});

test('Kimi: служебный статус без контекста не создаёт нулевой замер', async (t) => {
  const wire = await kimiUsageWire(t, [(send) => {
    send({ type: 'agent.status.updated' });
    send({ type: 'agent.status.updated', contextTokens: null });
    send({
      type: 'agent.status.updated',
      usage: {},
      planMode: true
    });
    send({ type: 'turn.ended', reason: 'completed' });
  }]);
  const progress = [];
  const result = await runKimiServerTurn({
    bin: '/bin/true',
    home: '/tmp',
    message: 'Без замера',
    ...wire,
    onProgress: (tokens, info) => progress.push({ tokens, ...info }),
  });

  assert.deepEqual(progress, []);
  assert.equal(Object.hasOwn(result, 'contextTokens'), false);
});
