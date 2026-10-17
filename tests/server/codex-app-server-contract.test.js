// Проверяет совместимость адаптера Codex с протоколом app-server и нормализацию шагов.
import assert from 'node:assert/strict';
import {
  chmod, copyFile, mkdir, mkdtemp, readFile, rm,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createStepSink } from '../../server/src/lib/chat/streamSteps.ts';
import { classifyTurnFailure } from '../../server/src/lib/chat/turnFailures.ts';
import { createCodexStepNormalizer } from '../../server/src/lib/executors/_codexSteps.ts';
import { CODEX_TURN_FAILURE_RULES } from '../../server/src/lib/executors/_codexTurnFailures.ts';
import codex from '../../server/src/lib/executors/codex.ts';
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
    // Содержимое созданного файла нормализатор разворачивает в patch.
    diff: '@@ -0,0 +1,3 @@\n+export function ready() {\n+  return true;\n+}\n',
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
      COCKPIT_CODEX_FIXTURE_EXPECT_HOOK: '1',
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
    providerSettings: {},
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

test('Codex передаёт контекст до конца хода и сохраняет последний замер после остановки', async (t) => {
  for (const stopped of [false, true]) {
    const f = await fixture(t, stopped ? 'context-interrupt' : 'context-usage');
    const controller = new AbortController();
    const samples = [];
    const run = codex.run(runOptions(f, {
      signal: controller.signal,
      onProgress(_tokens, info) {
        if (!info) return;
        samples.push(info);
        if (stopped && info.contextTokens === 60_000) controller.abort();
      },
    }));
    const result = stopped ? await run.catch((error) => error) : await run;

    assert.deepEqual(samples.map((sample) => sample.contextTokens), [180_000, 60_000]);
    assert.ok(samples.every((sample) => sample.contextWindow === 256_000));
    assert.ok(samples.every((sample) => sample.contextMetric === 'active-input-v1'));
    assert.equal(result.contextTokens, 60_000);
    assert.equal(result.contextWindow, 256_000);
    assert.equal(result.contextMetric, 'active-input-v1');
    assert.equal(result.contextCache.readTokens, 59_000);
    assert.equal(result.stopped === true, stopped);
  }
});

