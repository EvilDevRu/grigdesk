import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { qwenToolAllowed } from '../../server/src/lib/qwen/policy.ts';
import { qwenPermissionResponse } from '../../server/src/lib/qwen/permissions.ts';

/**
 * Вызовы используют identity одного активного prompt без настоящего аккаунта.
 * Физические корни нужны для проверки записей и выходящих символических ссылок.
 */
async function policyFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qwen-tools-'));
  const cwd = path.join(root, 'workspace');
  const outside = path.join(root, 'outside');

  await mkdir(cwd);
  await mkdir(outside);
  t.after(() => rm(root, { recursive: true, force: true }));

  const context = {
    sessionId: 'session',
    promptId: 'prompt',
    cwd,
    writableRoots: [cwd],
    readonlyRoots: [],
    mode: 'yolo',
    mcpServers: [],
    blockDirectSsh: true,
  };
  const call = (toolName, args = {}) => ({
    sessionId: context.sessionId,
    promptId: context.promptId,
    invocationCwd: cwd,
    toolCallId: 'call',
    toolName,
    arguments: args,
  });

  return {
    cwd,
    outside,
    context,
    call,
  };
}

test('Qwen: обсуждённые native tools допущены во всех рабочих режимах', async (t) => {
  const { context, call } = await policyFixture(t);
  const tools = [
    'web_search', 'web_fetch', 'todo_write', 'save_memory', 'manage_memory', 'search_memory',
    'ask_user_question', 'enter_plan_mode', 'exit_plan_mode', 'agent', 'task', 'skill',
    'list_agents', 'task_stop', 'task_create', 'task_update', 'task_list', 'team_create',
    'team_delete', 'team_plan_approval', 'request_shutdown', 'send_message', 'structured_output',
    'cron_create', 'cron_list', 'cron_delete', 'loop_wakeup', 'get_goal', 'update_goal', 'propose_goal',
    'workflow', 'artifact', 'record_artifact', 'record_source', 'report_findings',
    'image_gen', 'zoom_image', 'display_image', 'omni_downsample_image', 'omni_downscale_video',
    'omni_downsample_audio', 'omni_extract_keyframes', 'omni_extract_audio', 'omni_clip_video',
    'omni_convert_image', 'omni_transcribe_audio', 'omni_clip_image', 'omni_clip_audio',
    'omni_caption_image', 'omni_caption_audio', 'omni_ocr_image', 'omni_understand_video_segments',
    'omni_recall_media_memory',
  ];

  for (const mode of ['default', 'auto', 'yolo']) {
    for (const name of tools) {
      assert.equal(await qwenToolAllowed(call(name), { ...context, mode }), true, `${mode}: ${name}`);
    }
  }

  for (const name of ['web_search_extra', 'unknown_native_tool', 'tool_call', 'tool_search']) {
    assert.equal(await qwenToolAllowed(call(name), context), false, name);
  }

  for (const field of ['sessionId', 'promptId', 'invocationCwd']) {
    assert.equal(await qwenToolAllowed({ ...call('web_search'), [field]: 'foreign' }, context), false);
  }

  const controller = new AbortController();

  controller.abort();
  assert.equal(await qwenToolAllowed(call('todo_write'), { ...context, signal: controller.signal }), false);
});

test('Qwen: расширение tools сохраняет границы файлов, план и SSH', async (t) => {
  const { cwd, outside, context, call } = await policyFixture(t);

  await symlink(outside, path.join(cwd, 'escape'));

  for (const name of ['notebook_edit', 'lsp']) {
    const key = name === 'lsp' ? 'filePath' : 'notebook_path';

    assert.equal(await qwenToolAllowed(call(name, { [key]: path.join(cwd, 'own.ipynb') }), context), true);
    assert.equal(await qwenToolAllowed(call(name, { [key]: path.join(outside, 'file') }), context), false);
    assert.equal(await qwenToolAllowed(call(name, { [key]: path.join(cwd, 'escape/file') }), context), false);
  }

  const plan = { ...context, mode: 'plan' };

  assert.equal(await qwenToolAllowed(call('lsp', {
    operation: 'incomingCalls', item: { uri: pathToFileURL(path.join(outside, 'file.ts')).href },
  }), context), false);
  assert.equal(await qwenToolAllowed(call('todo_write'), plan), true);
  assert.equal(await qwenToolAllowed(call('web_search'), plan), true);
  assert.equal(await qwenToolAllowed(call('web_fetch'), plan), true);
  assert.equal(await qwenToolAllowed(call('exit_plan_mode'), plan), true);
  assert.equal(await qwenToolAllowed(call('notebook_edit', { notebook_path: 'own.ipynb' }), plan), false);
  assert.equal(await qwenToolAllowed(call('image_gen'), plan), false);
  assert.equal(await qwenToolAllowed(call('workflow'), plan), false);
  assert.equal(await qwenToolAllowed(call('run_shell_command', { command: 'pwd' }), plan), false);

  const ssh = call('run_shell_command', { command: 'ssh example.invalid' });

  assert.equal(await qwenToolAllowed(ssh, context), false);
});

