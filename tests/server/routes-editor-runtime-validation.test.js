import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { makeDraft } from '../fixtures/routes-editor.mjs';
import { makeAgentNode } from '../fixtures/routes-editor.mjs';
import { validateDraft } from '../../server/src/modules/routes/validation.ts';
import {
  readEditorCapabilities,
  validateDraftCapabilities,
} from '../../server/src/modules/routes/editorCapabilities.ts';

const TOOL = fileURLToPath(new URL('../../engine/bin/factory-route', import.meta.url));

function engineCheck(draft) {
  const input = {
    profile: draft.profile,
    routes: draft.routes,
    bootstrap: draft.bootstrap,
    bootstrapPrompts: draft.bootstrapPrompts,
  };
  const result = spawnSync(TOOL, ['--profile', draft.profile, 'editor-check'], {
    input: JSON.stringify(input),
    encoding: 'utf8',
  });
  assert.equal(result.error, undefined);
  return JSON.parse(result.stdout);
}

test('RE-C4-01: same-runner блокируется до запуска, поддержанные стратегии проходят', () => {
  for (const [strategy, attempts, allowed] of [
    ['none', 0, true],
    ['runner-failover', 1, true],
    ['same-runner', 1, false],
  ]) {
    const draft = makeDraft();
    draft.routes.quick.route.nodes[0].retry.providerFailure = { strategy, attempts };
    const server = validateDraft(draft);
    const engine = engineCheck(draft);
    assert.equal(server.issues.some((issue) => issue.severity === 'error'), !allowed,
      `${strategy}: сервер`);
    assert.equal(engine.ok, allowed, `${strategy}: движок`);
    if (!allowed) {
      assert.ok(server.issues.some((issue) => issue.code === 'retry_strategy_unsupported'));
      assert.ok(engine.issues.some((issue) => issue.code === 'retry_strategy_unsupported'));
    }
  }
});

test('RE-C4-02: fanout и command сверяются со схемой и metadata runner', async (t) => {
  const writable = makeDraft();
  writable.routes.quick.route.nodes[0].policy.filesystem = 'workspace-write';
  writable.routes.quick.route.nodes[0].fanout = {
    mode: 'parallel', maxExecutors: 2, degrade: 'forbid',
  };
  assert.ok(validateDraft(writable).issues.some((item) => item.severity === 'error'));
  assert.equal(engineCheck(writable).ok, false);

  const commandRetry = makeDraft();
  commandRetry.routes.quick.route.nodes[1].retry.noResult = 1;
  assert.ok(validateDraft(commandRetry).issues.some((item) => item.severity === 'error'));
  assert.equal(engineCheck(commandRetry).ok, false);

  const degraded = makeDraft();
  degraded.routes.quick.route.nodes[0].fanout = {
    mode: 'parallel', maxExecutors: 3, degrade: 'allow-single',
  };
  assert.equal(validateDraft(degraded).issues.length, 0);
  assert.equal(engineCheck(degraded).ok, true);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-runtime-capabilities-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profile = path.join(root, 'sample');
  await fs.mkdir(profile);
  await fs.writeFile(path.join(profile, 'graph.json'), '{}');
  await fs.writeFile(path.join(profile, 'runners.env'),
    'RUNNERS_COVERAGE=required\nPROJECT_RUNNER_PRIMARY=codex\n');
  const snapshot = await readEditorCapabilities('sample', { profilesDir: root });
  const forbidden = makeDraft();
  forbidden.routes.quick.route.nodes[0].fanout = {
    mode: 'parallel', maxExecutors: 3, degrade: 'forbid',
  };
  assert.ok(validateDraftCapabilities(forbidden, snapshot).some(
    (item) => item.code === 'fanout_capability_unavailable' && item.nodeId === 'build',
  ));
  assert.equal(validateDraftCapabilities(degraded, snapshot).some(
    (item) => item.code === 'fanout_capability_unavailable',
  ), false);
});

