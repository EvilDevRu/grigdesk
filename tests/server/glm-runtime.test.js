import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { createGlmAdapter } from '../../server/src/lib/executors/glm.ts';
import { runDeepSeekServerTurn } from '../../server/src/lib/deepseek/serverTurn.ts';
import { glmCompatibilityIdentity } from '../../server/src/lib/glm/contract.ts';
import { describeGlmGeneration } from '../../server/src/lib/glm/generation.ts';
import { IN_TURN_ID_RE } from '../../shared/chat/chatInTurnContracts.ts';
import { GLM_FIXTURE_PLUGIN, writeGlmArtifactFixture } from '../helpers/glmArtifactFixture.mts';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const FAKE_WEB = path.join(REPO_ROOT, 'tests/fixtures/deepseek-harness/fakeWeb.mjs');
const MODEL = '["zai","glm-5.3"]';
const TEXT_SCENARIO = { updates: [{ sessionUpdate: 'agent_message_chunk', content: { text: 'ok' } }] };
const READ_CALL = {
  sessionUpdate: 'tool_call',
  toolCallId: 'call-1',
  title: 'read',
  rawInput: { file_path: 'a' },
};
const QUESTION = { questions: [{ id: 'q1', question: 'fixture-question' }] };
const CATALOG = [
  { id: MODEL, efforts: ['low', 'high', 'max'] },
  { id: '["zai","glm-4.7"]', efforts: ['off', 'minimal', 'low', 'medium', 'high'] },
];

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

/**
 * Ожидание состояния без sleep-цикла в тесте: короткий опрос с пределом попыток.
 * Предел превращает зависание в понятный провал, а не в таймаут всего файла.
 */
async function waitFor(probe, attempts = 500) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await probe();

    if (value) {
      return value;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error('ожидаемое состояние не наступило');
}

/**
 * Стенд хода GLM: generation-фикстура, чей entry запускает фейковый DSH web со сценарием.
 * Проверяется production-путь адаптера: generation, identity, launch и процесс.
 */
