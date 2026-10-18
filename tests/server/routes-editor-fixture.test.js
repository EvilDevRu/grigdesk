import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { makeCatalogInput, makeDraft } from '../fixtures/routes-editor.mjs';
import {
  validateBootstrap,
  validatePromptFiles,
  validateRoute,
} from '../../server/src/modules/routes/schema.ts';
import { RoutesStore } from '../../server/src/modules/routes/store.ts';

test('RE-A0-01: маршрут и bootstrap fixture проходят настоящую schema', () => {
  const input = makeCatalogInput();
  const quick = input.routes.quick;
  const routeFiles = validatePromptFiles(quick.prompts, { prefix: 'prompts/' });
  const bootstrapFiles = validatePromptFiles(input.bootstrapPrompts, {
    prefix: 'bootstrap/prompts/',
  });

  assert.equal(validateRoute(quick.route, {
    profile: input.profile,
    routeId: 'quick',
    promptFiles: routeFiles,
  }), quick.route);
  assert.equal(validateBootstrap(input.bootstrap, {
    profile: input.profile,
    promptFiles: bootstrapFiles,
  }), input.bootstrap);
  assert.deepEqual(input.bootstrap.escalation[0].allowedRoutes, ['quick']);
});

test('RE-A0-02: два вызова makeDraft не разделяют изменяемые данные', () => {
  const first = makeDraft();
  const second = makeDraft();

  first.routes.quick.route.nodes[0].prompt.blocks[0].file = 'prompts/changed.md';
  first.routes.quick.prompts['prompts/build.base.md'] = 'Чужая правка';
  first.bootstrap.nodes[0].on.done.escalate.routes.push('audit');
  first.presentation.quick = { x: 42 };

  assert.equal(second.routes.quick.route.nodes[0].prompt.blocks[0].file, 'prompts/build.base.md');
  assert.equal(second.routes.quick.prompts['prompts/build.base.md'], 'Создай проверяемый результат.\n');
  assert.deepEqual(second.bootstrap.nodes[0].on.done.escalate.routes, ['quick']);
  assert.deepEqual(second.presentation, {});
});

test('RE-A0-03: публикация и чтение fixture сохраняют prompts и owned status', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-routes-editor-a0-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const input = makeCatalogInput();
  const store = new RoutesStore({ baseDir: path.join(root, 'routes') });
  const routeResult = await store.publishRoute(input.profile, 'quick', input.routes.quick);
  const catalogResult = await store.publishCatalog(input.profile, {
    catalog: {
      schema: 2,
      profile: input.profile,
      routes: { quick: routeResult.routeHash },
      bootstrap: { file: 'bootstrap/scout.json' },
    },
    bootstrap: input.bootstrap,
    prompts: input.bootstrapPrompts,
  }, { expectedCatalogHash: null });

  const route = await store.readRoute(input.profile, 'quick', routeResult.routeHash);
  const catalog = await store.readCatalog(input.profile, catalogResult.catalogHash);

  assert.deepEqual(route.prompts, input.routes.quick.prompts);
  assert.deepEqual(catalog.prompts, input.bootstrapPrompts);
  assert.deepEqual(route.route.nodes.find((node) => node.id === 'check_status'), {
    id: 'check_status',
    executor: 'status',
    phase: 'main',
    key: 'CHECK_STATUS',
    owner: 'check',
  });
  assert.deepEqual(catalog.bootstrap.escalation[0].allowedRoutes, ['quick']);
});
