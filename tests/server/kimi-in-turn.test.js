import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import kimi from '../../server/src/lib/executors/kimi.ts';
import { startKimiServer } from '../../server/src/lib/kimi/serverRuntime.ts';
import { assertInTurnConformance } from './helpers/in-turn-conformance.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE = path.join(ROOT, 'tests/fixtures/kimi-server/fake-kimi-turn.mjs');

/**
 * Фикстура запускает настоящий адаптер с серверным протоколом Kimi.
 * Дом и переписка синтетические; shell-обёртка оставляет импорт Fastify у фикстуры.
 */
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cockpit-kimi-adapter-'));
  const bin = path.join(dir, 'kimi-fixture');
  const home = path.join(dir, 'home');
  const chatsDir = path.join(dir, 'chats');

  await mkdir(path.join(home, 'credentials'), { recursive: true });
  await mkdir(chatsDir, { recursive: true });
  await writeFile(path.join(home, 'credentials/kimi-code.json'), '{}', { mode: 0o600 });
  await writeFile(path.join(home, 'fixture-trace.jsonl'), '');
  await writeFile(bin, `#!/bin/sh\nexec ${process.execPath} ${FIXTURE} "$@"\n`, 'utf8');
  await chmod(bin, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));

  return {
    dir,
    home,
    config: {
      kimiBin: bin,
      kimiHome: home,
      kimiRuntimeHome: path.join(dir, 'runtime'),
      kimiLaunchMode: 'host',
      chatsDir,
    },
  };
}

/**
 * Дожидаемся наблюдаемого события от сервера фикстуры.
 * Короткая пауза служит только сторожем, порядок задаёт сама фикстура.
 */
