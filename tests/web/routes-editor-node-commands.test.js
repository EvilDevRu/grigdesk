import assert from 'node:assert/strict';
import test from 'node:test';

import { makeDraft } from '../fixtures/routes-editor.mjs';
import { compileModule, webFile } from './helpers/compile-vue.js';

process.env.NODE_ENV = 'test';

test('RE-F1-01: agent получает безопасные defaults и пустой Markdown без полей шаблона',
  async () => {
    const commands = await compileModule(webFile('src/views/routes/routeCommands.ts'));
    const before = makeDraft();
    const original = structuredClone(before);
    const result = commands.addNode(before, { kind: 'route', routeId: 'quick' }, 'agent',
      () => 'REVIEW', { template: { label: 'Ревью', model: 'секрет', provider: 'иной' } });
    const node = result.draft.routes.quick.route.nodes.find((item) => item.id === 'review');
    assert.equal(node?.runKey, 'REVIEW');
    assert.equal(node?.executor, 'agent');
    assert.equal(node?.label, 'Ревью');
    assert.deepEqual(node?.policy, { filesystem: 'state-only', browser: 'forbid',
      timeoutClass: 'standard', budgetClass: 'standard' });
    assert.deepEqual(node?.fanout, { mode: 'single', maxExecutors: 1, degrade: 'forbid' });
    assert.deepEqual(node?.retry, { noResult: 0, productFailure: 0,
      providerFailure: { attempts: 0, strategy: 'none' } });
    assert.deepEqual(node?.prompt, { blocks: [{ file: 'prompts/review.base.md' }],
      requiredContext: ['task'] });
    assert.equal(result.draft.routes.quick.prompts['prompts/review.base.md'], '');
    assert.deepEqual(node?.on, { done: null, skipped: null, failed: null, exhausted: null });
    assert.equal(Object.hasOwn(node, 'model'), false);
    assert.equal(Object.hasOwn(node, 'provider'), false);
    assert.deepEqual(before, original);
  });

test('RE-F1-02: копия пары получает новые ID, ключи и тексты, внутреннюю связь переназначает',
  async () => {
    const commands = await compileModule(webFile('src/views/routes/routeCommands.ts'));
    const before = makeDraft();
    const original = structuredClone(before);
    const keys = ['BUILD_COPY', 'CHECK_COPY'];
    const result = commands.cloneNodes(before, { kind: 'route', routeId: 'quick' },
      ['build', 'check'], () => keys.shift());
    const machine = result.draft.routes.quick.route;
    const build = machine.nodes.find((node) => node.id === 'build_copy');
    const check = machine.nodes.find((node) => node.id === 'check_copy');
    assert.deepEqual(result.createdNodeIds, ['build_copy', 'check_copy']);
    assert.equal(build?.runKey, 'BUILD_COPY');
    assert.equal(check?.runKey, 'CHECK_COPY');
    assert.equal(build?.on.done.next, 'check_copy');
    assert.equal(build?.on.skipped.next, 'gate_accept');
    assert.ok(result.issues.some((issue) => issue.code === 'external_reference'
      && issue.path?.includes('build_copy')));
    assert.notEqual(build?.prompt.blocks[0].file, 'prompts/build.base.md');
    assert.equal(result.draft.routes.quick.prompts[build.prompt.blocks[0].file],
      before.routes.quick.prompts['prompts/build.base.md']);
    assert.ok(machine.sequence.main.includes('build_copy'));
    assert.ok(machine.sequence.main.includes('check_copy'));
    assert.deepEqual(before, original);
  });

test('RE-F1-03: agent → command предупреждает о тексте; отмена не меняет документ',
  async () => {
    const commands = await compileModule(webFile('src/views/routes/routeCommands.ts'));
    const before = makeDraft();
    const original = structuredClone(before);
    const scope = { kind: 'route', routeId: 'quick' };
    const preview = commands.changeNodeExecutor(before, scope, 'build', 'command', false);
    assert.equal(preview.draft, before);
    assert.ok(preview.issues.some((issue) => issue.code === 'text_loss'
      && issue.message.includes('Создай проверяемый результат')));
    assert.deepEqual(before, original);
    const result = commands.changeNodeExecutor(before, scope, 'build', 'command', true);
    const node = result.draft.routes.quick.route.nodes.find((item) => item.id === 'build');
    assert.equal(node.executor, 'command');
    assert.equal(node.commandId, '');
    assert.equal(Object.hasOwn(node, 'prompt'), false);
    assert.equal(Object.hasOwn(node, 'onFailure'), false);
    assert.equal(result.draft.routes.quick.prompts['prompts/build.base.md'],
      before.routes.quick.prompts['prompts/build.base.md']);
    assert.deepEqual(before, original);
  });