test('RE-C4-03: canonical ship проходит, скрытая delivery-capability блокируется', () => {
  const ordinary = makeDraft();
  assert.equal(validateDraft(ordinary).issues.length, 0);
  assert.equal(engineCheck(ordinary).ok, true);

  const withShip = makeDraft();
  const route = withShip.routes.quick.route;
  const ship = makeAgentNode({
    id: 'ship',
    phase: 'tail',
    promptFile: 'prompts/ship.base.md',
    requiredContext: ['task', 'delivery'],
  });
  ship.policy.filesystem = 'workspace-write';
  ship.policy.timeoutClass = 'delivery';
  route.sequence.tail = ['ship'];
  route.nodes[3].on.approved = { next: 'ship' };
  route.nodes.push(ship);
  withShip.routes.quick.prompts['prompts/ship.base.md'] = 'Доставь проверенный результат.';
  assert.equal(validateDraft(withShip).issues.length, 0);
  assert.equal(engineCheck(withShip).ok, true);

  const wrongPhase = structuredClone(withShip);
  wrongPhase.routes.quick.route.nodes.at(-1).phase = 'main';
  wrongPhase.routes.quick.route.sequence.main.push('ship');
  wrongPhase.routes.quick.route.sequence.tail = [];
  assert.ok(validateDraft(wrongPhase).issues.some((item) => item.severity === 'error'));
  assert.equal(engineCheck(wrongPhase).ok, false);

  const hidden = makeDraft();
  hidden.routes.quick.route.nodes[0].prompt.requiredContext.push('delivery');
  assert.ok(validateDraft(hidden).issues.some((item) => item.severity === 'error'));
  assert.equal(engineCheck(hidden).ok, false);
});

/** Собирает пару, у которой instrument открывает транзакцию до proof. */
function withInstrumentPair() {
  const draft = makeDraft();
  const { route, prompts } = draft.routes.quick;
  const instrument = makeAgentNode({ id: 'instrument', on: {
    done: { next: 'proof' },
    skipped: { stop: 'human' },
    failed: { stop: 'failed' },
    exhausted: { stop: 'human' },
  } });
  const proof = makeAgentNode({ id: 'proof', on: {
    done: { next: 'check' },
    skipped: { stop: 'human' },
    failed: { stop: 'failed' },
    exhausted: { stop: 'human' },
  } });
  instrument.policy.filesystem = 'transactional-write';
  proof.policy.filesystem = 'transactional-write';
  route.nodes[0].on.done = { next: 'instrument' };
  route.sequence.main.splice(1, 0, 'instrument', 'proof');
  route.nodes.push(instrument, proof);
  prompts['prompts/instrument.base.md'] = 'Установи измерение.';
  prompts['prompts/proof.base.md'] = 'Проверь измерение.';
  route.nodes[3].on.rejected = {
    rewind: 'instrument',
    reset: ['instrument', 'proof', 'check', 'gate_accept'],
  };
  return draft;
}

test('RE-C4-04: pair и вход в закрытую зону отвергаются до исполнения', () => {
  const valid = withInstrumentPair();
  assert.equal(validateDraft(valid).issues.length, 0);
  assert.equal(engineCheck(valid).ok, true);

  const missingProof = structuredClone(valid);
  missingProof.routes.quick.route.sequence.main.splice(2, 1);
  missingProof.routes.quick.route.nodes = missingProof.routes.quick.route.nodes.filter(
    (node) => node.id !== 'proof',
  );
  missingProof.routes.quick.route.nodes.find((node) => node.id === 'instrument').on.done = {
    next: 'check',
  };
  missingProof.routes.quick.route.nodes.find((node) => node.id === 'gate_accept').on.rejected = {
    rewind: 'instrument', reset: ['instrument', 'check', 'gate_accept'],
  };
  delete missingProof.routes.quick.prompts['prompts/proof.base.md'];
  assert.ok(validateDraft(missingProof).issues.some((item) => (
    item.code === 'instrumentation_pair_invalid'
  )));
  assert.ok(engineCheck(missingProof).issues.some((item) => (
    item.code === 'instrumentation_pair_invalid'
  )));

  const bypass = structuredClone(valid);
  bypass.routes.quick.route.nodes[0].on.skipped = { next: 'proof' };
  assert.ok(validateDraft(bypass).issues.some((item) => (
    item.code === 'instrumentation_zone_unreachable'
  )));
  assert.ok(engineCheck(bypass).issues.some((item) => (
    item.code === 'instrumentation_zone_unreachable'
  )));

  const rewind = structuredClone(valid);
  rewind.routes.quick.route.nodes[3].on.rejected = {
    rewind: 'proof', reset: ['proof', 'check', 'gate_accept'],
  };
  assert.ok(validateDraft(rewind).issues.some((item) => (
    item.code === 'instrumentation_zone_unreachable'
  )));
  assert.ok(engineCheck(rewind).issues.some((item) => (
    item.code === 'instrumentation_zone_unreachable'
  )));
});

