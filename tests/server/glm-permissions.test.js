import assert from 'node:assert/strict';
import test from 'node:test';

import { createGlmTurnGuard } from '../../server/src/lib/glm/permissions.ts';
import { glmArgumentsHash } from '../../server/src/lib/glm/policy.ts';

const ESCALATION = {
  file_path: '/outside/file.txt',
  content: 'x',
  sandbox_permissions: 'danger-full-access',
  justification: 'нужна запись вне проекта',
};

/**
 * События хода в форме DSH: маркер hooks, вызов инструмента и дескриптор hook.
 * Дескриптор можно испортить, чтобы проверить сверку аргументов.
 */
function feed(guard, { callId = 'call-1', name = 'write', input = ESCALATION, hashOf = input } = {}) {
  guard.inspect(hookResult('UserPromptSubmit', { event: 'UserPromptSubmit', marker: 'hooks-alive' }));
  guard.inspect({
    type: 'tool/call',
    data: {
      turn: 1,
      callId,
      name,
      arguments: typeof input === 'string' ? input : JSON.stringify(input),
    },
  });
  guard.inspect(hookResult('PreToolUse', {
    event: 'PreToolUse',
    tool_use_id: callId,
    name,
    sha256: glmArgumentsHash(hashOf),
    kind: name === 'bash' ? 'execute' : 'edit',
    decision: 'allow',
  }));
}

function hookResult(point, descriptor) {
  return {
    type: 'hook/result',
    data: {
      turn: 1,
      point,
      exitCode: 0,
      decision: 'pass',
      stderrSummary: `GLM-POLICY ${JSON.stringify(descriptor)}`,
    },
  };
}

function request(callId = 'call-1', toolName = 'write') {
  return {
    toolName,
    callId,
    reason: 'escalate sandbox to danger-full-access',
  };
}

test('одинаковый title разных инструментов даёт разные kind по точному имени', async () => {
  const guard = createGlmTurnGuard({ workTools: [], waitMs: 0 });

  feed(guard, { callId: 'call-w', name: 'write' });
  feed(guard, {
    callId: 'call-b',
    name: 'bash',
    input: { command: 'touch /outside/x', description: 'write' },
  });

  const write = await guard.approve(request('call-w', 'write'));
  const bash = await guard.approve(request('call-b', 'bash'));

  assert.equal(write.presentation.input.kind, 'edit');
  assert.equal(bash.presentation.input.kind, 'execute');
  assert.equal(bash.presentation.input.command, 'touch /outside/x');
});

test('approval без записи журнала или с другими аргументами — отказ', async () => {
  const missing = createGlmTurnGuard({ workTools: [], waitMs: 0 });

  missing.inspect({
    type: 'tool/call',
    data: {
      turn: 1,
      callId: 'call-1',
      name: 'write',
      arguments: '{}',
    },
  });
  assert.deepEqual(await missing.approve(request()), { allow: false });

  const changed = createGlmTurnGuard({ workTools: [], waitMs: 0 });

  feed(changed, { hashOf: { ...ESCALATION, file_path: '/other/file.txt' } });
  assert.deepEqual(await changed.approve(request()), { allow: false });

  const broken = createGlmTurnGuard({ workTools: [], waitMs: 0 });

  feed(broken, { input: '{"file_path": "/outside', hashOf: {} });
  assert.deepEqual(await broken.approve(request()), { allow: false });
});

test('чужие session или callId — отказ без UI', async () => {
  const guard = createGlmTurnGuard({
    workTools: [],
    waitMs: 0,
    sessionId: 'session-1',
  });

  feed(guard);

  assert.deepEqual(await guard.approve(request('call-foreign')), { allow: false });
  assert.deepEqual(await guard.approve({ ...request(), sessionId: 'session-2' }), { allow: false });
  assert.deepEqual(await guard.approve(request('call-1', 'edit')), { allow: false });
  assert.ok('presentation' in await guard.approve(request()));
});

test('allow после стопа — отказ', async () => {
  const controller = new AbortController();
  const guard = createGlmTurnGuard({
    workTools: [],
    waitMs: 0,
    signal: controller.signal,
  });

  assert.deepEqual(guard.settle({ allow: true }), { allow: true });
  controller.abort();
  assert.deepEqual(guard.settle({ allow: true }), { allow: false });
});

test('разрешение только разовое: canRemember false; комментарий к отказу не доставляется', async () => {
  const guard = createGlmTurnGuard({ workTools: [], waitMs: 0 });

  feed(guard);

  const { presentation } = await guard.approve(request());

  assert.equal(presentation.canRemember, false);
  assert.equal(presentation.acceptsComment, false);
  assert.equal(presentation.isQuestion, false);
  assert.equal(presentation.source, 'GLM');
});

test('внешний путь и проектный MCP требуют человека и в режиме auto', async () => {
  const guard = createGlmTurnGuard({ workTools: [], waitMs: 0 });
  const project = { text: 'x' };

  feed(guard);
  feed(guard, {
    callId: 'call-mcp',
    name: 'mcp__fixture__echo',
    input: project,
  });

  const external = await guard.approve(request());
  const mcp = await guard.approve(request('call-mcp', 'mcp__fixture__echo'));

  assert.equal(external.presentation.requiresExplicitUser, true);
  assert.equal(external.presentation.input.sandbox_permissions, 'danger-full-access');
  assert.equal(mcp.presentation.requiresExplicitUser, true);
  assert.equal(mcp.presentation.input.kind, 'mcp');
});

test('cockpit-work одобряется без человека только по точному имени из инвентаря', () => {
  const guard = createGlmTurnGuard({ workTools: ['repo_history'], waitMs: 0 });

  assert.equal(guard.autoApprove('mcp__cockpit-work__repo_history'), true);

  for (const name of ['mcp__cockpit-work__repo_historyx', 'mcp__cockpit-work__other', 'mcp__cockpit-work__',
    'repo_history', 'mcp__fixture__repo_history']) {
    assert.equal(guard.autoApprove(name), false, name);
  }
});

test('tool/call без маркера hooks-alive этого хода и результат без дескриптора дают glm_policy_hook_missing',
  () => {
    const unmarked = createGlmTurnGuard({ workTools: [], waitMs: 0 });
    const call = {
      type: 'tool/call',
      data: {
        turn: 2,
        callId: 'call-1',
        name: 'read',
        arguments: '{}',
      },
    };

    unmarked.inspect(hookResult('UserPromptSubmit', { event: 'UserPromptSubmit', marker: 'hooks-alive' }));
    assert.equal(unmarked.inspect(call)?.code, 'glm_policy_hook_missing');

    const undescribed = createGlmTurnGuard({ workTools: [], waitMs: 0 });

    undescribed.inspect(hookResult('UserPromptSubmit', { event: 'UserPromptSubmit', marker: 'hooks-alive' }));
    assert.equal(undescribed.inspect({ ...call, data: { ...call.data, turn: 1 } }), null);
    assert.equal(undescribed.inspect({
      type: 'tool/result',
      data: { message: { toolCallId: 'call-1', content: [] } },
    })?.code, 'glm_policy_hook_missing');
  });

test('результат инструмента сопоставляется по callId в форме настоящего DSH', () => {
  const guard = createGlmTurnGuard({ workTools: [], waitMs: 0 });

  feed(guard, { name: 'read', input: { file_path: 'x' } });

  assert.equal(guard.inspect({
    type: 'tool/result',
    data: {
      turn: 1,
      message: {
        source: { kind: 'tool', callId: 'call-1' },
        content: [{
          type: 'tool-result',
          toolCallId: 'call-1',
          content: [],
        }],
      },
    },
  }), null);
});
