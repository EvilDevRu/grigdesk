import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildArbiterStopContext,
  readArbiterStopContext,
} from '../../server/src/lib/arbiterStopContext.ts';

const trusted = {
  task: '7',
  profile: 'demo',
  attempt: `a_${'a'.repeat(32)}`,
  terminal: null,
  bootstrapStop: null,
  cursor: { state: 'stopped', stop: 'human' },
  stageIdentity: { sequence: 2, headEventHash: 'b'.repeat(64) },
};
const events = [
  {
    sequence: 0,
    kind: 'init',
    node: 'build'
  },
  {
    sequence: 1,
    kind: 'commit',
    node: 'build',
    outcome: 'done'
  },
  {
    sequence: 2,
    kind: 'commit',
    node: 'verify',
    outcome: 'failed',
    reason: 'Лимит проверки',
    action: { stop: 'human' },
    verdict: {
      owner: 'tests', findings: [
        {
          id: 'timeout',
          summary: 'Проверка выполнялась дольше лимита.',
          severity: 'blocker'
        },
      ]
    }
  },
];
const route = {
  sequence: ['build', 'verify', 'future'], nodes: [
    {
      id: 'build',
      executor: 'agent',
      label: 'Исправление',
      policy: { filesystem: 'workspace-write' }
    },
    {
      id: 'verify',
      executor: 'command',
      label: 'Проверка'
    },
    {
      id: 'future',
      executor: 'agent',
      label: 'Будущий этап'
    },
  ]
};

test('human tests/build/environment допускают читающий разбор exact остановки', () => {
  for (const owner of ['tests', 'build', 'environment']) {
    const changed = structuredClone(events);

    changed[2].verdict.owner = owner;

    const context = buildArbiterStopContext(trusted, changed, route);

    assert.equal(context.identity.stageSequence, 2);
    assert.equal(context.identity.stageHeadHash, 'b'.repeat(64));
    assert.match(context.sourceText, /Проверка выполнялась дольше лимита/);
    assert.deepEqual(context.targets.map((target) => target.node), ['build', 'verify']);
    assert.equal(context.targets[1].acceptsInstruction, false);
    assert.equal(context.targets[1].canRetryUnchanged, true);
    assert.match(context.sourceLabel, /проверки/);
  }
});

test('терминал, bootstrap, loop-ceiling и ворота не превращаются в остановочный диалог', () => {
  for (const patch of [
    { terminal: 'completed' }, { bootstrapStop: {} },
    { cursor: { state: 'stopped', stop: 'loop-ceiling' } },
    { cursor: { state: 'paused', node: 'gate_accept' } },
  ]) {
    assert.throws(() => buildArbiterStopContext({ ...trusted, ...patch }, events, route));
  }

  const gateRoute = {
    ...route,
    nodes: route.nodes.map((node) => node.id === 'verify' ? { ...node, executor: 'gate' } : node),
  };

  assert.throws(() => buildArbiterStopContext(trusted, events, gateRoute), { code: 'not_arbitrable' });
});

test('bootstrap без route pin отбирается до обращения к каталогу и stage events', async () => {
  await assert.rejects(readArbiterStopContext({
    readTrustedAttempt: async () => ({
      ...trusted,
      bootstrapStop: {},
      cursor: null
    }),
  }, {
    factoryControlDir: '/nonexistent-fixture-control', routesDir: '/nonexistent-fixture-routes',
  }, '7'), { code: 'not_arbitrable' });
});

test('источник берётся из последнего exact event, старый mutable report не используется', () => {
  const changed = structuredClone(events);

  changed[2].verdict.findings[0].summary = 'Новое обстоятельство';

  const context = buildArbiterStopContext(trusted, changed, route);

  assert.match(context.sourceText, /Новое обстоятельство/);
  assert.equal(context.reportPath, null);
  assert.match(context.sourceText, /не оставил отдельного сообщения/);
});
