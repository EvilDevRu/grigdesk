import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { makeCatalogInput, makeDraft } from '../fixtures/routes-editor.mjs';
import { compareCatalogDocuments } from '../../server/src/modules/routes/compare.ts';
import * as compareModule from '../../server/src/modules/routes/compare.ts';
import routesModule from '../../server/src/modules/routes/index.ts';
import { RoutesStore } from '../../server/src/modules/routes/store.ts';
import { prepareDraftCatalog } from '../../server/src/modules/routes/publicationService.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

test('RE-E6-02: compare показывает before/after инструкции и политики целого маршрута', () => {
  const beforeInput = makeCatalogInput();
  const before = { ...beforeInput, presentation: {}, provenance: {} };
  const after = makeDraft();
  after.routes.quick.prompts['prompts/build.base.md'] = 'Новая инструкция.\n';
  after.routes.quick.route.nodes[0].policy.filesystem = 'workspace';
  const changes = compareCatalogDocuments(before, after);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].scope, 'route');
  assert.equal(changes[0].routeId, 'quick');
  assert.equal(changes[0].before.prompts['prompts/build.base.md'],
    'Создай проверяемый результат.\n');
  assert.equal(changes[0].after.prompts['prompts/build.base.md'], 'Новая инструкция.\n');
  assert.equal(changes[0].before.route.nodes[0].policy.filesystem, 'state-only');
  assert.equal(changes[0].after.route.nodes[0].policy.filesystem, 'workspace');
});

test('RE-G1-01: структурное сравнение адресует маршруты, порядок, переходы и Markdown', () => {
  const before = makeDraft();
  const after = structuredClone(before);
  after.routes.audit = structuredClone(after.routes.quick);
  after.routes.audit.route.id = 'audit';
  after.routes.quick.route.sequence.main.reverse();
  after.routes.quick.route.nodes[0].policy.filesystem = 'workspace';
  after.routes.quick.route.nodes[0].on.failed = { next: 'gate_accept' };
  after.routes.quick.prompts['prompts/build.base.md'] = 'Новый текст.\n';
  after.bootstrap.nodes[0].label = 'Новый Scout';
  const changes = compareCatalogDocuments(before, after);
  assert.deepEqual(changes.map(({ scope, routeId, kind }) => ({ scope, routeId, kind })), [
    { scope: 'bootstrap', routeId: null, kind: 'changed' },
    { scope: 'route', routeId: 'audit', kind: 'added' },
    { scope: 'route', routeId: 'quick', kind: 'changed' },
  ]);
  const fields = changes.find((change) => change.routeId === 'quick').fields;
  assert.ok(fields.some((field) => field.path.includes('/sequence/')));
  assert.ok(fields.some((field) => field.path.endsWith('/policy/filesystem')));
  assert.ok(fields.some((field) => field.path.endsWith('/on/failed/next')));
  assert.ok(fields.some((field) => field.path.endsWith('/prompts/prompts~1build.base.md')
    && field.before === 'Создай проверяемый результат.\n'
    && field.after === 'Новый текст.\n'));
  assert.ok(changes[0].fields.some((field) => field.path.endsWith('/label')));
});

test('RE-G1-02: порядок ключей незначим; массивы и presentation различаются', () => {
  const before = makeDraft();
  const after = structuredClone(before);
  after.routes.quick = Object.fromEntries(Object.entries(after.routes.quick).reverse());
  after.routes.quick.route = Object.fromEntries(
    Object.entries(after.routes.quick.route).reverse(),
  );
  assert.deepEqual(compareCatalogDocuments(before, after), []);
  after.routes.quick.route.nodes[0].prompt.blocks.reverse();
  assert.ok(compareCatalogDocuments(before, after)[0].fields.some(
    (field) => field.path.includes('/prompt/blocks/0'),
  ));
  after.routes.quick.route.nodes[0].prompt.blocks.reverse();
  after.presentation = { quick: { build: { x: 25, y: 12 } } };
  assert.deepEqual(compareCatalogDocuments(before, after), []);
  assert.equal(typeof compareModule.comparePresentation, 'function');
  assert.ok(compareModule.comparePresentation(before, after).some(
    (field) => field.path === '/quick' && field.after.build.x === 25,
  ));
});