test('Codex считает расход ХОДА приростом накопителя потока, а не замером последнего запроса', async (t) => {
  const f = await fixture(t, 'token-progress');
  const spent = [];
  const result = await codex.run(runOptions(f, {
    onProgress(value) { spent.push(value); },
  }));

  // Накопитель потока 100 → 350: расход хода растёт и не прыгает на `last` (50, 40).
  // Первый замер сессии сеет базу: 100 − 50 = 50 токенов накопитель нёс ДО этого хода
  // (история возобновлённого thread), они не расход хода — поэтому 50 и 300, а не 100 и 350.
  // 300, а не 420: рассуждения уже входят в outputTokens — отдельным слагаемым они
  // удваивали расход.
  assert.deepEqual([...new Set(spent)], [50, 300], 'счётчик хода взят не из накопителя');
  assert.equal(result.reply, 'Расход хода посчитан.');
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

  // `runtimeWorkspaceRoots` живёт за experimentalApi: без объявленной capability
  // app-server отвечает «requires experimentalApi capability». `requestAttestation`
  // обязан оставаться false — он включает server request, который кокпит завершает
  // fail-closed, то есть ход упал бы на ровном месте.
  for (const init of client.filter((message) => message.method === 'initialize')) {
    assert.deepEqual(init.params.capabilities, {
      experimentalApi: true,
      requestAttestation: false,
      mcpServerOpenaiFormElicitation: true,
    });
  }

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

  // Доверенные каталоги «Настройки → Исполнители» — рабочая область агента, а не
  // только writable-песочница: `codex exec --add-dir` давал именно это, и без явного
  // поля app-server сужает рабочие корни до одного cwd.
  for (const opened of [start, resume]) {
    assert.deepEqual(opened.params.runtimeWorkspaceRoots, [f.dir, path.join(f.dir, 'shared')]);
  }

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

test('Codex разделяет читаемые и writable roots триажа и выключает сеть', async (t) => {
  const f = await fixture(t);
  const repo = path.join(f.dir, 'repo');
  const input = path.join(f.dir, 'input');
  const output = path.join(f.dir, 'output');
  await Promise.all([mkdir(repo), mkdir(input), mkdir(output)]);

  await codex.run(runOptions(f, {
    cwd: output,
    extraDirs: [],
    workspaceAccess: {
      readableRoots: [repo, input, output],
      writableRoots: [output],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
      allowExternalMcp: false,
      allowBash: false,
      tools: ['Read', 'Glob', 'Grep', 'repo_history'],
    },
  }));
  const client = (await readTrace(f.trace))
    .filter((entry) => entry.direction === 'client')
    .map((entry) => entry.message);
  const opened = client.find((message) => message.method === 'thread/start');
  const turn = client.find((message) => message.method === 'turn/start');

  assert.deepEqual({
    cwd: opened.params.cwd,
    readableRoots: [...opened.params.runtimeWorkspaceRoots].sort(),
    policy: turn.params.sandboxPolicy,
  }, {
    cwd: output,
    readableRoots: [input, output, repo].sort(),
    policy: {
      type: 'workspaceWrite',
      writableRoots: [output],
      readOnlyAccess: {
        type: 'restricted',
        includePlatformDefaults: true,
        readableRoots: [output, repo, input],
      },
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    },
  });
});

test('Codex проверяет sessionFlags SSH-hook до создания thread', async (t) => {
  const f = await fixture(t);
  await codex.run(runOptions(f));
  const trace = await readTrace(f.trace);
  const processEntry = trace.find((entry) => entry.direction === 'process');
  const hookConfig = processEntry?.argv.find((value, index) => (
    processEntry.argv[index - 1] === '-c'
      && String(value).startsWith('hooks.PreToolUse=')
  ));
  const methods = trace
    .filter((entry) => entry.direction === 'client')
    .map((entry) => entry.message?.method);

  assert.deepEqual({
    bypassTrust: processEntry?.argv.includes('--dangerously-bypass-hook-trust'),
    hookInProcessArgs: processEntry?.argv.some((value, index) => (
      processEntry.argv[index - 1] === '-c'
        && String(value).includes('_direct-ssh-policy-hook.js')
    )),
    hookMatcher: String(hookConfig || '').match(/matcher\s*=\s*"([^"]+)"/)?.[1],
    strictConfig: processEntry?.argv.includes('--strict-config'),
    policyBeforeThread: methods.indexOf('hooks/list') < methods.indexOf('thread/start'),
  }, {
    bypassTrust: true,
    hookInProcessArgs: true,
    hookMatcher: '^Bash$',
    strictConfig: false,
    policyBeforeThread: true,
  });
});

test('Codex отказывает до thread и turn, если app-server не подтвердил SSH-hook', async (t) => {
  const f = await fixture(t);
  f.env.COCKPIT_CODEX_FIXTURE_HOOK_STATE = 'missing';
  let error;
  try {
    await codex.run(runOptions(f));
  } catch (caught) {
    error = caught;
  }
  const methods = (await readTrace(f.trace))
    .filter((entry) => entry.direction === 'client')
    .map((entry) => entry.message?.method);

  assert.deepEqual({
    typedError: /^direct_ssh_policy/.test(String(error?.code || '')),
    hooksList: methods.includes('hooks/list'),
    thread: methods.some((method) => method === 'thread/start' || method === 'thread/resume'),
    turn: methods.includes('turn/start'),
  }, {
    typedError: true,
    hooksList: true,
    thread: false,
    turn: false,
  });
});

test('Codex при explicit false запускает прежний app-server без SSH-hook', async (t) => {
  const f = await fixture(t);
  f.env.COCKPIT_CODEX_FIXTURE_EXPECT_HOOK = '0';
  const result = await codex.run(runOptions(f, {
    providerSettings: { blockDirectSsh: false },
  }));
  const trace = await readTrace(f.trace);
  const processEntry = trace.find((entry) => entry.direction === 'process');
  const methods = trace
    .filter((entry) => entry.direction === 'client')
    .map((entry) => entry.message?.method);

  assert.deepEqual({
    reply: result.reply,
    bypassTrust: processEntry?.argv.includes('--dangerously-bypass-hook-trust'),
    hookConfig: processEntry?.argv.some((value) => String(value).startsWith('hooks.PreToolUse=')),
    hooksList: methods.includes('hooks/list'),
  }, {
    reply: 'Готово: изменения сохранены.',
    bypassTrust: false,
    hookConfig: false,
    hooksList: false,
  });
});

test('ход без final_answer отдаёт последний commentary, а не ошибку «нет ответа»', async (t) => {
  const f = await fixture(t, 'commentary-only');
  const steps = [];
  const result = await codex.run(runOptions(f, { onStep: (step) => steps.push(step) }));

  assert.equal(result.reply, 'Прогнал тесты, все зелёные; продолжаю по плану.');
  assert.equal(result.sessionId, '00000000-0000-7000-8000-000000000049');
  assert.ok(
    steps.some((step) => step.k === 'text' && step.text === result.reply),
    'сам commentary остаётся в ленте: ответ его дублирует, но не подменяет',
  );
});

for (const status of ['completed', 'interrupted']) {
  test(`Codex игнорирует ${status} чужого хода субагента`, async (t) => {
    const f = await fixture(t, `foreign-${status}`);
    const live = [];
    const result = await codex.run(runOptions(f, {
      onStep: (step) => live.push(step),
    }));

    assert.equal(result.reply, 'Готово: изменения сохранены.');
    assert.equal(result.sessionId, '00000000-0000-7000-8000-000000000049');
    assert.equal(result.totalInputTokens, 0, 'чужой token usage не относится к родителю');
    assert.deepEqual(result.steps, live);
    assert.doesNotMatch(
      JSON.stringify(result.steps),
      /Чужой субагент/u,
      'чужие сообщения не попадают в ленту родителя',
    );
  });
}

test('Codex показывает MCP Figma form и возвращает typed elicitation response', async (t) => {
  const f = await fixture(t, 'mcp-elicitation');
  const presentations = [];
  const result = await codex.run(runOptions(f, {
    onPermission: async (presentation) => {
      presentations.push(presentation);
      return {
        action: 'accept',
        answers: [
          { key: 'file_key', value: 'file-42' },
          { key: 'include_hidden', value: false },
        ],
      };
    },
  }));

  assert.equal(result.reply, 'Готово: изменения сохранены.');
  assert.equal(presentations.length, 1);
  assert.equal(presentations[0].source, 'MCP · figma');
  assert.equal(presentations[0].prompt, 'Какие данные макета использовать?');
  assert.deepEqual(presentations[0].actions, ['accept', 'decline', 'cancel']);
  assert.deepEqual(
    presentations[0].questions.map(({ key, inputType, required, default: value }) => ({
      key, inputType, required, defaultValue: value,
    })),
    [
      { key: 'file_key', inputType: 'text', required: true, defaultValue: undefined },
      { key: 'include_hidden', inputType: 'boolean', required: true, defaultValue: false },
    ],
  );
  assert.equal(presentations[0].signal instanceof AbortSignal, true);
});

test('serverRequest/resolved отменяет Figma URL без позднего JSON-RPC ответа', async (t) => {
  const f = await fixture(t, 'mcp-resolved');
  let aborted = false;
  const result = await codex.run(runOptions(f, {
    onPermission: (presentation) => new Promise((resolve) => {
      assert.equal(presentation.input.url, 'https://www.figma.com/oauth?state=opaque');
      presentation.signal.addEventListener('abort', () => {
        aborted = true;
        resolve({ action: 'cancel' });
      }, { once: true });
    }),
  }));

  assert.equal(result.reply, 'Готово: изменения сохранены.');
  assert.equal(aborted, true);
  const trace = await readTrace(f.trace);
  assert.equal(trace.some((entry) => (
    entry.direction === 'client' && entry.message?.id === 91013
  )), false, 'resolved request уже не ждёт и не принимает JSON-RPC response');
});

test('Codex не роняет ход на дубле и чужом item/tool/call', async (t) => {
  const f = await fixture(t, 'work-routing');
  const calls = [];
  const descriptor = {
    name: 'sample_lookup',
    description: 'Поиск по образцу',
    inputSchema: { type: 'object' },
  };
  const result = await codex.run(runOptions(f, {
    workTools: {
      descriptors: [descriptor],
      async invoke(name, input) {
        calls.push({ name, input });
        return { ok: true, items: [{ title: 'Figma MCP' }] };
      },
    },
  }));

  assert.equal(result.reply, 'Готово: изменения сохранены.');
  assert.deepEqual(calls, [{
    name: 'sample_lookup',
    input: { action: 'search', query: 'figma', limit: 3 },
  }]);
  const trace = await readTrace(f.trace);
  const foreignResponse = trace.find((entry) => (
    entry.direction === 'client' && entry.message?.id === 91012
  ));
  assert.equal(foreignResponse?.message?.error?.code, -32602);
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

test('Codex сообщает id thread до первого шага хода', async (t) => {
  const f = await fixture(t, 'early-thread-notification');
  const seen = [];
  const live = [];
  const result = await codex.run(runOptions(f, {
    onStep: (step) => live.push(step),
    onSessionCreated: (id) => { seen.push({ id, stepsBefore: live.length }); },
  }));

  // Перезапуск сервера посреди хода не должен оставить чат без id для thread/resume:
  // id уходит вызывающему сразу после handshake, до первого шага ленты.
  assert.deepEqual(seen, [{ id: result.sessionId, stepsBefore: 0 }]);
});

test('неудачный thread/resume гасит живую сессию, а не оставляет её повторять отказ', async (t) => {
  // App-server после «no rollout found» остаётся жив, но thread у него нет: живая сессия в
  // пуле отвечала бы этим же отказом на каждый следующий ход, пока не выйдет по простою.
  const f = await fixture(t, 'resume-missing');
  const exits = [];
  const session = codex.session.open({
    ...runOptions(f, { sessionId: '00000000-0000-7000-8000-0000000000ff' }),
    hooks: { onExit: (info) => exits.push(info) },
  });
  t.after(() => session.close());

  await assert.rejects(
    session.send({ message: 'продолжай' }),
    /thread\/resume: no rollout found for thread id 00000000-0000-7000-8000-0000000000ff/,
  );
  assert.equal(session.alive, false, 'сессия без thread гасится сразу, пул увидит мёртвый процесс');

  const deadline = Date.now() + 1_500;
  while (!exits.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(exits.length, 1, 'пул узнаёт о закрытии через onExit');
  assert.match(String(exits[0].reason), /не открыл thread: .*no rollout found/);
  // Отказ пришёл от «app-server», а не от самой fixture: процесс жил, пока его не погасили.
  const fixtureErrors = (await readTrace(f.trace)).filter((entry) => entry.direction === 'fixture-error');
  assert.deepEqual(fixtureErrors, []);
});

// ── Окончательный сбой и повторная отправка в ту же сессию (редакция 2 плана) ──
// Ядро узнаёт об автоматическом продолжении только из явных полей результата:
// deliveryFailure без turnRecovery автоматику не включает, а madeProgress приходит
// из событий ТЕКУЩЕГО хода, а не из усечённой ленты.

test('окончательный сетевой сбой: deliveryFailure, код причины и признак работы', async (t) => {
  const f = await fixture(t, 'turn-failed-transport');
  const result = await codex.run(runOptions(f));

  assert.equal(result.deliveryFailure, true, 'ход закрыт сбоем доставки');
  assert.equal(result.sessionId, '00000000-0000-7000-8000-000000000049', 'сессия сохранена');
  assert.equal(result.turnRecovery.canContinue, true, 'принятый ход того же thread продолжаем');
  assert.equal(result.turnRecovery.madeProgress, true, 'commentary — работа модели');
  assert.equal(result.turnFailure.code, 'responseStreamDisconnected');
  assert.match(result.turnFailure.message, /stream disconnected before completion/u);
  assert.ok(Array.isArray(result.steps) && result.steps.length > 0);
  assert.equal(result.cost, null);
});

test('окончательный отказ по лимиту: код ведёт реестр, продолжения нет', async (t) => {
  const f = await fixture(t, 'turn-failed-usage-limit');
  const result = await codex.run(runOptions(f));
  const verdict = classifyTurnFailure(result.turnFailure, CODEX_TURN_FAILURE_RULES);

  assert.equal(result.deliveryFailure, true);
  assert.equal(verdict.kind, 'usage_limit');
  assert.equal(verdict.continuable, false, 'лимит не продолжают автоматически');
});

test('финальная причина берётся из уведомления error, если turn.error пуст', async (t) => {
  const f = await fixture(t, 'turn-failed-notification-only');
  const result = await codex.run(runOptions(f));

  assert.equal(result.deliveryFailure, true, 'уведомление willRetry false финализирует причину');
  assert.match(result.turnFailure.message, /Reconnecting… 5\/5/u);
  assert.equal(result.turnRecovery.madeProgress, true);
});

test('промежуточная причина не превращается в разрешение продолжать', async (t) => {
  const f = await fixture(t, 'turn-failed-intermediate-error');
  const result = await codex.run(runOptions(f));

  assert.equal(result.deliveryFailure, true);
  assert.equal(result.turnFailure.message, 'ход завершился ошибкой', 'willRetry true не финальна');
  assert.equal(result.turnRecovery.canContinue, true, 'но сам ход принят и завершён');
});

test('промежуточный error, затем успех: обычный ход без внешнего продолжения', async (t) => {
  const f = await fixture(t, 'turn-failed-intermediate-then-success');
  const result = await codex.run(runOptions(f));

  assert.equal(result.deliveryFailure, undefined, 'ход закончился успехом');
  assert.equal(result.turnRecovery, undefined, 'разрешения продолжать нет');
  assert.match(String(result.reply), /задача продолжена/u);
});

test('два send в одном thread: сбой, затем успех с новым turn и признаком заново', async (t) => {
  const f = await fixture(t, 'turn-failed-then-success');
  const first = await codex.run(runOptions(f));

  assert.equal(first.deliveryFailure, true);
  assert.equal(first.turnRecovery.madeProgress, true);

  const second = await codex.run(runOptions(f, {
    sessionId: '00000000-0000-7000-8000-000000000049',
    message: 'Предыдущая попытка завершилась временным сбоем. Продолжай с места остановки.',
  }));

  assert.equal(second.deliveryFailure, undefined, 'второй ход успешен');
  assert.equal(second.turnRecovery, undefined);
  assert.equal(second.sessionId, '00000000-0000-7000-8000-000000000049', 'тот же thread');
  assert.match(String(second.reply), /продолжение сохранено/u);

  const trace = await readTrace(f.trace);
  const starts = trace.filter((entry) => entry.direction === 'client'
    && entry.message?.method === 'turn/start');
  const ids = new Set(starts.map((entry) => entry.message?.params?.turnId
    || entry.message?.params?.threadId));

  assert.equal(starts.length, 2, 'ровно две отправки в один thread');
  assert.ok(ids.size >= 1);

  const serverTurns = trace.filter((entry) => entry.direction === 'server'
    && entry.message?.method === 'turn/started')
    .map((entry) => entry.message?.params?.turn?.id);

  assert.ok(serverTurns.length >= 1);
});
