import assert from 'node:assert/strict';
import test from 'node:test';

import { makeDraft } from '../fixtures/routes-editor.mjs';
import { ROUTES_EDITOR_LIMITS } from '../../shared/pipeline/routesEditorContracts.ts';
import {
  applyDraftOperations,
  validateDraftShape,
  toRuntimeCatalogInput,
} from '../../server/src/modules/routes/draftModel.ts';

test('RE-A2-01: незавершённый черновик сохраняется, но не готов к публикации', () => {
  const draft = makeDraft();
  draft.routes.quick.prompts['prompts/build.base.md'] = '';
  draft.routes.quick.route.nodes[0].on.done = null;

  assert.deepEqual(validateDraftShape(draft), draft);

  const result = toRuntimeCatalogInput(draft);
  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map((issue) => issue.path).sort(), [
    '/routes/quick/prompts/prompts~1build.base.md',
    '/routes/quick/route/nodes/0/on/done',
  ]);
});

test('RE-A2-02: пакет меняет route и bootstrap целиком без мутации исходника', () => {
  const original = makeDraft();
  const snapshot = structuredClone(original);
  const route = structuredClone(original.routes.quick.route);
  const bootstrap = structuredClone(original.bootstrap);
  route.nodes[0].label = 'Новая сборка';
  bootstrap.nodes[0].label = 'Новая разведка';

  const result = applyDraftOperations(original, [
    { kind: 'putRoute', routeId: 'quick', route, prompts: original.routes.quick.prompts },
    { kind: 'putBootstrap', bootstrap, prompts: original.bootstrapPrompts },
  ]);

  assert.equal(result.routes.quick.route.nodes[0].label, 'Новая сборка');
  assert.equal(result.bootstrap.nodes[0].label, 'Новая разведка');
  assert.deepEqual(original, snapshot);

  assert.throws(() => applyDraftOperations(original, [
    { kind: 'putRoute', routeId: 'quick', route, prompts: original.routes.quick.prompts },
    { kind: 'putBootstrap', bootstrap, prompts: { 'bootstrap/prompts/scout.base.md': 42 } },
  ]));
  assert.deepEqual(original, snapshot);
});

test('RE-A2-03: удаление маршрута оставляет ссылку до явного исправления', () => {
  const original = makeDraft();
  const result = applyDraftOperations(original, [{ kind: 'removeRoute', routeId: 'quick' }]);

  assert.deepEqual(result.routes, {});
  assert.deepEqual(result.bootstrap.escalation[0].allowedRoutes, ['quick']);
  assert.deepEqual(result.bootstrap.nodes[0].on.done.escalate.routes, ['quick']);

  const publication = toRuntimeCatalogInput(result);
  assert.equal(publication.ok, false);
  assert.ok(publication.issues.some((issue) => issue.code === 'route_reference_missing'));
});

test('RE-A2-04: неизвестная операция и traversal prompt-пути отклоняются', () => {
  const draft = makeDraft();

  assert.throws(() => applyDraftOperations(draft, [{ kind: 'shell', command: 'x' }]));
  draft.routes.quick.prompts['prompts/../secret.md'] = 'Небезопасный путь';
  assert.throws(() => validateDraftShape(draft), /prompts|путь/i);
});

test('RE-A2-04: лишние поля команды и опасные ID не попадают в документ', () => {
  const draft = makeDraft();

  assert.throws(() => applyDraftOperations(draft, [
    { kind: 'setTitle', title: 'Новое имя', shell: 'x' },
  ]), /shell|operations/i);
  assert.throws(() => applyDraftOperations(draft, [
    { kind: 'putRoute', routeId: '../bad', ...draft.routes.quick },
  ]), /routeId|route/i);

  draft.routes.quick.route.nodes[0].on.done = { next: '../bad' };
  assert.throws(() => validateDraftShape(draft), /next/i);
});

test('RE-A2-04: число маршрутов принимается на пределе и отклоняется после него', () => {
  const draft = makeDraft();
  const template = structuredClone(draft.routes.quick);

  for (let index = 1; index < ROUTES_EDITOR_LIMITS.routes; index++) {
    const routeId = `r${index}`;
    draft.routes[routeId] = structuredClone(template);
    draft.routes[routeId].route.id = routeId;
  }

  assert.doesNotThrow(() => validateDraftShape(draft));
  draft.routes.extra = structuredClone(template);
  draft.routes.extra.route.id = 'extra';
  assert.throws(() => validateDraftShape(draft), /routes/i);
});

test('RE-A2-04: число узлов машины принимается на пределе и отклоняется после него', () => {
  const draft = makeDraft();
  const nodes = draft.routes.quick.route.nodes;
  const status = nodes.find((node) => node.executor === 'status');

  for (let index = nodes.length; index < ROUTES_EDITOR_LIMITS.nodes; index++) {
    nodes.push({ ...status, id: `extra_${index}`, key: `EXTRA_${index}` });
  }

  assert.doesNotThrow(() => validateDraftShape(draft));
  nodes.push({ ...status, id: 'extra_over', key: 'EXTRA_OVER' });
  assert.throws(() => validateDraftShape(draft), /nodes/i);
});