test('RE-E6-02: GET compare привязывает изменения к exact current и source revision',
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-routes-compare-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const routesDir = path.join(root, 'routes');
    const profilesDir = path.join(root, 'profiles');
    const profileRoutes = path.join(profilesDir, 'sample', 'routes');
    await fs.mkdir(profileRoutes, { recursive: true });
    await fs.writeFile(path.join(profilesDir, 'sample', 'graph.json'), '{}');
    await fs.writeFile(path.join(profileRoutes, 'editor-capabilities.json'), JSON.stringify({
      schema: 1, commands: [{ id: 'project-check', label: 'Проверка',
        filesystem: ['state-only'] }], contextSections: [],
    }));
    const store = new RoutesStore({ baseDir: routesDir });
    const baseline = makeDraft();
    const prepared = await prepareDraftCatalog(store, baseline);
    await store.compareAndSwapCurrent('sample', prepared.catalogHash,
      { expectedCatalogHash: null });
    const app = Fastify({ logger: false });
    await app.register(routesModule, { config: {
      routesDir, routesAuthoringDir: path.join(root, 'authoring'), profilesDir,
    }, prefs: { read: () => ({ projects: { sample: {} } }), write: () => {} } });
    await app.ready();
    t.after(() => app.close());
    const edited = makeDraft();
    edited.routes.quick.prompts['prompts/build.base.md'] = 'После сравнения.\n';
    const created = await app.inject({ method: 'POST', url: '/api/routes/sample/drafts',
      payload: { kind: 'document', title: 'Сравнение',
        baseCatalogHash: prepared.catalogHash, baseSourceRevision: 0,
        document: { routes: edited.routes, bootstrap: edited.bootstrap,
          bootstrapPrompts: edited.bootstrapPrompts, presentation: {}, provenance: {} } } });
    assert.equal(created.statusCode, 201);
    const compared = await app.inject({ method: 'GET',
      url: `/api/routes/sample/drafts/${created.json().id}/compare` });
    assert.equal(compared.statusCode, 200);
    assert.equal(compared.json().currentCatalogHash, prepared.catalogHash);
    assert.equal(compared.json().draftRevision, 1);
    assert.equal(compared.json().sourceRevision, 0);
    assert.equal(compared.json().changes.length, 1);
    assert.equal(compared.json().changes[0].before.prompts['prompts/build.base.md'],
      'Создай проверяемый результат.\n');
    assert.equal(compared.json().changes[0].after.prompts['prompts/build.base.md'],
      'После сравнения.\n');
  });

test('RE-G1-03: история сравнивает exact hashes и копирует не-current в новый draft', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-routes-history-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const routesDir = path.join(root, 'routes');
  const profilesDir = path.join(root, 'profiles');
  const profileRoutes = path.join(profilesDir, 'sample', 'routes');
  await fs.mkdir(profileRoutes, { recursive: true });
  await fs.writeFile(path.join(profilesDir, 'sample', 'graph.json'), '{}');
  const store = new RoutesStore({ baseDir: routesDir });
  const oldDraft = makeDraft();
  const oldPrepared = await prepareDraftCatalog(store, oldDraft);
  await store.compareAndSwapCurrent('sample', oldPrepared.catalogHash,
    { expectedCatalogHash: null });
  const oldCatalogFile = path.join(routesDir, 'sample', 'catalog', 'revisions',
    oldPrepared.catalogHash, 'catalog.json');
  const originalBytes = await fs.readFile(oldCatalogFile);
  const newer = makeDraft();
  newer.routes.quick.prompts['prompts/build.base.md'] = 'Вторая ревизия.\n';
  const newPrepared = await prepareDraftCatalog(store, newer);
  await store.compareAndSwapCurrent('sample', newPrepared.catalogHash,
    { expectedCatalogHash: oldPrepared.catalogHash });
  const app = Fastify({ logger: false });
  await app.register(routesModule, { config: {
    routesDir, routesAuthoringDir: path.join(root, 'authoring'), profilesDir,
  }, prefs: { read: () => ({ projects: { sample: {} } }), write: () => {} } });
  await app.ready();
  t.after(() => app.close());
  const compared = await app.inject({ method: 'GET',
    url: `/api/routes/sample/editor/revisions/compare?from=${oldPrepared.catalogHash}`
      + `&to=${newPrepared.catalogHash}` });
  assert.equal(compared.statusCode, 200);
  assert.equal(compared.json().fromCatalogHash, oldPrepared.catalogHash);
  assert.equal(compared.json().toCatalogHash, newPrepared.catalogHash);
  assert.equal(compared.json().changes[0].after.prompts['prompts/build.base.md'],
    'Вторая ревизия.\n');
  const created = await app.inject({ method: 'POST', url: '/api/routes/sample/drafts',
    payload: { kind: 'catalog', title: 'Историческая версия',
      catalogHash: oldPrepared.catalogHash } });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().routes.quick.prompts['prompts/build.base.md'],
    'Создай проверяемый результат.\n');
  assert.equal(created.json().baseCatalogHash, oldPrepared.catalogHash);
  assert.deepEqual(await fs.readFile(oldCatalogFile), originalBytes);
});

test('RE-G1-04: повреждённая ревизия остаётся в списке с integrity-кодом', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-routes-damaged-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new RoutesStore({ baseDir: root });
  const prepared = await prepareDraftCatalog(store, makeDraft());
  await store.compareAndSwapCurrent('sample', prepared.catalogHash,
    { expectedCatalogHash: null });
  const file = path.join(root, 'sample', 'catalog', 'revisions',
    prepared.catalogHash, 'catalog.json');
  await fs.writeFile(file, '{"damaged":true}\n');
  const listed = await store.listCatalogRevisions('sample');
  assert.equal(listed.currentCatalogHash, prepared.catalogHash);
  assert.equal(listed.revisions.length, 1);
  assert.equal(listed.revisions[0].catalogHash, prepared.catalogHash);
  assert.equal(listed.revisions[0].routes, null);
  assert.notEqual(listed.revisions[0].integrity, 'ok');
});
