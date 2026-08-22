// Проверяет совместимость адаптера Codex с протоколом app-server и нормализацию шагов.
import assert from 'node:assert/strict';
import {
  chmod, copyFile, mkdtemp, readFile, rm,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createStepSink } from '../../server/src/lib/chat/stream-steps.js';
import { createCodexStepNormalizer } from '../../server/src/lib/executors/_codex-steps.js';
import codex from '../../server/src/lib/executors/codex.js';
import { CODEX_APP_SERVER_COMPATIBILITY } from '../fixtures/codex-app-server/rich-turn-0.149.0.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE = path.join(ROOT, 'tests/fixtures/codex-app-server/rich-turn-0.149.0.mjs');
const EXPECTED_CHANGES = [
  {
    path: 'src/answer.js',
    kind: 'update',
    diff: '@@ -1 +1 @@\n-export const answer = 41;\n+export const answer = 42;\n',
  },
  {
    path: 'src/ready.js',
    kind: 'add',
    diff: '@@ -0,0 +1,2 @@\n+export function ready() {\n+  return true;\n+}\n',
  },
];

async function fixture(t, scenario = 'rich') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cockpit-codex-app-server-'));
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
      COCKPIT_CODEX_FIXTURE_TRACE: trace,
      COCKPIT_CODEX_FIXTURE_SCENARIO: scenario,
    },
  };
}

async function readTrace(file) {
  let raw = '';
  try { raw = await readFile(file, 'utf8'); } catch { return []; }
  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function waitForClientMethod(file, method, timeoutMs = 1_500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const trace = await readTrace(file);
    const found = trace.find((entry) => entry.direction === 'client' && entry.message?.method === method);
    if (found) return found.message;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`fixture не дождался JSON-RPC метода ${method}`);
}

function runOptions(f, overrides = {}) {
  return {
    config: { codexBin: f.bin },
    env: f.env,
    message: 'Исправь два файла.',
    cwd: f.dir,
    extraDirs: [path.join(f.dir, 'shared')],
    model: 'gpt-contract-0.149',
    effort: 'medium',
    sessionId: null,
    compactWindow: 120_000,
    tokenInfoReader: async () => null,
    ...overrides,
  };
}

test('fixture закреплён на официальной схеме Codex app-server 0.149.0', () => {
  assert.deepEqual(CODEX_APP_SERVER_COMPATIBILITY, {
    cli: 'codex-cli 0.149.0',
    protocol: 'app-server-v2',
    transport: 'stdio-jsonl',
    schemaSource: 'codex app-server generate-ts',
  });
});

