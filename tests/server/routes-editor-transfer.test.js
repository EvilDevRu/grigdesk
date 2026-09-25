import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import routesModule from '../../server/src/modules/routes/index.ts';
import { RoutesStore } from '../../server/src/modules/routes/store.ts';
import { makeDraft } from '../fixtures/routes-editor.mjs';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

async function catalogHash(root, content) {
  const store = new RoutesStore({ baseDir: root });
  const routes = {};
  for (const [routeId, bundle] of Object.entries(content.routes)) {
    routes[routeId] = (await store.publishRoute('sample', routeId, bundle)).routeHash;
  }
  const published = await store.publishCatalog('sample', {
    catalog: { schema: 2, profile: 'sample', routes,
      bootstrap: { file: 'bootstrap/scout.json' } },
    bootstrap: content.bootstrap, prompts: content.bootstrapPrompts,
  }, { expectedCatalogHash: null });
  return published.catalogHash;
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-route-transfer-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = Fastify({ logger: false });
  await app.register(routesModule, {
    config: {
      routesDir: path.join(root, 'routes'),
      routesAuthoringDir: path.join(root, 'authoring'),
      profilesDir: path.join(root, 'profiles'),
    },
    prefs: {
      read: () => ({ projects: { sample: {}, target: {} } }),
      write: () => { throw new Error('transfer не пишет prefs'); },
    },
  });
  await app.ready();
  t.after(() => app.close());
  const draft = makeDraft();
  const created = await app.inject({ method: 'POST', url: '/api/routes/sample/drafts',
    payload: { kind: 'document', title: draft.title,
      baseCatalogHash: null, baseSourceRevision: 0,
      document: { routes: draft.routes, bootstrap: draft.bootstrap,
        bootstrapPrompts: draft.bootstrapPrompts, presentation: draft.presentation,
        provenance: draft.provenance },
    } });
  assert.equal(created.statusCode, 201);
  return { app, root, draft: created.json() };
}

test('RE-G4-01: полный JSON export/import создаёт новый editing draft с тем же content',
  async (t) => {
    const { app, root, draft } = await fixture(t);
    const exported = await app.inject({ method: 'GET',
      url: `/api/routes/sample/drafts/${draft.id}/transfer` });
    assert.equal(exported.statusCode, 200);
    const bundle = exported.json();
    assert.equal(bundle.format, 'cockpit-route-authoring');
    assert.equal(bundle.schema, 1);
    assert.equal(bundle.sourceProfile, 'sample');
    assert.deepEqual(bundle.dependencies, []);
    const imported = await app.inject({ method: 'POST',
      url: '/api/routes/sample/editor/import',
      payload: { title: 'Импортированный комплект', bundle } });
    assert.equal(imported.statusCode, 201);
    const copy = imported.json().draft;
    assert.notEqual(copy.id, draft.id);
    assert.equal(copy.revision, 1);
    assert.equal(copy.state, 'editing');
    assert.equal(copy.baseCatalogHash, null);
    assert.deepEqual({ routes: copy.routes, bootstrap: copy.bootstrap,
      bootstrapPrompts: copy.bootstrapPrompts, presentation: copy.presentation,
      provenance: copy.provenance }, bundle.content);
    const originalHash = await catalogHash(path.join(root, 'original-runtime'), bundle.content);
    const importedHash = await catalogHash(path.join(root, 'imported-runtime'), copy);
    assert.equal(importedHash, originalHash);
  });

test('RE-G4-02: другой профиль перепривязывает машины и заново проверяет команды',
  async (t) => {
    const { app, draft } = await fixture(t);
    const exported = await app.inject({ method: 'GET',
      url: `/api/routes/sample/drafts/${draft.id}/transfer` });
    assert.equal(exported.statusCode, 200);
    const imported = await app.inject({ method: 'POST',
      url: '/api/routes/target/editor/import',
      payload: { title: 'Перенесённый каталог', bundle: exported.json() } });
    assert.equal(imported.statusCode, 201);
    const copy = imported.json().draft;
    assert.equal(copy.profile, 'target');
    assert.equal(copy.bootstrap.profile, 'target');
    assert.equal(copy.routes.quick.route.profile, 'target');
    assert.equal(copy.baseCatalogHash, null);
    assert.equal(copy.baseSourceRevision, 0);
    assert.equal(copy.routes.quick.route.nodes.find((node) => node.id === 'check').commandId,
      'project-check');
    assert.ok(imported.json().issues.some((issue) => issue.code === 'command_unavailable'));
    assert.equal(Object.hasOwn(copy, 'sourceMode'), false);
    assert.equal(Object.hasOwn(copy, 'runners'), false);
  });