test('RE-A2-04: число блоков инструкции принимается на пределе и отклоняется после него', () => {
  const draft = makeDraft();
  const blocks = draft.routes.quick.route.nodes[0].prompt.blocks;
  blocks.length = 0;

  for (let index = 0; index < ROUTES_EDITOR_LIMITS.promptBlocks; index++) {
    blocks.push({ file: 'prompts/build.base.md' });
  }

  assert.doesNotThrow(() => validateDraftShape(draft));
  blocks.push({ file: 'prompts/build.base.md' });
  assert.throws(() => validateDraftShape(draft), /blocks/i);
});

test('RE-A2-04: число операций принимается на пределе и отклоняется после него', () => {
  const draft = makeDraft();
  const operations = Array.from(
    { length: ROUTES_EDITOR_LIMITS.operations },
    () => ({ kind: 'setTitle', title: 'То же название' }),
  );

  assert.equal(applyDraftOperations(draft, operations).title, 'То же название');
  operations.push({ kind: 'setTitle', title: 'Лишняя операция' });
  assert.throws(() => applyDraftOperations(draft, operations), /operations/i);
});

test('RE-A2-04: размер prompt-файла считается по UTF-8 байтам', () => {
  const draft = makeDraft();
  const file = 'prompts/build.base.md';
  draft.routes.quick.prompts[file] = 'я'.repeat(ROUTES_EDITOR_LIMITS.promptFileBytes / 2);

  assert.doesNotThrow(() => validateDraftShape(draft));
  draft.routes.quick.prompts[file] += 'я';
  assert.throws(() => validateDraftShape(draft), /prompts|размер/i);
});

test('RE-A2-04: суммарный размер prompts bundle ограничен отдельно от файла', () => {
  const draft = makeDraft();
  const prompts = {};

  for (let index = 0; index < 8; index++) {
    prompts[`prompts/f${index}.md`] = 'x'.repeat(ROUTES_EDITOR_LIMITS.promptFileBytes);
  }
  draft.routes.quick.prompts = prompts;

  assert.doesNotThrow(() => validateDraftShape(draft));
  prompts['prompts/extra.md'] = 'x';
  assert.throws(() => validateDraftShape(draft), /prompts|размер/i);
});

test('RE-A2-04: полный UTF-8 документ ограничен 64 MiB', () => {
  const draft = makeDraft();
  draft.provenance.padding = '';
  const baseBytes = Buffer.byteLength(JSON.stringify(draft));
  draft.provenance.padding = 'x'.repeat(ROUTES_EDITOR_LIMITS.draftBytes - baseBytes);

  assert.equal(Buffer.byteLength(JSON.stringify(draft)), ROUTES_EDITOR_LIMITS.draftBytes);
  assert.doesNotThrow(() => validateDraftShape(draft));
  draft.provenance.padding += 'x';
  assert.throws(() => validateDraftShape(draft), /draft|размер/i);
});

test('RE-A2-04: размер пакета операций ограничен 64 MiB', () => {
  const draft = makeDraft();
  const operations = [
    { kind: 'setTitle', title: '' },
    { kind: 'setTitle', title: 'Итог' },
  ];
  const baseBytes = Buffer.byteLength(JSON.stringify(operations));
  operations[0].title = 'x'.repeat(ROUTES_EDITOR_LIMITS.patchBytes - baseBytes);

  assert.equal(Buffer.byteLength(JSON.stringify(operations)), ROUTES_EDITOR_LIMITS.patchBytes);
  assert.equal(applyDraftOperations(draft, operations).title, 'Итог');
  operations[0].title += 'x';
  assert.throws(() => applyDraftOperations(draft, operations), /operations|размер/i);
});

test('RE-A2-05: раскладка и происхождение не меняют исполняемый комплект', () => {
  const draft = makeDraft();
  const initial = toRuntimeCatalogInput(draft);
  const changed = applyDraftOperations(draft, [
    { kind: 'putPresentation', presentation: { quick: { build: { x: 123, y: 456 } } } },
    { kind: 'putProvenance', provenance: { quick: { templateId: 'synthetic' } } },
  ]);
  changed.updatedAt = '2026-01-02T00:00:00.000Z';
  const final = toRuntimeCatalogInput(changed);

  assert.equal(initial.ok, true);
  assert.equal(final.ok, true);
  assert.deepEqual(final.input, initial.input);
  assert.equal(Object.hasOwn(final.input, 'presentation'), false);
  assert.equal(Object.hasOwn(final.input, 'provenance'), false);
});
