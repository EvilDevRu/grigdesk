import assert from 'node:assert/strict';
import test from 'node:test';

import { makeDraft } from '../fixtures/routes-editor.mjs';
import { capabilities, roleCatalog } from '../fixtures/routes-stage-wizard.mjs';
import { compileModule, webFile } from './helpers/compile-vue.js';

process.env.NODE_ENV = 'test';

const api = await compileModule(webFile('src/views/routes/routeCommands.ts'));
const catalog = await roleCatalog();
const scope = { kind: 'route', routeId: 'quick' };
const role = (id) => catalog.roles.find((item) => item.id === id);

/**
 * Пустой маршрут не содержит скрытых ссылок на прежний пакет.
 * Остальные области каталога остаются исходной независимой фикстурой.
 */
function emptyDraft() {
  const draft = makeDraft();
  const bundle = draft.routes.quick;


  bundle.route.nodes = [];
  bundle.route.sequence = { main: [], tail: [] };
  bundle.route.entry = null;
  bundle.prompts = {};

  return draft;
}

function add(draft, point, id = 'human', answers = {}) {
  const template = role(id);

  return api.addNodeAtPoint(draft, scope, point, template,
    { ...template.defaults, ...answers }, capabilities);
}

test('RE-G5-01: ручной левый сосед ближе 120 px всё равно выбран слева', () => {
  const draft = makeDraft();


  draft.presentation['r:quick:build'] = { x: 200, y: 40 };
  draft.presentation['r:quick:check'] = { x: 700, y: 40 };


  const result = add(draft, { x: 300, y: 100 });
  const created = result.createdNodeIds[0];

  assert.equal(result.issues.length, 0);
  assert.ok(created);
  assert.equal(result.draft.routes.quick.route.nodes.find((node) => node.id === 'build').on.done.next,
    created);
  assert.deepEqual(result.draft.presentation[`r:quick:${created}`], { x: 300, y: 100 });
});

test('RE-G5-02: пустой маршрут получает полный human-пакет и entry', () => {
  const result = add(emptyDraft(), { x: 120, y: 60 });
  const machine = result.draft.routes.quick.route;

  assert.equal(result.issues.length, 0);
  assert.equal(machine.nodes.length, 1);
  assert.equal(machine.nodes[0].executor, 'gate');
  assert.equal(machine.entry, machine.nodes[0].id);
  assert.deepEqual(machine.nodes[0].on.approved, { stop: 'done' });
});

test('RE-G5-05: без ручных координат выбран build между x=140 и x=480', () => {
  const result = add(makeDraft(), { x: 300, y: 50 });
  const created = result.createdNodeIds[0];
  const machine = result.draft.routes.quick.route;

  assert.equal(result.issues.length, 0);
  assert.equal(machine.nodes.find((node) => node.id === 'build').on.done.next, created);
  assert.equal(machine.nodes.find((node) => node.id === created).on.approved.next, 'check');
});

test('RE-G5-06: пустой custom сохраняет написанный текст побайтово', () => {
  const description = 'Проверь результат.\nСохрани полный отчёт, включая ё.';
  const result = add(emptyDraft(), { x: 120, y: 60 }, 'custom', { description });
  const bundle = result.draft.routes.quick;
  const node = bundle.route.nodes.find((item) => item.id === result.createdNodeIds[0]);

  assert.equal(result.issues.length, 0);
  assert.equal(node.executor, 'agent');
  assert.equal(node.description, description);
  assert.equal(node.prompt.blocks.some((block) => bundle.prompts[block.file] === description), true);
});

test('RE-G5-07: tests и command сохраняют canonical ID и commandId в пустом маршруте', () => {
  const tests = add(emptyDraft(), { x: 120, y: 60 }, 'tests');
  const command = add(emptyDraft(), { x: 120, y: 60 }, 'command');
  const testNode = tests.draft.routes.quick.route.nodes[0];
  const commandNode = command.draft.routes.quick.route.nodes[0];

  assert.equal(testNode.id, 'tests');
  assert.equal(testNode.runKey, 'TESTS');
  assert.equal(testNode.prompt.blocks.length > 0, true);
  assert.equal(commandNode.commandId, 'verify');
  assert.equal(commandNode.id, 'verify');
  assert.equal(commandNode.runKey, 'VERIFY');
});

test('RE-G5-08: нет левого узла — отказ, никакого добавления справа', () => {
  const before = makeDraft();
  const result = add(before, { x: 10, y: 50 });

  assert.equal(result.draft === before, true);
  assert.equal(result.issues[0].code, 'left_neighbor_missing');
  assert.equal(result.createdNodeIds.length, 0);
});

test('RE-G5-09: смешанные auto/manual точки и разные строки учитывают близость', () => {
  const before = makeDraft();


  before.presentation['r:quick:build'] = { x: 500, y: 900 };


  const result = add(before, { x: 600, y: 50 });
  const created = result.createdNodeIds[0];

  assert.equal(result.issues.length, 0);
  assert.equal(result.draft.routes.quick.route.nodes.find((node) => node.id === 'check').on.done.next,
    created);
});

test('RE-G5-10: review в пустом маршруте получает companion в одном снимке', () => {
  const result = add(emptyDraft(), { x: 120, y: 60 }, 'review');
  const machine = result.draft.routes.quick.route;

  assert.equal(result.issues.length, 0);
  assert.equal(result.createdNodeIds.length, 2);
  assert.equal(machine.entry, result.createdNodeIds[0]);
  assert.equal(machine.nodes[0].on.done.next, machine.nodes[1].id);
  assert.equal(machine.nodes[1].commandId, 'recheck');
});
