import assert from 'node:assert/strict';
import test from 'node:test';

import { createGlmTreeObserver } from '../../server/src/lib/glm/treeObserver.ts';
import { GLM_GATE_REVISION, glmGateHash } from '../../shared/node/glmGateProtocol.ts';

const identity = { launchId: 'launch', policyHash: 'a'.repeat(64) };
const record = (seq, type, data = {}) => ({
  type: 'event', event: {
    seq,
    type,
    data
  }
});
const ready = (seq, sessionId) => record(seq, 'grigdesk/glm-ready', {
  ...identity,
  revision: GLM_GATE_REVISION,
  sessionId,
  agentId: sessionId,
});

/**
 * Подмена только carrier follow/page позволяет детерминированно переставлять доставку.
 * Правила владения, нормализация steps и native proof остаются настоящими.
 */
function fixture() {
  const steps = [];
  const usage = [];
  const failures = [];
  const streams = [];
  const pages = [];
  const controller = new AbortController();
  const observer = createGlmTreeObserver({
    ...identity,
    sessionId: 'root',
    signal: controller.signal,
    workTools: [],
    client: {
      rpc: async (_name, request) => {
        pages.push(request);

        return {
        records: Array.from({ length: 60 }, (_, seq) => record(seq, 'user/message')),
        hasMore: false,
      };
      }
    },
    onStep: (step) => steps.push(step),
    onProgress: (value) => usage.push(value),
    onFailure: (error) => failures.push(error),
    openStream: (options) => {
      streams.push(options);

      return { ready: Promise.resolve(), close() { } };
    },
  });
  /**
   * Подписка на ребёнка возникает только после proof, каталога и точной связи.
   * Порядок совпадает с native событиями первого делегирования.
   */
  const begin = async () => {
    await observer.observe(ready(0, 'root'));
    await observer.observe(record(1, 'turn/start', { turn: 1 }));
    await observer.observe(record(2, 'tool/call', {
      turn: 1,
      callId: 'delegate',
      name: 'subagent',
      arguments: '{}',
    }));
    await observer.observe(record(3, 'grigdesk/glm-policy', {
      ...identity,
      format: 1,
      consumer: 'chat',
      sessionId: 'root',
      agentId: 'root',
      turn: 1,
      callId: 'delegate',
      name: 'subagent',
      sha256: glmGateHash({}),
      decision: 'allow',
      kind: 'other',
      reason: '',
    }));
    await observer.observe(record(4, 'subagent/catalog', { childId: 'child', mode: 'one-shot' }));
    await observer.observe(record(5, 'grigdesk/glm-delegation', {
      ...identity,
      version: 1,
      parentSessionId: 'root',
      parentTurn: 1,
      parentCallId: 'delegate',
      childSessionId: 'child',
      childAgentId: 'child',
      mode: 'one-shot',
    }));
  };

  return {
    observer,
    begin,
    steps,
    usage,
    failures,
    streams,
    pages,
    controller
  };
}

test('tree: поздняя страница >50, seed, duplicate suffix и дочерний terminal изолированы', async () => {
  const f = fixture();

  await f.begin();
  assert.equal(f.streams.length, 1);

  const follow = f.streams[0];

  follow.onItem({
    type: 'snapshot',
    header: { id: 'child' },
    cursor: 63,
    hasMore: true,
    records: [ready(60, 'child'), record(61, 'turn/start', { turn: 1 }),
    record(62, 'assistant/message', {
      turn: 1,
      step: 1,
      message: { content: [{ type: 'text', text: 'child-only' }] },
      usage: { outputTokens: 7 },
    }), record(63, 'turn/end', { turn: 1 })],
  });
  follow.onItem(record(62, 'assistant/message', { usage: { outputTokens: 999 } }));
  await f.observer.drain();
  assert.equal(f.failures.length, 0);
  assert.deepEqual(f.pages[0].request, {
    address: {
      kind: 'subagent',
      parentSessionId: 'root',
      childSessionId: 'child',
      mode: 'one-shot'
    },
    throughSeq: 63,
    beforeSeq: 60,
    maxMessages: 100,
  });
  assert.deepEqual(f.usage, [7]);
  assert.equal(f.steps.length, 1);
  assert.equal(f.steps[0].text, 'child-only');
  assert.equal(f.steps[0].parent, 'delegate');
  assert.match(f.steps[0].id, /^glm_[a-f0-9]{64}$/u);
  f.observer.close();
});

test('tree: пропуск seq и связь с неизвестным call закрывают наблюдение отказом', async () => {
  const f = fixture();

  await f.begin();
  f.streams[0].onItem(ready(1, 'child'));
  await assert.rejects(f.observer.drain(), /пропущено событие/u);
  assert.equal(f.failures.length, 1);
  f.observer.close();
});