async function fixture(t, scenario = { updates: [] }, options = {}) {
  const catalog = Object.hasOwn(options, 'catalog') ? options.catalog : CATALOG;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glm-runtime-'));
  const project = path.join(root, 'project');
  const scenarioFile = path.join(root, 'scenario.json');
  const logFile = path.join(root, 'fake.ndjson');
  const artifact = path.join(root, 'generation');
  const children = [];

  await fs.mkdir(path.join(project, '.git'), { recursive: true });
  await fs.writeFile(scenarioFile, JSON.stringify(scenario));
  await fs.writeFile(logFile, '');
  await writeGlmArtifactFixture(artifact, {
    llmPiAi: GLM_FIXTURE_PLUGIN,
    entry: [
      'if (process.argv[2] === "-V") { console.log("0.1.5-rc.2"); process.exit(0); }',
      `process.argv.push("--scenario", ${JSON.stringify(scenarioFile)},`
        + ` "--log", ${JSON.stringify(logFile)});`,
      `await import(${JSON.stringify(pathToFileURL(FAKE_WEB).href)});`,
      '',
    ].join('\n'),
  });
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }

    await fs.rm(root, { recursive: true, force: true });
  });

  const config = {
    rootDir: root,
    deepseekBin: path.join(artifact, 'deepseek'),
    deepseekRuntimeMode: 'binary',
    glmRuntimeHome: path.join(root, 'glm-home'),
  };
  const identity = glmCompatibilityIdentity(describeGlmGeneration(config).runtime, 'api');
  const adapter = createGlmAdapter({
    env: {
      PATH: process.env.PATH,
      GRIGDESK_GLM_API_MODE: 'api',
      ZAI_API_KEY: 'synthetic-zai-key',
    },
    admission: [{ mode: 'api', compatibility: identity }],
    catalog,
    spawn: (...args) => {
      const child = spawn(...args);

      children.push(child);

      return child;
    },
  });
  const sessions = [];

  return {
    root,
    project,
    config,
    children,
    sessions,
    adapter,
    scenario: (value) => fs.writeFile(scenarioFile, JSON.stringify(value)),
    async log() {
      return (await fs.readFile(logFile, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
    },
    async prompts() {
      return (await this.log()).filter((entry) => entry.message?.method === 'session/prompt').length;
    },
    run(overrides = {}) {
      return adapter.run({
        config,
        cwd: project,
        chatKey: 'chat-a',
        message: 'fixture-prompt',
        model: MODEL,
        onSessionCreated: async (sessionId) => {
          sessions.push(sessionId);
        },
        ...overrides,
      });
    },
    async closed() {
      await waitFor(() => children.every((child) => child.exitCode !== null || child.signalCode !== null));

      const turns = path.join(config.glmRuntimeHome, identity.slice(0, 16), 'turns');

      return (await fs.readdir(turns).catch(() => [])).length === 0;
    },
  };
}

function labels(log) {
  return log.map((entry) => entry.kind === 'open'
    ? `open:${entry.message.endpoint}`
    : `${entry.kind}:${entry.message?.method ?? ''}`);
}

const RUNTIME_TEST_1 = 'порядок: create, binding, selectModel, effort,'
  + ' обратное чтение, $events и follow, prompt';

test(RUNTIME_TEST_1, async (t) => {
  const f = await fixture(t, TEXT_SCENARIO);
  let atBinding;
  const result = await f.run({
    onSessionCreated: async (sessionId) => {
      f.sessions.push(sessionId);
      atBinding = labels(await f.log());
    },
  });
  const order = labels(await f.log()).filter((label) => label !== 'request:settings/describe');
  const select = (await f.log()).find((entry) => entry.message?.method === 'session/selectModel');

  assert.equal(result.reply, 'ok');
  assert.equal(result.sessionId, f.sessions[0]);
  assert.deepEqual(atBinding, ['request:session/create']);
  assert.deepEqual(order.slice(0, 2), ['request:session/create', 'request:session/selectModel']);
  assert.deepEqual(order.slice(2, 4).sort(), ['open:$events', 'open:session/follow']);
  assert.equal(order[4], 'request:session/prompt');
  assert.deepEqual(select.message.params.request, {
    sessionId: f.sessions[0],
    provider: 'zai',
    model: 'glm-5.3',
    reasoningEffort: 'high',
  });
});

test('заметки GLM разделяют чтение вложений, image input модели и границу записи', async (t) => {
  for (const [attachments, extraDirs] of [[false, false], [true, false], [false, true], [true, true]]) {
    await t.test(`вложения=${attachments}, каталоги=${extraDirs}`, async (sub) => {
      const f = await fixture(sub, TEXT_SCENARIO);
      const attachment = path.join(f.root, 'shot.png');
      const message = attachments ? `Посмотри изображение: ${attachment}` : 'fixture-prompt';
      const steps = [];
      const expected = [];

      if (attachments) {
        expected.push('Вложения переданы в сообщении путями и доступны только на чтение. '
          + 'Просмотр изображений доступен только моделям GLM с image input; '
          + 'текстовые модели получат отказ read_image от Harness.');
      }
      if (extraDirs) {
        expected.push(`GLM пишет только в рабочей папке ${await fs.realpath(f.project)}; `
          + 'дополнительные каталоги доступны только на чтение.');
      }

      const result = await f.run({
        message,
        attachmentPaths: attachments ? [attachment] : [],
        extraDirs: extraDirs ? [path.join(f.root, 'other')] : [],
        onStep: (step) => steps.push(step),
      });
      const notes = steps.filter((step) => step.k === 'note').map((step) => step.text);
      const prompt = (await f.log()).find((entry) => entry.message?.method === 'session/prompt');

      assert.equal(result.reply, 'ok');
      assert.deepEqual(notes, expected);
      assert.ok(notes.every((text) => !text.includes('не добавлены в рабочую область')));
      assert.deepEqual(prompt.message.params.request.content, [{ type: 'text', text: message }]);
    });
  }
});

test('отказ CAS binding — ни одного prompt', async (t) => {
  const f = await fixture(t);
  const refusal = Object.assign(new Error('binding занят'), { code: 'provider_session_conflict' });

  /**
   * Чат отказал в привязке сессии (CAS): адаптер возвращает именно эту ошибку.
   * Prompt после отказа отправляться не должен.
   */
  const refuse = async () => {
    throw refusal;
  };

  await assert.rejects(f.run({ onSessionCreated: refuse }), (error) => error === refusal);
  assert.equal(await f.prompts(), 0);
  assert.equal(await f.closed(), true);
});

test('abort после каждого await — ни одного prompt, процесс и порт закрыты', async (t) => {
  for (const stage of ['before', 'session/create', 'binding', 'session/selectModel', 'session/follow']) {
    await t.test(stage, async (sub) => {
      const f = await fixture(sub, { updates: [], delay: { [stage]: 1500 } });
      const controller = new AbortController();

      if (stage === 'before') {
        controller.abort();
      } else if (stage !== 'binding') {
        void waitFor(async () => labels(await f.log()).some((label) => label.endsWith(stage)))
          .then(() => controller.abort());
      }

      const running = f.run({
        signal: controller.signal,
        onSessionCreated: async () => {
          if (stage === 'binding') {
            controller.abort();
          }
        },
      });

      await assert.rejects(running, (error) => error.stopped === true);
      assert.equal(await f.prompts(), 0);
      assert.equal(await f.closed(), true);

      if (stage === 'before') {
        assert.equal(f.children.length, 0);
      }
    });
  }
});

const RUNTIME_TEST_2 = 'модель не из каталога или чужая модель в обратном'
  + ' чтении — glm_model_mismatch без prompt';

test(RUNTIME_TEST_2, async (t) => {
  const f = await fixture(t);

  await assert.rejects(f.run({ model: '["zai","glm-9"]' }), { code: 'glm_model_mismatch' });
  await assert.rejects(f.run({ model: '["deepseek-official","deepseek-v4-flash"]' }), {
    code: 'glm_model_mismatch',
  });
  assert.equal(f.children.length, 0);

  await f.scenario({
    updates: [],
    readback: {
      provider: 'zai',
      model: 'glm-4.7',
      reasoningEffort: 'high',
    },
  });
  await assert.rejects(f.run(), { code: 'glm_model_mismatch' });
  assert.equal(await f.prompts(), 0);
});

test('effort в обратном чтении не совпал — glm_effort_mismatch без prompt', async (t) => {
  const f = await fixture(t, {
    updates: [],
    readback: {
      provider: 'zai',
      model: 'glm-5.3',
      reasoningEffort: 'low',
    },
  });

  await assert.rejects(f.run(), { code: 'glm_effort_mismatch' });
  await assert.rejects(f.run({ effort: 'xhigh' }), { code: 'glm_effort_mismatch' });
  assert.equal(await f.prompts(), 0);
});

test('effort без выбора отправляется как high; выбранный — как есть', async (t) => {
  const f = await fixture(t, TEXT_SCENARIO);

  await f.run();
  await f.run({ effort: 'max' });

  const efforts = (await f.log()).filter((entry) => entry.message?.method === 'session/selectModel')
    .map((entry) => entry.message.params.request.reasoningEffort);

  assert.deepEqual(efforts, ['high', 'max']);
});

const RUNTIME_TEST_3 = 'режим undefined и пустая строка — default; plan, bypass и'
  + ' неизвестный — glm_mode_unsupported без процесса';

test(RUNTIME_TEST_3,
  async (t) => {
    const f = await fixture(t, TEXT_SCENARIO);

    assert.equal((await f.run({ permissionMode: undefined })).reply, 'ok');
    assert.equal((await f.run({ permissionMode: '' })).reply, 'ok');
    assert.equal((await f.run({ permissionMode: 'auto' })).reply, 'ok');

    const started = f.children.length;

    for (const mode of ['plan', 'bypass', 'read-only', 'weird']) {
      await assert.rejects(f.run({ permissionMode: mode }), { code: 'glm_mode_unsupported' }, mode);
    }

    assert.equal(f.children.length, started);
  });

const RUNTIME_TEST_4 = 'factory, untrustedInput и произвольный scopedWorkspace'
  + ' — glm_consumer_unsupported без процесса';

test(RUNTIME_TEST_4, async (t) => {
  const f = await fixture(t);

  for (const consumer of [
    { factory: true },
    { untrustedInput: { text: 'x' } },
    { scopedWorkspace: true },
    { chatKey: '' },
    { onSessionCreated: undefined },
  ]) {
    await assert.rejects(f.run(consumer), { code: 'glm_consumer_unsupported' }, JSON.stringify(consumer));
  }

  assert.equal(f.children.length, 0);
});

test('некорректные корни триажа отклоняются до процесса', async (t) => {
  const f = await fixture(t);

  await assert.rejects(f.run({ workspaceAccess: { mode: 'write' } }), /Корни триажа/u);
  assert.equal(f.children.length, 0);
});

test('сбой запуска до prompt — glm_runtime_start_failed без emptyRun', async (t) => {
  const f = await fixture(t, {
    updates: [],
    rpcError: { 'session/create': { code: 'boom', message: 'boom' } },
  });

  await assert.rejects(f.run(), (error) => error.code === 'glm_runtime_start_failed'
    && !('emptyRun' in error));
  assert.equal(await f.prompts(), 0);
  assert.equal(await f.closed(), true);
});

const RUNTIME_TEST_5 = 'потеря ack после prompt — glm_ambiguous_outcome,'
  + ' sessionId и steps сохранены, повтора нет';

test(RUNTIME_TEST_5, async (t) => {
  const f = await fixture(t, { updates: [], dropPrompt: true });

  await assert.rejects(f.run(), (error) => {
    assert.equal(error.code, 'glm_ambiguous_outcome');
    assert.match(error.message, /автоматического повтора не было/u);
    assert.equal(error.sessionId, f.sessions[0]);
    assert.ok(Array.isArray(error.steps));

    return true;
  });
  assert.equal(await f.prompts(), 1);

  await f.scenario({
    updates: [READ_CALL],
    hooks: true,
    closeAfterPrompt: true,
  });
  await assert.rejects(f.run(), (error) => {
    assert.equal(error.code, 'glm_ambiguous_outcome');
    assert.ok(error.steps.some((step) => step.k === 'tool' && step.id === 'call-1'));

    return true;
  });
  assert.equal(await f.prompts(), 2);
});

test('ошибка модели с code AUTH — glm_auth_failed; QUOTA — glm_quota_exhausted; RATE_LIMIT — deliveryFailure',
  async (t) => {
    const f = await fixture(t);

    await f.scenario({ updates: [], turnError: { code: 'AUTH', message: '401 Unauthorized' } });
    await assert.rejects(f.run(), { code: 'glm_auth_failed' });
    await f.scenario({ updates: [], turnError: { code: 'QUOTA', message: 'Insufficient balance' } });
    await assert.rejects(f.run(), { code: 'glm_quota_exhausted' });
    await f.scenario({ updates: [], turnError: { code: 'RATE_LIMIT', message: '429 Rate limit' } });

    const result = await f.run();

    assert.equal(result.deliveryFailure, true);
    assert.equal(result.stopReason, 'error');
    assert.equal(result.turnFailure.code, 'RATE_LIMIT', 'код причины доезжает до реестра');
    assert.equal(result.turnRecovery.canContinue, true, 'окончательный исход принятого turn');
    assert.equal(await f.prompts(), 3);
  });

test('ход без сбоя доставки не несёт ни сигнала, ни разрешения продолжать',
  async (t) => {
    const f = await fixture(t, { hooks: true, updates: [READ_CALL] });

    const result = await f.run();

    assert.equal(result.deliveryFailure, undefined, 'обычный ход метки сбоя не получает');
    assert.equal(result.turnFailure, undefined);
    assert.equal(result.turnRecovery, undefined, 'Р2 не подтверждён — продолжать нечего');
  });

test('turn/end без текста и без шагов — emptyRun с retryState post_prompt', async (t) => {
  const f = await fixture(t, { updates: [] });
  const result = await f.run();

  assert.equal(result.emptyRun, true);
  assert.equal(result.retryState, 'post_prompt');
  assert.equal(result.reply, '');
});

test('turn/end с шагами инструментов без текста — успех с пустым reply, binding сохраняется', async (t) => {
  const f = await fixture(t, { hooks: true, updates: [
    READ_CALL,
    {
      sessionUpdate: 'tool_result',
      toolCallId: 'call-1',
      content: [{ type: 'text', text: 'a' }],
    },
  ] });
  const result = await f.run();

  assert.equal(result.reply, '');
  assert.equal(result.emptyRun, undefined);
  assert.equal(result.retryState, undefined);
  assert.equal(result.sessionId, f.sessions[0]);

  // Строка ленты называет действие, а итог находит свой вызов по callId настоящего DSH.
  const tool = result.steps.find((step) => step.k === 'tool');
  const done = result.steps.find((step) => step.k === 'res');

  assert.deepEqual([tool?.id, tool?.name, tool?.title], ['call-1', 'Read', 'a']);
  assert.deepEqual([done?.id, done?.ok, done?.text], ['call-1', true, 'a']);
});

const RUNTIME_TEST_6 = 'GLM отдаёт порт уточнений: сообщение уходит в тот же ход как steer,'
  + ' политика его пропускает, а после конца хода порт отказывает словами GLM';

test(RUNTIME_TEST_6, async (t) => {
  const f = await fixture(t, {
    hooks: true,
    updates: [READ_CALL, {
      sessionUpdate: 'tool_result',
      toolCallId: 'call-1',
      content: [{ type: 'text', text: 'a' }],
    }],
    steer: { reply: 'fixture-steer-answer' },
  });
  const states = [];
  let port;
  let delivered;
  // Без порта фейк держит ход до уточнения: предел превращает зависание в явный провал.
  const result = await f.run({
    signal: AbortSignal.timeout(15_000),
    onInTurnReady: (value) => {
      port = value;
      delivered = port.deliver({ messageId: 'steer-message-1', text: 'fixture-steer' });
    },
    onInTurnAvailability: (value) => states.push(value),
  });
  const steers = (await f.log()).filter((entry) => entry.message?.method === 'session/prompt'
    && entry.message.params?.request?.mode === 'steer');
  const late = await port.deliver({ messageId: 'steer-message-2', text: 'fixture-late' });

  assert.deepEqual(await delivered, { ok: true, state: 'forwarded' });
  assert.equal(result.reply, 'fixture-steer-answer');
  assert.deepEqual(steers.map((entry) => entry.message.params.request.content), [
    [{ type: 'text', text: 'fixture-steer' }],
  ]);
  assert.ok(states.some((value) => value.available === true), JSON.stringify(states));
  assert.equal(late.ok, false);
  assert.match(late.message, /GLM/u);
  assert.doesNotMatch(late.message, /DeepSeek/u);
});

test('вопрос агента доходит до onPermission с isQuestion', async (t) => {
  const f = await fixture(t, { updates: [], question: QUESTION });
  let presentation;

  await f.run({ onPermission: async (value) => {
    presentation = value;

    return { allow: true, rawAnswers: [{ selected: [], text: 'fixture-answer' }] };
  } });

  const answer = (await f.log()).find((entry) => entry.kind === 'question_response');

  assert.equal(presentation.isQuestion, true);
  assert.equal(presentation.source, 'GLM');
  assert.equal(presentation.questions[0].question, 'fixture-question');
  assert.deepEqual(answer.message.result.value.answers, [{
    id: 'q1',
    selected: [],
    custom: 'fixture-answer',
  }]);
});

test('размышления идут шагом think, reply без reasoning', async (t) => {
  const f = await fixture(t, { updates: [
    { sessionUpdate: 'agent_thought_chunk', content: { text: 'fixture-thinking' } },
    { sessionUpdate: 'agent_message_chunk', content: { text: 'fixture-answer' } },
  ] });
  const result = await f.run();
  const thoughts = result.steps.filter((step) => step.k === 'think').map((step) => step.text);

  assert.equal(result.reply, 'fixture-answer');
  assert.deepEqual(thoughts, ['fixture-thinking']);
  assert.equal(result.reply.includes('fixture-thinking'), false);
});

const RUNTIME_TEST_7 = 'runDeepSeekServerTurn DeepSeek после параметризации:'
  + ' прежнее автоодобрение и onInTurnReady';

test(RUNTIME_TEST_7, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deepseek-turn-'));
  const scenarioFile = path.join(root, 'scenario.json');
  const logFile = path.join(root, 'fake.ndjson');
  const bin = path.join(root, 'dsh');
  const overlay = path.join(root, 'overlay.yml');
  const calls = [];

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(overlay, '[]\n');
  await fs.writeFile(logFile, '');
  await fs.writeFile(scenarioFile, JSON.stringify({
    updates: [],
    permission: { toolCallId: 'call-1', toolName: 'mcp__grigdesk-work__repo_history' },
  }));
  await fs.writeFile(bin, [
    '#!/bin/sh',
    `exec ${shellQuote(process.execPath)} ${shellQuote(FAKE_WEB)} --scenario ${shellQuote(scenarioFile)} `
      + `--log ${shellQuote(logFile)} "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });

  await runDeepSeekServerTurn({
    bin,
    overlayPath: overlay,
    cwd: root,
    env: { PATH: process.env.PATH },
    message: 'deepseek',
    workToolNames: new Set(['repo_history']),
    onInTurnReady: () => calls.push('ready'),
    onPermission: async () => {
      calls.push('permission');

      return { allow: false };
    },
  });

  const log = (await fs.readFile(logFile, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  const answer = log.find((entry) => entry.kind === 'permission_response');

  assert.deepEqual(answer.message.result, { kind: 'result', value: 'allowed-once' });
  assert.deepEqual(calls, ['ready']);
});

test('отсутствие native ready останавливает запуск до prompt', async (t) => {
  const f = await fixture(t, {
    hooks: 'no-marker',
    waitForCancel: true,
    updates: [READ_CALL],
  });

  await assert.rejects(f.run({ signal: AbortSignal.timeout(15_000) }), { code: 'glm_policy_gate_missing' });

  const methods = (await f.log()).map((entry) => entry.message?.method);

  assert.equal(methods.includes('session/prompt'), false);
  assert.equal(await f.prompts(), 0);
});

test('результат инструмента без native proof — cancel и glm_policy_gate_failed', async (t) => {
  const f = await fixture(t, {
    hooks: 'no-descriptor',
    waitForCancel: true,
    updates: [READ_CALL, {
      sessionUpdate: 'tool_result',
      toolCallId: 'call-1',
      content: [],
    }],
  });

  await assert.rejects(f.run({ signal: AbortSignal.timeout(10_000) }), { code: 'glm_policy_gate_failed' });
  assert.ok((await f.log()).some((entry) => entry.message?.method === 'session/cancel'));
});

test('turn/end blocked — glm_turn_blocked, а не неясный исход', async (t) => {
  const f = await fixture(t, { updates: [], blocked: true });

  await assert.rejects(f.run(), { code: 'glm_turn_blocked' });
  assert.equal(await f.prompts(), 1);
});

test('без списка моделей в зависимостях модель проверяет каталог DSH до prompt', async (t) => {
  const f = await fixture(t, TEXT_SCENARIO, { catalog: undefined });

  assert.equal((await f.run()).reply, 'ok');

  await f.scenario({
    updates: [],
    rpcError: {
      'session/selectModel': {
        code: 'session/model-unavailable',
        message: 'pi-ai provider "zai" has no configured model "glm-9"',
      },
    },
  });
  await assert.rejects(f.run({ model: '["zai","glm-9"]' }), { code: 'glm_model_mismatch' });
  await assert.rejects(f.run({ model: '["deepseek-official","deepseek-v4-flash"]' }), {
    code: 'glm_model_mismatch',
  });
  assert.equal(await f.prompts(), 1);
});

test('id блока ответа годится для хранилища ответов при attemptId настоящего DSH', async (t) => {
  const f = await fixture(t, {
    ...TEXT_SCENARIO,
    attemptPrefix: 'session-00000000-0000-4000-8000-000000000000',
  });
  const ids = [];
  const result = await f.run({ onAssistantMessage: (event) => ids.push(event.assistantMessageId) });

  assert.ok(ids.length > 0);
  assert.ok(ids.every((id) => IN_TURN_ID_RE.test(id)), JSON.stringify(ids));
  assert.ok(IN_TURN_ID_RE.test(result.assistantMessageId), result.assistantMessageId);

  // Шаг текста и реплика — один блок: по общему id окно прячет копию показанного ответа.
  assert.deepEqual(result.steps.filter((step) => step.k === 'text').map((step) => step.id), [
    result.assistantMessageId,
  ]);
});

test('GLM сообщает подтверждённую модель сессии, и строка состояния не остаётся на «запр.»', async (t) => {
  const f = await fixture(t, TEXT_SCENARIO);
  const metadata = [];
  const result = await f.run({ onRunMetadata: (value) => metadata.push(value) });

  assert.deepEqual(metadata, [{ actualModelId: MODEL, modelSource: 'session' }]);
  assert.equal(result.actualModel, MODEL);
});


test('GLM сохраняет последний контекст DSH в результате после уменьшения', async (t) => {
  const f = await fixture(t, {
    updates: [
      { sessionUpdate: 'usage', usage: {
        inputTokens: 1000,
        cacheReadTokens: 2000,
        cacheWriteTokens: 300,
        outputTokens: 40,
      } },
      { sessionUpdate: 'usage', usage: { inputTokens: 700, outputTokens: 50 } },
    ],
  });
  const progress = [];
  const result = await f.run({ onProgress: (tokens, info) => progress.push({ tokens, ...info }) });

  assert.deepEqual(progress.map((item) => item.contextTokens), [3300, 700]);
  assert.equal(result.contextTokens, 700);
  assert.equal(result.contextMetric, 'deepseek-web-usage');
  assert.equal(result.contextWindow, 0);
});

test('snapshot: окно проходит в каждый замер, включая кеш, уменьшение и ноль', async (t) => {
  const f = await fixture(t, {
    contextPressure: {
      pressureTokens: 90000,
      contextWindow: 131072,
    },
    updates: [
      {
        sessionUpdate: 'usage',
        usage: {
          inputTokens: 1000,
          cacheReadTokens: 2000,
          cacheWriteTokens: 300,
          outputTokens: 40,
        },
      },
      {
        sessionUpdate: 'usage',
        usage: { inputTokens: 0, outputTokens: 45 },
      },
      {
        sessionUpdate: 'usage',
        usage: { inputTokens: 700, outputTokens: 50 },
      },
    ],
  });
  const progress = [];
  const result = await f.run({
    onProgress: (tokens, info) => progress.push({ tokens, ...info }),
  });

  assert.deepEqual(progress.map((item) => item.contextTokens), [3300, 0, 700]);
  assert.deepEqual(progress.map((item) => item.contextWindow), [131072, 131072, 131072]);
  assert.ok(progress.every((item) => item.contextMetric === 'deepseek-web-usage'));
  assert.equal(result.contextTokens, 700);
  assert.equal(result.contextWindow, 131072);
  assert.equal(result.contextMetric, 'deepseek-web-usage');
});

test('snapshot: отсутствующее и некорректное окно не превращаются в ёмкость', async (t) => {
  const invalid = [undefined, null, '131072', true, [131072], {}, -1, 0, 1.5, 2 ** 53];

  for (const value of invalid) {
    await t.test(`окно=${JSON.stringify(value)}`, async (sub) => {
      const f = await fixture(sub, {
        contextPressure: { contextWindow: value },
        updates: [{
          sessionUpdate: 'usage',
          usage: { inputTokens: 700, outputTokens: 50 },
        }],
      });
      const progress = [];
      const result = await f.run({
        onProgress: (tokens, info) => progress.push({ tokens, ...info }),
      });

      assert.equal(result.contextWindow, 0);
      assert.equal(result.contextTokens, 700);
      assert.equal(progress.at(-1).contextWindow, 0);
    });
  }
});

test('request/context: первый ход получает окно до usage без проекции snapshot', async (t) => {
  const f = await fixture(t, {
    updates: [
      {
        sessionUpdate: 'requestContext',
        context: {
          provider: 'zai',
          model: 'glm-5.3',
          contextWindow: 262144,
        },
      },
      {
        sessionUpdate: 'usage',
        usage: { inputTokens: 700, outputTokens: 50 },
      },
    ],
  });
  const progress = [];
  const result = await f.run({
    onProgress: (tokens, info) => progress.push({ tokens, ...info }),
  });

  assert.equal(result.contextWindow, 262144);
  assert.equal(result.contextTokens, 700);
  assert.equal(progress.length, 1);
  assert.equal(progress[0].contextWindow, 262144);
  assert.equal(progress[0].contextMetric, 'deepseek-web-usage');
});

test('request/context: новое, неизвестное и восстановленное окно заменяют snapshot', async (t) => {
  const f = await fixture(t, {
    contextPressure: { contextWindow: 131072 },
    updates: [
      {
        sessionUpdate: 'usage',
        usage: { inputTokens: 700, outputTokens: 10 },
      },
      {
        sessionUpdate: 'requestContext',
        context: {
          provider: 'zai',
          model: 'glm-5.3',
          contextWindow: 262144,
        },
      },
      {
        sessionUpdate: 'usage',
        usage: { inputTokens: 0, outputTokens: 20 },
      },
      {
        sessionUpdate: 'requestContext',
        context: { provider: 'zai', model: 'glm-4.7' },
      },
      {
        sessionUpdate: 'usage',
        usage: { inputTokens: 50, outputTokens: 30 },
      },
      {
        sessionUpdate: 'requestContext',
        context: {
          provider: 'zai',
          model: 'glm-5.3',
          contextWindow: 131072,
        },
      },
      {
        sessionUpdate: 'usage',
        usage: { inputTokens: 40, outputTokens: 40 },
      },
    ],
  });
  const progress = [];
  const result = await f.run({
    onProgress: (tokens, info) => progress.push({ tokens, ...info }),
  });

  assert.deepEqual(progress.map((item) => item.contextTokens), [700, 0, 50, 40]);
  assert.deepEqual(progress.map((item) => item.contextWindow), [131072, 262144, 0, 131072]);
  assert.equal(result.contextWindow, 131072);
  assert.equal(result.contextTokens, 40);
});

test('request/context: некорректное окно инвалидирует прежнее без числового приведения', async (t) => {
  const invalid = [undefined, null, '131072', true, [131072], {}, -1, 0, 1.5, 2 ** 53];

  for (const value of invalid) {
    await t.test(`окно=${JSON.stringify(value)}`, async (sub) => {
      const f = await fixture(sub, {
        contextPressure: { contextWindow: 262144 },
        updates: [
          {
            sessionUpdate: 'requestContext',
            context: {
              provider: 'zai',
              model: 'glm-5.3',
              contextWindow: value,
            },
          },
          {
            sessionUpdate: 'usage',
            usage: { inputTokens: 700, outputTokens: 50 },
          },
        ],
      });
      const progress = [];
      const result = await f.run({
        onProgress: (tokens, info) => progress.push({ tokens, ...info }),
      });

      assert.equal(result.contextWindow, 0);
      assert.equal(progress.at(-1).contextWindow, 0);
      assert.equal(result.contextTokens, 700);
    });
  }
});