test('Qwen Host: builtin guard проверяет shell без подделки prompt ребёнка', async (t) => {
  const { context, call, cwd } = await policyFixture(t);
  const host = { ...context, hostAccess: true };
  const child = {
    ...call('run_shell_command', { command: 'printf host' }),
    promptId: undefined,
    invocationCwd: cwd,
  };

  assert.equal(await qwenToolAllowed(child, host), true);
  assert.equal(await qwenToolAllowed({ ...child, toolName: 'monitor' }, host), true);
  assert.equal(await qwenToolAllowed({ ...child, sessionId: 'foreign' }, host), false);
  assert.equal(await qwenToolAllowed({
    ...child,
    arguments: { command: 'ssh example.invalid' },
  }, host), false);
  assert.equal(await qwenToolAllowed({
    ...child,
    toolName: 'monitor',
    arguments: { command: 'ssh example.invalid' },
  }, host), false);
  assert.equal(await qwenToolAllowed(child, { ...host, mode: 'plan' }), false);
  assert.equal(await qwenToolAllowed({ ...child, toolName: 'new_shell_tool' }, host), false);
  assert.equal(await qwenToolAllowed(child, context), false);
});

/**
 * Форма запроса совпадает с ACP настоящего CLI, включая metadata интерактивного вопроса.
 * Обычный permission не получает текстовые ответы от карточки вопроса по совпадению title.
 */
function questionRequest() {
  return {
    toolCall: {
      title: 'Ask user 2 questions',
      rawInput: {},
      _meta: {
        toolName: 'ask_user_question',
        qwenInteractionKind: 'user_question',
        qwenQuestions: [
          {
            question: 'Выберите варианты',
            multiSelect: true,
            options: [{ label: 'A' }, { label: 'B' }],
          },
          { question: 'Уточните', options: [{ label: 'C' }, { label: 'D' }] },
        ],
      },
    },
    options: [
      { optionId: 'proceed_once', kind: 'allow_once' },
      { optionId: 'cancel', kind: 'reject_once' },
    ],
  };
}

test('Qwen: вопросы доставляют все ответы и свой текст по индексам ACP', async () => {
  const response = await qwenPermissionResponse(questionRequest(), {
    factory: false,
    ask: async (presentation) => {
      assert.equal(presentation.isQuestion, true);
      assert.equal(presentation.requiresExplicitUser, true);
      assert.equal(presentation.questions[0].multiSelect, true);
      assert.equal(presentation.questions[1].allowFreeText, true);

      return { rawAnswers: [{ selected: ['A', 'B'], text: 'дополнение' }, { text: 'свой ответ' }] };
    },
  });

  assert.deepEqual(response, {
    outcome: { outcome: 'selected', optionId: 'proceed_once' },
    answers: { 0: 'A, B, дополнение', 1: 'свой ответ' },
  });
});

test('Qwen: отмена вопроса, неполный ответ и factory не становятся разрешением', async () => {
  for (const decision of [{}, { rawAnswers: [{ text: 'только первый' }] }]) {
    const response = await qwenPermissionResponse(questionRequest(), {
      factory: false,
      ask: async () => decision,
    });

    assert.equal(response.outcome.optionId, 'cancel');
    assert.equal(response.answers, undefined);
  }

  const controller = new AbortController();
  const response = await qwenPermissionResponse(questionRequest(), {
    factory: false,
    signal: controller.signal,
    ask: async () => {
      controller.abort();

      return { rawAnswers: [{ text: 'поздно' }, { text: 'поздно' }] };
    },
  });

  assert.equal(response.outcome.optionId, 'cancel');
  assert.equal(response.answers, undefined);

  const factory = await qwenPermissionResponse(questionRequest(), {
    factory: true,
    ask: async () => assert.fail('Factory не спрашивает человека'),
  });

  assert.equal(factory.outcome.optionId, 'cancel');
});

test('Qwen: план показывает текст и выбирает только выданный CLI outcome', async () => {
  const request = {
    toolCall: {
      title: 'Plan:',
      rawInput: { plan: 'Проверить и исправить' },
      _meta: { toolName: 'exit_plan_mode' },
    },
    options: [
      {
        optionId: 'restore_previous',
        name: 'Вернуть режим',
        kind: 'allow_once',
      },
      {
        optionId: 'proceed_always',
        name: 'Автоправки',
        kind: 'allow_always',
      },
      {
        optionId: 'proceed_once',
        name: 'Спрашивать',
        kind: 'allow_once',
      },
      {
        optionId: 'cancel',
        name: 'Доработать',
        kind: 'reject_once',
      },
    ],
  };
  const response = await qwenPermissionResponse(request, {
    factory: false,
    ask: async (presentation) => {
      assert.equal(presentation.tool, 'ExitPlanMode');
      assert.equal(presentation.input.plan, request.toolCall.rawInput.plan);
      assert.equal(presentation.input.choices.length, 3);
      assert.equal(presentation.requiresExplicitUser, true);

      return { allow: true, choice: 'proceed_always' };
    },
  });

  assert.equal(response.outcome.optionId, 'proceed_always');

  const restored = await qwenPermissionResponse(request, {
    factory: false,
    planExecutionMode: 'auto',
    ask: async () => ({ allow: true, choice: 'restore_previous' }),
  });

  assert.equal(restored.outcome.optionId, 'restore_previous');
  assert.equal(restored.expectedPlanExecutionMode, 'auto');

  const denied = await qwenPermissionResponse(request, {
    factory: false,
    ask: async () => ({ allow: false, choice: 'proceed_always' }),
  });

  assert.equal(denied.outcome.optionId, 'cancel');

  const cancelled = await qwenPermissionResponse(request, {
    factory: false,
    ask: async () => ({ allow: true, choice: 'cancel' }),
  });

  assert.equal(cancelled.outcome.optionId, 'cancel');
});
