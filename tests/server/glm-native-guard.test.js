import assert from 'node:assert/strict';
import test from 'node:test';

import { createGlmNativeGuard } from '../../server/src/lib/glm/nativeGuard.ts';
import { createScopedRemote } from '../../server/src/lib/deepseek/scopedRemote.ts';
import { GLM_GATE_REVISION, glmGateHash } from '../../shared/node/glmGateProtocol.ts';

const identity = { launchId: 'launch', policyHash: 'a'.repeat(64) };
const input = { file_path: 'example' };

/**
 * Следует порядку native журнала: готовность, ход, вызов и proof.
 * Один callId намеренно повторяется в разных сессиях и ходах.
 */
function fixture() {
  const guard = createGlmNativeGuard({
    ...identity,
    rootSessionId: 'root',
    workTools: ['repo_history']
  });
  const emit = (sessionId, type, data) => guard.inspect(sessionId, { type, data });
  /**
   * Создаёт один проверенный вызов в журнале выбранного владельца.
   * Одинаковый callId позволяет проверить изоляцию session и turn.
   */
  const call = (sessionId = 'root', turn = 1, name = 'read', args = input) => {
    emit(sessionId, 'grigdesk/glm-ready', {
      ...identity,
      revision: GLM_GATE_REVISION,
      sessionId,
      agentId: sessionId,
    });
    emit(sessionId, 'turn/start', { turn });
    emit(sessionId, 'tool/call', {
      turn,
      callId: 'same',
      name,
      arguments: JSON.stringify(args)
    });

    const proof = {
      ...identity,
      format: 1,
      consumer: 'chat',
      sessionId,
      agentId: sessionId,
      turn,
      callId: 'same',
      name,
      sha256: glmGateHash(args),
      decision: 'allow',
      kind: 'read',
      reason: '',
    };

    emit(sessionId, 'grigdesk/glm-policy', proof);

    return proof;
  };
  const approval = (agentId = 'root', toolName = 'read') => ({
    event: 'approval/request',
    agentId,
    request: { callId: 'same', toolName },
  });

  return {
    guard,
    emit,
    call,
    approval
  };
}

test('native owner: ребёнок и несовпадающий tool не открывают панель', async () => {
  const f = fixture();

  f.call();
  f.call('child');
  assert.deepEqual(await f.guard.approve(f.approval('child'), AbortSignal.timeout(100)), { allow: false });
  assert.deepEqual(await f.guard.approve(f.approval('root', 'write'), AbortSignal.timeout(100)),
    { allow: false });

  const result = await f.guard.approve(f.approval(), AbortSignal.timeout(100));

  assert.equal(result.presentation.requiresExplicitUser, true);
});

test('native proof: история fork игнорируется, старый ход и неизвестный owner не допускаются', async () => {
  const f = fixture();
  const old = f.call();

  f.guard.inspect('child', {
    type: 'grigdesk/glm-ready', data: {
      ...identity,
      revision: GLM_GATE_REVISION,
      sessionId: 'root',
      agentId: 'root',
    }
  });
  assert.equal(f.guard.isReady('child'), false);
  f.emit('root', 'turn/end', { turn: 1 });
  assert.deepEqual(await f.guard.approve(f.approval(), AbortSignal.timeout(30)), { allow: false });
  f.call('root', 2);
  assert.throws(() => f.emit('root', 'grigdesk/glm-policy', old));
  assert.deepEqual(await f.guard.approve(f.approval('foreign'), AbortSignal.timeout(30)), { allow: false });
});

test('native question связывается с точным proof; служебный MCP тоже требует owner', async () => {
  const f = fixture();
  const proof = f.call('root', 1, 'ask_user_question', { questions: [] });
  const frame = {
    event: 'user-questions/request',
    agentId: 'root',
    request: { grigdeskGlm: proof },
  };

  assert.deepEqual(await f.guard.approve(frame, AbortSignal.timeout(100)), { question: true });
  frame.request.grigdeskGlm = { ...proof, sha256: 'f'.repeat(64) };
  assert.deepEqual(await f.guard.approve(frame, AbortSignal.timeout(100)), { allow: false });
  f.emit('root', 'turn/end', { turn: 1 });
  f.call('root', 2, 'mcp__grigdesk-work__repo_history', {});
  assert.deepEqual(await f.guard.approve(f.approval('root', 'mcp__grigdesk-work__repo_history'),
    AbortSignal.timeout(100)), { allow: true });
});

test('native повреждённый proof даёт типизированный отказ инфраструктуры', () => {
  const f = fixture();
  const proof = f.call();

  f.emit('root', 'tool/call', {
    turn: 1,
    callId: 'corrupt',
    name: 'read',
    arguments: JSON.stringify(input),
  });
  assert.throws(() => f.emit('root', 'grigdesk/glm-policy', {
    ...proof,
    callId: 'corrupt',
    sha256: 'f'.repeat(64),
  }), { code: 'glm_policy_gate_failed' });
});

test('remote: очередь, дубликат, отмена и поздний ответ из прежнего поколения изолированы', async () => {
  const answers = [];
  const panels = [];
  const awaiting = [];
  const remote = createScopedRemote({
    client: { answerEvent: async (...args) => answers.push(args) },
    signal: new AbortController().signal,
    source: 'GLM',
    approve: async () => ({ question: true }),
    onPermission: (panel) => new Promise((resolve) => panels.push({ panel, resolve })),
    onAwaiting: (value) => awaiting.push(value),
    onFailure: (error) => {
      throw error;
    },
  });
  const event = (eventId) => ({
    type: 'waterfall',
    event: 'user-questions/request',
    eventId,
    request: { questions: [] },
  });
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  remote.observe({ type: 'ready', clientId: 'first' });
  remote.observe(event('a'));
  remote.observe(event('a'));
  remote.observe(event('b'));
  await tick();
  assert.equal(panels.length, 1);
  remote.observe({ type: 'cancel', eventId: 'a' });
  await tick();
  assert.equal(panels[0].panel.signal.aborted, true);
  assert.equal(panels.length, 2);
  assert.equal(awaiting.at(-1), true);
  panels[0].resolve({ rawAnswers: [] });
  remote.observe({ type: 'ready', clientId: 'second' });
  panels[1].resolve({ rawAnswers: [] });
  remote.observe(event('b'));
  await tick();
  assert.equal(panels.length, 3);
  panels[2].resolve({ rawAnswers: [] });
  await tick();
  assert.equal(answers.length, 1);
  assert.deepEqual(answers[0].slice(0, 2), ['second', 'b']);
  remote.close();
  assert.equal(awaiting.at(-1), false);
});