async function waitFor(check, label) {
  const deadline = Date.now() + 5000;

  while (Date.now() < deadline) {
    const result = check();

    if (result) {
      return result;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`не дождались: ${label}`);
}

test('Kimi adapter передаёт уточнение текущему серверному ходу и продолжает работу', async (t) => {
  const f = await fixture(t);
  const blocks = [];
  let port = null;
  let settled = false;

  const turn = kimi.run({
    config: f.config,
    cwd: f.dir,
    chatKey: 'fixture-chat',
    message: 'Проверь два файла.',
    model: 'kimi-code/k3',
    permissionMode: 'default',
    providerSettings: { blockDirectSsh: false },
    onAssistantMessage: (event) => blocks.push(event),
    onInTurnReady: (given) => {
      port = given;
    },
  }).finally(() => { settled = true; });

  await waitFor(() => port, 'порт уточнения');

  const receipt = await port.deliver({
    messageId: 'message-fixture-0001',
    text: 'Почему начал с первого файла?',
    sequence: 1,
  });

  assert.deepEqual(receipt, { ok: true, state: 'forwarded' });
  await waitFor(
    () => blocks.some((block) => block.complete && block.assistantMessageId === 'assistant-steer'),
    'ответ до финала',
  );
  const answerBeforeFinal = !settled;

  const result = await turn;
  const trace = (await readFile(path.join(f.home, 'fixture-trace.jsonl'), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line));

  assert.equal(result.reply, 'Второй файл проверен.');
  assert.deepEqual(trace.map((entry) => entry.kind), ['prompt', 'prompt', 'steer']);
  assert.equal(kimi.inTurnInput.protocol, 1);
  const late = await port.deliver({
    messageId: 'message-fixture-0002', text: 'Поздний вопрос', sequence: 2,
  });
  assertInTurnConformance({
    name: 'Kimi', capability: kimi.inTurnInput,
    turns: 1,
    steers: trace.filter((entry) => entry.kind === 'steer').length,
    cancels: trace.filter((entry) => entry.kind === 'cancel').length,
    forwarded: receipt.ok,
    answerBeforeFinal,
    answerCopies: blocks.filter((block) => block.complete
      && block.assistantMessageId === 'assistant-steer').length,
    finalReply: result.reply,
    lateRejected: late.ok === false,
  });
});

test('Kimi adapter сохраняет порядок двух уточнений в одном запуске', async (t) => {
  const f = await fixture(t);
  const blocks = [];
  let port;
  const turn = kimi.run({
    config: f.config,
    cwd: f.dir,
    chatKey: 'fixture-chat',
    message: 'Проверь два файла.',
    model: 'kimi-code/k3',
    permissionMode: 'default',
    providerSettings: { blockDirectSsh: false },
    env: { ...process.env, COCKPIT_KIMI_FIXTURE_STEERS: '2' },
    onAssistantMessage: (event) => blocks.push(event),
    onInTurnReady: (given) => { port = given; },
  });
  await waitFor(() => port, 'порт уточнения');
  assert.equal((await port.deliver({
    messageId: 'message-fixture-0001', text: 'Первый вопрос', sequence: 1,
  })).ok, true);
  await waitFor(() => blocks.some((block) => block.complete
    && block.assistantMessageId === 'assistant-steer-1'), 'первый ответ');
  assert.equal((await port.deliver({
    messageId: 'message-fixture-0002', text: 'Второй вопрос', sequence: 2,
  })).ok, true);
  await waitFor(() => blocks.some((block) => block.complete
    && block.assistantMessageId === 'assistant-steer-2'), 'второй ответ');
  assert.equal((await turn).reply, 'Второй файл проверен.');
  const trace = (await readFile(path.join(f.home, 'fixture-trace.jsonl'), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(trace.map((entry) => entry.kind), [
    'prompt', 'prompt', 'steer', 'prompt', 'steer',
  ]);
  assert.deepEqual(trace.filter((entry) => entry.kind === 'prompt').map((entry) => entry.text), [
    'Проверь два файла.', 'Первый вопрос', 'Второй вопрос',
  ]);
});

test('Kimi adapter проводит разрешение через всплывашку и возвращает серверный вердикт', async (t) => {
  const f = await fixture(t);
  const asks = [];

  await kimi.run({
    config: f.config,
    cwd: f.dir,
    chatKey: 'fixture-chat',
    message: 'Задача с риском',
    model: 'kimi-code/k3',
    permissionMode: 'default',
    providerSettings: { blockDirectSsh: false },
    env: { ...process.env, COCKPIT_KIMI_FIXTURE_APPROVAL: '1' },
    onPermission: async (ask) => {
      asks.push(ask);

      return { allow: true };
    },
  });

  const trace = (await readFile(path.join(f.home, 'fixture-trace.jsonl'), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line));

  assert.equal(asks.length, 1);
  assert.equal(asks[0].tool, 'Bash');
  assert.equal(trace.find((entry) => entry.kind === 'approval')?.decision, 'approved');
});

test('Kimi contained строит серверный запуск внутри прежней песочницы и убирает unit', async (t) => {
  const f = await fixture(t);
  const launches = [];
  const stoppedUnits = [];
  let mcpConfig = null;

  await kimi.run({
    config: {
      ...f.config,
      kimiLaunchMode: 'contained',
      kimiRuntimeHome: path.join(f.dir, 'runtime'),
    },
    cwd: f.dir,
    chatKey: 'fixture-contained-chat',
    message: 'Короткая задача',
    model: 'kimi-code/k3',
    mcpServers: [{
      name: 'fixture-tool',
      command: '/bin/true',
      args: ['--safe'],
    }],
    deps: {
      assertVersion: async () => {},
      createProxy: () => ({ start: async () => {}, close: async () => {} }),
      preflight: async () => ({ decision: 'GO_CONTAINED_MVP', checks: [] }),
      buildLaunch: async (input) => {
        mcpConfig = JSON.parse(await readFile(input.serverMcpFile, 'utf8'));

        return {
          command: 'sandbox-fixture',
          args: ['web'],
          unit: 'cockpit-kimi-fixture.service',
          cwdReal: f.dir,
        };
      },
      startServer: async (input) => {
        launches.push(input);

        return startKimiServer({
          bin: f.config.kimiBin,
          home: f.home,
          cwd: f.dir,
        });
      },
      stopUnit: async (unit) => {
        stoppedUnits.push(unit);
      },
    },
  });

  assert.deepEqual(mcpConfig, {
    mcpServers: { 'fixture-tool': { command: '/bin/true', args: ['--safe'] } },
  });
  assert.equal(launches.length, 1);
  assert.equal(launches[0].launch.command, 'sandbox-fixture');
  assert.match(launches[0].socketPath, /\/c\/s$/);
  assert.deepEqual(stoppedUnits, ['cockpit-kimi-fixture.service']);
});