test('RE-F1-04: status связан с владельцем; command всегда создаётся с нулевым retry',
  async () => {
    const commands = await compileModule(webFile('src/views/routes/routeCommands.ts'));
    const before = makeDraft();
    const scope = { kind: 'route', routeId: 'quick' };
    const missing = commands.addNode(before, scope, 'status', () => 'ORPHAN_STATUS');
    assert.equal(missing.draft, before);
    assert.ok(missing.issues.some((issue) => issue.code === 'owner_required'));
    const withOwner = commands.addNode(before, scope, 'status',
      () => 'CHECK_STATUS_NEW', { ownerId: 'check' });
    const machine = withOwner.draft.routes.quick.route;
    const status = machine.nodes.find((node) => node.id === 'check_status_new');
    const check = machine.nodes.find((node) => node.id === 'check');
    assert.deepEqual(status, { id: 'check_status_new', executor: 'status', phase: 'main',
      key: 'CHECK_STATUS_NEW', owner: 'check' });
    assert.ok(check.emits.includes(status.id));
    assert.equal(machine.sequence.main.includes(status.id), false);
    const command = commands.addNode(withOwner.draft, scope, 'command',
      () => 'RUN_AUDIT');
    const commandNode = command.draft.routes.quick.route.nodes.find((node) => node.id === 'run_audit');
    assert.equal(commandNode.commandId, '');
    assert.equal(Object.hasOwn(commandNode, 'prompt'), false);
    assert.deepEqual(commandNode.retry, { noResult: 0, productFailure: 0,
      providerFailure: { attempts: 0, strategy: 'none' } });
    assert.deepEqual(before, makeDraft());
  });

test('RE-G1-01: moveNodePosition сохраняет точку, повтор той же точки не меняет черновик',
  async () => {
    const commands = await compileModule(webFile('src/views/routes/routeCommands.ts'));
    const before = makeDraft();
    const scope = { kind: 'route', routeId: 'quick' };
    const result = commands.moveNodePosition(before, scope, 'build', { x: 480, y: 320 });

    assert.notEqual(result.draft, before);
    assert.deepEqual(result.draft.presentation['r:quick:build'], { x: 480, y: 320 });
    assert.equal(result.issues.length, 0);

    const again = commands.moveNodePosition(result.draft, scope, 'build', { x: 480, y: 320 });

    assert.equal(again.draft === result.draft, true);
    assert.equal(again.issues.length, 1);
  });

test('RE-G1-02: moveNodePosition отвергает неизвестный узел и мусорную точку', async () => {
  const commands = await compileModule(webFile('src/views/routes/routeCommands.ts'));
  const before = makeDraft();
  const scope = { kind: 'route', routeId: 'quick' };

  const missing = commands.moveNodePosition(before, scope, 'ghost', { x: 1, y: 1 });
  const bad = commands.moveNodePosition(before, scope, 'build', { x: Number.NaN, y: 1 });

  assert.equal(missing.draft === before, true);
  assert.equal(missing.issues[0].code, 'node_missing');
  assert.equal(bad.draft === before, true);
  assert.equal(bad.issues[0].code, 'position_invalid');
});

test('RE-G1-03: resetScopeLayout снимает координаты только своей области', async () => {
  const commands = await compileModule(webFile('src/views/routes/routeCommands.ts'));
  const before = makeDraft();

  // Маршрута other в фикстуре нет — его ключи здесь посторонние и обязаны
  // остаться: это проверка границы области, «чинить» фикстуру не нужно.
  before.presentation['r:quick:build'] = { x: 1, y: 2 };
  before.presentation['r:other:build'] = { x: 3, y: 4 };
  before.presentation['b:scout'] = { x: 5, y: 6 };

  const result = commands.resetScopeLayout(before, { kind: 'route', routeId: 'quick' });

  assert.equal(Object.hasOwn(result.draft.presentation, 'r:quick:build'), false);
  assert.deepEqual(result.draft.presentation['r:other:build'], { x: 3, y: 4 });
  assert.deepEqual(result.draft.presentation['b:scout'], { x: 5, y: 6 });

  const empty = commands.resetScopeLayout(result.draft, { kind: 'route', routeId: 'quick' });

  assert.equal(empty.draft === result.draft, true);
});