test('Codex run использует app-server и не теряет rich events, steps и resume sessionId', async (t) => {
  const f = await fixture(t);
  const live = [];
  const first = await codex.run(runOptions(f, { onStep: (step) => live.push(step) }));

  assert.equal(first.reply, 'Готово: изменения сохранены.');
  assert.equal(first.sessionId, '00000000-0000-7000-8000-000000000049');
  assert.equal(first.actualModel, 'gpt-contract-0.149');
  assert.deepEqual(first.steps, live, 'в результате сохраняются ровно показанные live-шаги');

  const commentary = first.steps.find((step) => step.k === 'text');
  assert.equal(commentary?.text, 'Проверяю файлы перед правкой.');

  const plan = first.steps.find((step) => step.k === 'note'
    && step.text?.includes('Проверить текущее состояние'));
  assert.match(plan?.text || '', /Исправить два файла/);

  const command = first.steps.find((step) => step.k === 'tool' && step.id === 'command-1');
  assert.equal(command?.name, 'Bash');
  assert.equal(command?.command, 'git status --short');
  const commandResult = first.steps.find((step) => step.k === 'res' && step.id === 'command-1');
  assert.equal(commandResult?.ok, true);
  assert.equal(commandResult?.text, ' M src/answer.js\n?? src/ready.js\n');

  const edit = first.steps.find((step) => step.k === 'tool' && step.id === 'file-change-1');
  assert.equal(first.steps.filter((step) => step.k === 'tool' && step.id === 'file-change-1').length, 1);
  assert.deepEqual(edit?.files, ['src/answer.js', 'src/ready.js']);
  assert.deepEqual(edit?.changes, EXPECTED_CHANGES);

  const second = await codex.run(runOptions(f, {
    message: 'Продолжи в той же сессии.',
    sessionId: first.sessionId,
  }));
  assert.equal(second.reply, 'Готово: продолжение сохранено.');
  assert.equal(second.sessionId, first.sessionId);
  assert.ok(second.steps.length > 0, 'шаги resume-хода тоже сохраняются в ответе executor-а');

  const client = (await readTrace(f.trace))
    .filter((entry) => entry.direction === 'client')
    .map((entry) => entry.message);
  const lifecycle = client
    .filter((message) => [
      'initialize', 'initialized', 'thread/start', 'thread/resume', 'turn/start',
    ].includes(message.method))
    .map((message) => message.method);
  assert.deepEqual(lifecycle, [
    'initialize', 'initialized', 'thread/start', 'turn/start',
    'initialize', 'initialized', 'thread/resume', 'turn/start',
  ]);
  assert.ok(
    client.filter((message) => message.method === 'initialized')
      .every((message) => Object.keys(message).length === 1),
    'ClientNotification 0.149 — ровно { method: "initialized" }, без params',
  );

  const start = client.find((message) => message.method === 'thread/start');
  assert.equal(start.params.cwd, f.dir);
  assert.equal(start.params.model, 'gpt-contract-0.149');
  assert.equal(start.params.sandbox, 'workspace-write');
  assert.equal(start.params.approvalPolicy, 'never');
  assert.equal(start.params.config?.sandbox_workspace_write?.network_access, true);
  assert.equal(start.params.config?.model_auto_compact_token_limit, 120_000);

  const resume = client.find((message) => message.method === 'thread/resume');
  assert.equal(resume.params.threadId, first.sessionId);
  assert.equal(resume.params.cwd, f.dir);
  assert.equal(resume.params.sandbox, 'workspace-write');
  assert.equal(resume.params.approvalPolicy, 'never');

  const turns = client.filter((message) => message.method === 'turn/start');
  assert.deepEqual(turns.map((message) => message.params.input[0].text), [
    'Исправь два файла.',
    'Продолжи в той же сессии.',
  ]);
  assert.ok(turns.every((message) => (
    Array.isArray(message.params.input[0].text_elements)
    && message.params.input[0].text_elements.length === 0
  )));
  assert.ok(turns.every((message) => message.params.effort === 'medium'));
  assert.ok(turns.every((message) => message.params.summary === 'detailed'));
  for (const turn of turns) {
    assert.deepEqual(turn.params.sandboxPolicy, {
      type: 'workspaceWrite',
      writableRoots: [f.dir, path.join(f.dir, 'shared')],
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
  }
});

test('AbortSignal прерывает app-server ход через turn/interrupt и сохраняет sessionId со steps', async (t) => {
  const f = await fixture(t, 'interrupt');
  const controller = new AbortController();
  let outcome;
  const running = codex.run(runOptions(f, { signal: controller.signal }))
    .then((value) => { outcome = { value }; }, (error) => { outcome = { error }; });

  await waitForClientMethod(f.trace, 'turn/start');
  controller.abort();
  await running;

  assert.equal(outcome?.value, undefined, 'остановленный ход не считается успешным ответом');
  assert.equal(outcome?.error?.stopped, true);
  assert.equal(outcome?.error?.message, 'Ход остановлен.');
  assert.equal(outcome?.error?.sessionId, '00000000-0000-7000-8000-000000000049');
  assert.ok(outcome?.error?.steps?.some((step) => (
    step.k === 'tool' && step.id === 'long-command-1' && step.command === 'node long-task.mjs'
  )), 'накопленная до остановки лента сохраняется в ошибке');

  const interrupt = await waitForClientMethod(f.trace, 'turn/interrupt');
  assert.equal(typeof interrupt.id, 'number');
  assert.deepEqual(interrupt.params, {
    threadId: '00000000-0000-7000-8000-000000000049',
    turnId: '00000000-0000-7000-8000-00000000004a',
  });
});

test('Codex ограничивает один multi-file tool двадцатью файлами и 16 КБ diff', () => {
  const sent = [];
  const sink = createStepSink((step) => sent.push(step), { now: () => 149 });
  const normalize = createCodexStepNormalizer();
  const changes = Array.from({ length: 27 }, (_, index) => ({
    path: `src/generated/file-${String(index).padStart(2, '0')}.js`,
    kind: { type: index === 0 ? 'add' : 'update', move_path: null },
    diff: [
      `diff --git a/src/generated/file-${index}.js b/src/generated/file-${index}.js`,
      '@@ -1,3 +1,3 @@',
      `-${'old'.repeat(500)}`,
      `+${'new'.repeat(500)}`,
    ].join('\n'),
  }));

  sink.emitAll(normalize({ method: 'item/started', params: {
    item: { type: 'fileChange', id: 'bounded-change', changes: [], status: 'inProgress' },
  } }));
  sink.emitAll(normalize({ method: 'item/fileChange/patchUpdated', params: {
    itemId: 'bounded-change', changes,
  } }));
  sink.emitAll(normalize({ method: 'item/completed', params: {
    item: { type: 'fileChange', id: 'bounded-change', changes, status: 'completed' },
  } }));

  const tools = sink.steps.filter((step) => step.k === 'tool' && step.id === 'bounded-change');
  assert.equal(tools.length, 1, 'на весь lifecycle остаётся один append-only tool');
  assert.equal(tools[0].changes.length, 20);
  assert.equal(tools[0].files.length, 20);
  assert.equal(tools[0].omittedChanges, 7);
  assert.match(tools[0].preview, /ещё 7 файлов/);
  assert.ok(
    Buffer.byteLength(tools[0].changes.map((change) => change.diff).join(''), 'utf8') <= 16 * 1024,
    'суммарный diff-text одного tool не превышает 16 КБ',
  );
  assert.ok(
    tools[0].changes.every((change) => (
      change.diff.includes('-old') && change.diff.includes('+new')
    )),
    'сбалансированное сокращение сохраняет начало и добавленную сторону diff',
  );
  assert.deepEqual(sink.steps, sent, 'SSE и сохранённая история видят один и тот же bounded step');
});