test('RE-C4-05: неизвестные context root и command ID блокируют публикацию', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-context-roots-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profile = path.join(root, 'sample');
  await fs.mkdir(path.join(profile, 'routes'), { recursive: true });
  await fs.writeFile(path.join(profile, 'graph.json'), '{}');
  await fs.writeFile(path.join(profile, 'routes', 'editor-capabilities.json'), JSON.stringify({
    schema: 1,
    commands: [{ id: 'project-check', label: 'Проверка', filesystem: ['state-only'] }],
    contextSections: [],
  }));
  const snapshot = await readEditorCapabilities('sample', { profilesDir: root });
  const valid = makeDraft();
  assert.equal(validateDraftCapabilities(valid, snapshot).length, 0);

  const unknownRoot = structuredClone(valid);
  unknownRoot.bootstrap.nodes[0].prompt.requiredContext.push('secretRoot');
  assert.ok(validateDraftCapabilities(unknownRoot, snapshot).some((item) => (
    item.code === 'context_section_unavailable' && item.scope === 'bootstrap'
      && item.nodeId === 'scout'
  )));

  const unknownCommand = structuredClone(valid);
  unknownCommand.routes.quick.route.nodes[1].commandId = 'undeclared-command';
  assert.ok(validateDraftCapabilities(unknownCommand, snapshot).some((item) => (
    item.code === 'command_unavailable' && item.nodeId === 'check'
  )));

  const wrongFilesystem = structuredClone(valid);
  wrongFilesystem.routes.quick.route.nodes[1].policy.filesystem = 'workspace-write';
  assert.ok(validateDraftCapabilities(wrongFilesystem, snapshot).some((item) => (
    item.code === 'command_filesystem_unavailable' && item.nodeId === 'check'
  )));
});

test('RE-C4-06: закрытый цикл предупреждается, rewind с выходом допускается', () => {
  const ordinary = makeDraft();
  assert.equal(validateDraft(ordinary).issues.some((item) => item.severity === 'warning'), false);
  assert.equal(engineCheck(ordinary).issues.some((item) => item.severity === 'warning'), false);

  const closed = makeDraft();
  const [build, check, , gate] = closed.routes.quick.route.nodes;
  for (const outcome of ['skipped', 'failed', 'exhausted']) {
    build.on[outcome] = { next: 'check' };
    check.on[outcome] = { next: 'gate_accept' };
  }
  gate.on.approved = {
    rewind: 'build', reset: ['build', 'check', 'gate_accept'],
  };
  const server = validateDraft(closed);
  const engine = engineCheck(closed);
  assert.equal(server.issues.some((item) => item.severity === 'error'), false);
  assert.equal(engine.ok, true);
  assert.ok(server.issues.some((item) => (
    item.code === 'runtime_limited_cycle' && item.severity === 'warning'
  )));
  assert.ok(engine.issues.some((item) => (
    item.code === 'runtime_limited_cycle' && item.severity === 'warning'
  )));
});
