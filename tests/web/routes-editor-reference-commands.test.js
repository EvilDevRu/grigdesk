import assert from 'node:assert/strict';
import test from 'node:test';

import { makeDraft } from '../fixtures/routes-editor.mjs';
import { compileModule, webFile } from './helpers/compile-vue.js';

process.env.NODE_ENV = 'test';

const commands = await compileModule(webFile('src/views/routes/routeCommands.ts'));
const scope = { kind: 'route', routeId: 'quick' };

test('RE-F2-01: rename обновляет entry, sequence, on/onFailure, reset и escalation.from',
  () => {
    const original = makeDraft();
    original.routes.quick.route.nodes[0].onFailure = {
      build: { next: 'build' }, tests: { stop: 'human' },
      environment: { stop: 'human' }, plan: { stop: 'human' },
      human: { stop: 'human' },
    };
    original.routes.quick.route.escalation.push({ from: 'build',
      allowedRoutes: ['quick'], requiresHumanWhenPinned: true });
    const snapshot = structuredClone(original);
    const result = commands.renameNode(original, scope, 'build', 'build_fix');
    const machine = result.draft.routes.quick.route;
    assert.equal(machine.entry, 'build_fix');
    assert.deepEqual(machine.sequence.main, ['build_fix', 'check', 'gate_accept']);
    assert.equal(machine.nodes[0].id, 'build_fix');
    assert.equal(machine.nodes[0].runKey, 'BUILD_FIX');
    assert.equal(machine.nodes[0].onFailure.build.next, 'build_fix');
    assert.equal(machine.nodes.find((node) => node.id === 'gate_accept').on.rejected.rewind,
      'build_fix');
    assert.deepEqual(machine.nodes.find((node) => node.id === 'gate_accept').on.rejected.reset,
      ['build_fix', 'check', 'gate_accept']);
    assert.equal(machine.escalation[0].from, 'build_fix');
    assert.deepEqual(original, snapshot);
  });

test('RE-F2-02: rename владельца и статуса сохраняет обе стороны связи', () => {
  const owner = commands.renameNode(makeDraft(), scope, 'check', 'verify');
  const machine = owner.draft.routes.quick.route;
  assert.equal(machine.nodes.find((node) => node.id === 'check_status').owner, 'verify');
  assert.deepEqual(machine.nodes.find((node) => node.id === 'verify').emits, ['check_status']);
  assert.equal(machine.nodes.find((node) => node.id === 'build').on.done.next, 'verify');
  const status = commands.renameNode(owner.draft, scope, 'check_status', 'verify_status');
  const statusMachine = status.draft.routes.quick.route;
  assert.deepEqual(statusMachine.nodes.find((node) => node.id === 'verify').emits,
    ['verify_status']);
  assert.equal(statusMachine.nodes.find((node) => node.id === 'verify_status').owner, 'verify');
  assert.equal(statusMachine.nodes.find((node) => node.id === 'verify_status').key,
    'VERIFY_STATUS');
});

test('RE-F2-03: занятый и семантический ID запрещены, подпись меняется отдельно', () => {
  const original = makeDraft();
  const occupied = commands.renameNode(original, scope, 'build', 'check');
  assert.equal(occupied.draft, original);
  assert.ok(occupied.issues.some((issue) => issue.code === 'node_id_conflict'));
  const special = commands.renameNode(original, scope, 'build', 'ship');
  assert.equal(special.draft, original);
  assert.ok(special.issues.some((issue) => issue.code === 'semantic_node_id'));
  const labeled = commands.setNodeLabel(original, scope, 'build', 'Отгрузка и проверка');
  const build = labeled.draft.routes.quick.route.nodes.find((node) => node.id === 'build');
  assert.equal(build.label, 'Отгрузка и проверка');
  assert.equal(build.id, 'build');
  assert.equal(build.runKey, 'BUILD');
  assert.deepEqual(original, makeDraft());
});

test('RE-F2-04: удаление показывает входящие ссылки и оставляет видимый dangling', () => {
  const original = makeDraft();
  const preview = commands.inspectNodeReferences(original, scope, ['build']);
  assert.ok(preview.references.some((ref) => ref.relation === 'entry' && ref.target === 'build'));
  assert.ok(preview.references.some((ref) => ref.path.includes('gate_accept.on.rejected.rewind')));
  assert.ok(preview.references.some((ref) => ref.path.includes('gate_accept.on.rejected.reset')));
  assert.ok(preview.promptFiles.some((file) => file.file === 'prompts/build.base.md'
    && file.selectedUsers.includes('build')));
  const result = commands.removeNodes(original, scope, ['build']);
  const machine = result.draft.routes.quick.route;
  assert.equal(machine.entry, null);
  assert.equal(machine.nodes.some((node) => node.id === 'build'), false);
  assert.equal(machine.nodes.find((node) => node.id === 'gate_accept').on.rejected.rewind,
    'build');
  assert.ok(result.issues.some((issue) => issue.code === 'dangling_reference'
    && issue.path?.includes('gate_accept.on.rejected.rewind')));
  assert.deepEqual(original, makeDraft());
});

test('RE-F2-05: общий prompt сохраняется, orphan удаляется только явным выбором', () => {
  const original = makeDraft();
  const shared = 'prompts/build.base.md';
  original.routes.quick.route.nodes.find((node) => node.id === 'build').prompt.blocks
    .push({ file: 'prompts/only_build.md' });
  original.routes.quick.prompts['prompts/only_build.md'] = 'Только этот этап.\n';
  const check = original.routes.quick.route.nodes.find((node) => node.id === 'check');
  check.executor = 'agent';
  check.commandId = undefined;
  delete check.commandId;
  check.prompt = { blocks: [{ file: shared }], requiredContext: ['task'] };
  const preview = commands.inspectNodeReferences(original, scope, ['build']);
  assert.deepEqual(preview.promptFiles.find((item) => item.file === shared).otherUsers, ['check']);
  const ordinary = commands.removeNodes(original, scope, ['build']);
  assert.equal(ordinary.draft.routes.quick.prompts['prompts/only_build.md'], 'Только этот этап.\n');
  const chosen = commands.removeNodes(original, scope, ['build'], {
    deletePromptFiles: [shared, 'prompts/only_build.md'],
  });
  assert.equal(chosen.draft.routes.quick.prompts[shared],
    original.routes.quick.prompts[shared]);
  assert.equal(Object.hasOwn(chosen.draft.routes.quick.prompts, 'prompts/only_build.md'), false);
  assert.ok(chosen.issues.some((issue) => issue.code === 'prompt_shared' && issue.path === shared));
});