test('RE-G4-03: один маршрут перечисляет внешнюю цель без фиктивного маршрута',
  async (t) => {
    const { app, draft } = await fixture(t);
    const route = structuredClone(draft.routes.quick.route);
    const check = route.nodes.find((node) => node.id === 'check');
    check.on.failed = { escalate: { routes: ['audit'] } };
    route.escalation = [{ from: 'check', allowedRoutes: ['audit'],
      requiresHumanWhenPinned: true }];
    const changed = await app.inject({ method: 'PATCH',
      url: `/api/routes/sample/drafts/${draft.id}`, payload: {
        expectedRevision: 1,
        operations: [{ kind: 'putRoute', routeId: 'quick', route,
          prompts: draft.routes.quick.prompts }],
      } });
    assert.equal(changed.statusCode, 200);
    const exported = await app.inject({ method: 'GET',
      url: `/api/routes/sample/drafts/${draft.id}/transfer?routeId=quick` });
    assert.equal(exported.statusCode, 200);
    const bundle = exported.json();
    assert.deepEqual(Object.keys(bundle.content.routes), ['quick']);
    assert.deepEqual(bundle.dependencies, ['audit']);
    assert.equal(Object.hasOwn(bundle.content.routes, 'audit'), false);
    const imported = await app.inject({ method: 'POST',
      url: '/api/routes/target/editor/import',
      payload: { title: 'Один маршрут', bundle } });
    assert.equal(imported.statusCode, 201);
    assert.deepEqual(imported.json().unresolvedDependencies, ['audit']);
    assert.equal(Object.hasOwn(imported.json().draft.routes, 'audit'), false);
    const info = await app.inject({ method: 'GET', url: '/api/routes/target/editor' });
    assert.equal(info.statusCode, 200);
    assert.equal(info.json().currentCatalogHash, null);
  });

test('RE-G4-04: формат, лишние поля, traversal и большой файл отклоняются без исполнения',
  async (t) => {
    const { app, root, draft } = await fixture(t);
    const exported = await app.inject({ method: 'GET',
      url: `/api/routes/sample/drafts/${draft.id}/transfer` });
    const bundle = exported.json();
    const marker = path.join(root, 'would-execute');
    const literal = '$(' + `touch ${marker}` + ')';
    const variants = [
      { ...bundle, format: 'unknown' },
      { ...bundle, schema: 2 },
      { ...bundle, extra: true },
      { ...bundle, content: { ...bundle.content,
        routes: { ...bundle.content.routes, quick: {
          ...bundle.content.routes.quick,
          prompts: { 'prompts/../escape.md': 'опасный путь' },
        } },
      } },
    ];
    for (const [index, bad] of variants.entries()) {
      const response = await app.inject({ method: 'POST',
        url: '/api/routes/sample/editor/import',
        payload: { title: 'Недопустимый перенос', bundle: bad } });
      assert.equal(response.statusCode, 400,
        JSON.stringify({ index, response: response.json() }));
    }
    const valid = structuredClone(bundle);
    valid.content.routes.quick.prompts['prompts/build.base.md'] = literal;
    const imported = await app.inject({ method: 'POST',
      url: '/api/routes/sample/editor/import',
      payload: { title: 'Текстовый перенос', bundle: valid } });
    assert.equal(imported.statusCode, 201);
    assert.equal(imported.json().draft.routes.quick.prompts['prompts/build.base.md'], literal);
    await assert.rejects(fs.stat(marker), { code: 'ENOENT' });

    const huge = structuredClone(bundle);
    huge.content.routes.quick.prompts['prompts/build.base.md'] = 'x'.repeat(65 * 1024 * 1024);
    const oversized = await app.inject({ method: 'POST',
      url: '/api/routes/sample/editor/import',
      payload: { title: 'Слишком большой файл', bundle: huge } });
    assert.equal(oversized.statusCode, 413);
  });

test('RE-G4-05: совпавший routeId требует replace/rename, cancel не пишет revision',
  async (t) => {
    const { app, draft } = await fixture(t);
    const exported = await app.inject({ method: 'GET',
      url: `/api/routes/sample/drafts/${draft.id}/transfer?routeId=quick` });
    assert.equal(exported.statusCode, 200);
    const bundle = exported.json();
    bundle.content.routes.quick.prompts['prompts/build.base.md'] = 'Новая инструкция.\n';
    const url = `/api/routes/sample/drafts/${draft.id}/import`;
    const collision = await app.inject({ method: 'POST', url,
      payload: { expectedRevision: 1, bundle, collision: 'require-choice' } });
    assert.equal(collision.statusCode, 409);
    const cancelled = await app.inject({ method: 'POST', url,
      payload: { expectedRevision: 1, bundle, collision: 'cancel' } });
    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.json().cancelled, true);
    assert.equal(cancelled.json().draft.revision, 1);
    const afterCancel = await app.inject({ method: 'GET',
      url: `/api/routes/sample/drafts/${draft.id}` });
    assert.equal(afterCancel.json().revision, 1);

    const replaced = await app.inject({ method: 'POST', url,
      payload: { expectedRevision: 1, bundle, collision: 'replace' } });
    assert.equal(replaced.statusCode, 200);
    assert.equal(replaced.json().draft.revision, 2);
    assert.equal(replaced.json().draft.routes.quick.prompts['prompts/build.base.md'],
      'Новая инструкция.\n');
    const renamed = await app.inject({ method: 'POST', url,
      payload: { expectedRevision: 2, bundle, collision: 'rename', newRouteId: 'imported' } });
    assert.equal(renamed.statusCode, 200);
    assert.equal(renamed.json().draft.revision, 3);
    assert.equal(renamed.json().draft.routes.imported.route.id, 'imported');
    assert.equal(renamed.json().draft.routes.quick.route.id, 'quick');
  });
