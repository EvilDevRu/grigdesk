import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { makeDraft } from '../fixtures/routes-editor.mjs';
import routesModule from '../../server/src/modules/routes/index.ts';
import { RoutesStore } from '../../server/src/modules/routes/store.ts';
import { prepareDraftCatalog } from '../../server/src/modules/routes/publicationService.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-routes-rebase-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const routesDir = path.join(root, 'routes');
  const profilesDir = path.join(root, 'profiles');
  const profileDir = path.join(profilesDir, 'sample');
  await fs.mkdir(path.join(profileDir, 'routes'), { recursive: true });
  await fs.writeFile(path.join(profileDir, 'graph.json'), '{}');
  await fs.writeFile(path.join(profileDir, 'routes', 'editor-capabilities.json'),
    JSON.stringify({ schema: 1, commands: [{ id: 'project-check', label: 'Проверка',
      filesystem: ['state-only'] }], contextSections: [] }));
  const store = new RoutesStore({ baseDir: routesDir });
  const base = makeDraft();
  const prepared = await prepareDraftCatalog(store, base);
  await store.compareAndSwapCurrent('sample', prepared.catalogHash,
    { expectedCatalogHash: null });
  const app = Fastify({ logger: false });
  await app.register(routesModule, { config: {
    routesDir, routesAuthoringDir: path.join(root, 'authoring'), profilesDir,
  }, prefs: { read: () => ({ projects: { sample: {} } }), write: () => {} } });
  await app.ready();
  t.after(() => app.close());
  const created = await app.inject({ method: 'POST', url: '/api/routes/sample/drafts',
    payload: { kind: 'catalog', title: 'Перенос', catalogHash: prepared.catalogHash } });
  assert.equal(created.statusCode, 201);
  return { root, app, store, base, baseHash: prepared.catalogHash, draft: created.json() };
}

async function publishCurrent(store, baseHash, mutate) {
  const current = makeDraft();
  mutate(current);
  const prepared = await prepareDraftCatalog(store, current);
  await store.compareAndSwapCurrent('sample', prepared.catalogHash,
    { expectedCatalogHash: baseHash });
  return prepared.catalogHash;
}

test('RE-G2-01: мой quick и чужой audit объединяются без потери изменений', async (t) => {
  const { app, store, baseHash, draft } = await fixture(t);
  const edited = structuredClone(draft.routes.quick);
  edited.prompts['prompts/build.base.md'] = 'Моя инструкция.\n';
  const patched = await app.inject({ method: 'PATCH',
    url: `/api/routes/sample/drafts/${draft.id}`,
    payload: { expectedRevision: draft.revision,
      operations: [{ kind: 'putRoute', routeId: 'quick', ...edited }] } });
  assert.equal(patched.statusCode, 200);
  const currentHash = await publishCurrent(store, baseHash, (next) => {
    next.routes.audit = structuredClone(next.routes.quick);
    next.routes.audit.route.id = 'audit';
    next.routes.audit.route.title = 'Аудит';
  });
  const rebased = await app.inject({ method: 'POST',
    url: `/api/routes/sample/drafts/${draft.id}/rebase`,
    payload: { expectedDraftRevision: 2, expectedCatalogHash: currentHash,
      resolutions: [] } });
  assert.equal(rebased.statusCode, 200);
  assert.equal(rebased.json().revision, 3);
  assert.equal(rebased.json().baseCatalogHash, currentHash);
  assert.equal(rebased.json().routes.quick.prompts['prompts/build.base.md'],
    'Моя инструкция.\n');
  assert.equal(rebased.json().routes.audit.route.title, 'Аудит');
  assert.equal((await store.readCurrent('sample')).catalogHash, currentHash);
});

test('RE-G2-02: две правки quick требуют выбора всего маршрута с промптами', async (t) => {
  for (const choice of ['mine', 'current']) {
    await t.test(choice, async (caseT) => {
      const { app, store, baseHash, draft } = await fixture(caseT);
      const edited = structuredClone(draft.routes.quick);
      edited.route.title = 'Мой quick';
      edited.prompts['prompts/build.base.md'] = 'Мой текст.\n';
      const patched = await app.inject({ method: 'PATCH',
        url: `/api/routes/sample/drafts/${draft.id}`,
        payload: { expectedRevision: 1,
          operations: [{ kind: 'putRoute', routeId: 'quick', ...edited }] } });
      assert.equal(patched.statusCode, 200);
      const currentHash = await publishCurrent(store, baseHash, (next) => {
        next.routes.quick.route.title = 'Серверный quick';
        next.routes.quick.prompts['prompts/build.base.md'] = 'Серверный текст.\n';
      });
      const preview = await app.inject({ method: 'GET',
        url: `/api/routes/sample/drafts/${draft.id}/rebase/preview` });
      assert.equal(preview.statusCode, 200);
      assert.equal(preview.json().conflicts.length, 1);
      assert.equal(preview.json().conflicts[0].routeId, 'quick');
      assert.equal(preview.json().conflicts[0].mine.prompts['prompts/build.base.md'],
        'Мой текст.\n');
      assert.equal(preview.json().conflicts[0].current.prompts['prompts/build.base.md'],
        'Серверный текст.\n');
      const unresolved = await app.inject({ method: 'POST',
        url: `/api/routes/sample/drafts/${draft.id}/rebase`,
        payload: { expectedDraftRevision: 2, expectedCatalogHash: currentHash,
          resolutions: [] } });
      assert.equal(unresolved.statusCode, 409);
      assert.equal(unresolved.json().conflicts[0].routeId, 'quick');
      const unknownField = await app.inject({ method: 'POST',
        url: `/api/routes/sample/drafts/${draft.id}/rebase`,
        payload: { expectedDraftRevision: 2, expectedCatalogHash: currentHash,
          resolutions: [{ scope: 'route', routeId: 'quick', choice,
            extra: 'неизвестное поле' }] } });
      assert.equal(unknownField.statusCode, 400);
      const before = await app.inject({ method: 'GET',
        url: `/api/routes/sample/drafts/${draft.id}` });
      assert.equal(before.json().revision, 2);
      const resolved = await app.inject({ method: 'POST',
        url: `/api/routes/sample/drafts/${draft.id}/rebase`,
        payload: { expectedDraftRevision: 2, expectedCatalogHash: currentHash,
          resolutions: [{ scope: 'route', routeId: 'quick', choice }] } });
      assert.equal(resolved.statusCode, 200);
      assert.equal(resolved.json().routes.quick.route.title,
        choice === 'mine' ? 'Мой quick' : 'Серверный quick');
      assert.equal(resolved.json().routes.quick.prompts['prompts/build.base.md'],
        choice === 'mine' ? 'Мой текст.\n' : 'Серверный текст.\n');
    });
  }
});

test('RE-G2-03: удаление против правки и bootstrap разрешаются независимо', async (t) => {
  const { app, store, baseHash, draft } = await fixture(t);
  const localBootstrap = structuredClone(draft.bootstrap);
  const localPrompts = structuredClone(draft.bootstrapPrompts);
  localPrompts['bootstrap/prompts/scout.base.md'] = 'Моя разведка.\n';
  const patched = await app.inject({ method: 'PATCH',
    url: `/api/routes/sample/drafts/${draft.id}`,
    payload: { expectedRevision: 1, operations: [
      { kind: 'removeRoute', routeId: 'quick' },
      { kind: 'putBootstrap', bootstrap: localBootstrap, prompts: localPrompts },
    ] } });
  assert.equal(patched.statusCode, 200);
  const currentHash = await publishCurrent(store, baseHash, (next) => {
    next.routes.quick.route.title = 'Чужая правка';
    next.bootstrapPrompts['bootstrap/prompts/scout.base.md'] = 'Чужая разведка.\n';
  });
  const unresolved = await app.inject({ method: 'POST',
    url: `/api/routes/sample/drafts/${draft.id}/rebase`,
    payload: { expectedDraftRevision: 2, expectedCatalogHash: currentHash,
      resolutions: [] } });
  assert.equal(unresolved.statusCode, 409);
  assert.deepEqual(unresolved.json().conflicts.map(({ scope, routeId }) => [scope, routeId]), [
    ['route', 'quick'], ['bootstrap', null],
  ]);
  const resolved = await app.inject({ method: 'POST',
    url: `/api/routes/sample/drafts/${draft.id}/rebase`,
    payload: { expectedDraftRevision: 2, expectedCatalogHash: currentHash,
      resolutions: [
        { scope: 'route', routeId: 'quick', choice: 'mine' },
        { scope: 'bootstrap', routeId: null, choice: 'current' },
      ] } });
  assert.equal(resolved.statusCode, 200);
  assert.equal(Object.hasOwn(resolved.json().routes, 'quick'), false);
  assert.equal(resolved.json().bootstrapPrompts['bootstrap/prompts/scout.base.md'],
    'Чужая разведка.\n');
});

test('RE-G2-04: смена current или draft после preview даёт 409 без частичного merge',
  async (t) => {
    const { app, store, baseHash, draft } = await fixture(t);
    const firstHash = await publishCurrent(store, baseHash, (next) => {
      next.routes.quick.route.title = 'Первый current';
    });
    const preview = await app.inject({ method: 'GET',
      url: `/api/routes/sample/drafts/${draft.id}/rebase/preview` });
    assert.equal(preview.statusCode, 200);
    assert.equal(preview.json().currentCatalogHash, firstHash);
    const secondHash = await publishCurrent(store, firstHash, (next) => {
      next.routes.quick.route.title = 'Второй current';
    });
    const staleCurrent = await app.inject({ method: 'POST',
      url: `/api/routes/sample/drafts/${draft.id}/rebase`,
      payload: { expectedDraftRevision: 1, expectedCatalogHash: firstHash,
        resolutions: [] } });
    assert.equal(staleCurrent.statusCode, 409);
    assert.equal(staleCurrent.json().currentCatalogHash, secondHash);
    const newerPreview = await app.inject({ method: 'GET',
      url: `/api/routes/sample/drafts/${draft.id}/rebase/preview` });
    assert.equal(newerPreview.statusCode, 200);
    const patched = await app.inject({ method: 'PATCH',
      url: `/api/routes/sample/drafts/${draft.id}`,
      payload: { expectedRevision: 1,
        operations: [{ kind: 'setTitle', title: 'Новая локальная версия' }] } });
    assert.equal(patched.statusCode, 200);
    const staleDraft = await app.inject({ method: 'POST',
      url: `/api/routes/sample/drafts/${draft.id}/rebase`,
      payload: { expectedDraftRevision: 1, expectedCatalogHash: secondHash,
        resolutions: [] } });
    assert.equal(staleDraft.statusCode, 409);
    assert.equal(staleDraft.json().currentRevision, 2);
    const after = await app.inject({ method: 'GET',
      url: `/api/routes/sample/drafts/${draft.id}` });
    assert.equal(after.json().revision, 2);
    assert.equal(after.json().baseCatalogHash, baseHash);
    assert.equal((await store.readCurrent('sample')).catalogHash, secondHash);
  });

test('RE-G2-05: rebase обновляет основание, пересчитывает ссылки и не двигает current',
  async (t) => {
    const { app, store, baseHash, draft } = await fixture(t);
    const bootstrap = structuredClone(draft.bootstrap);
    bootstrap.escalation[0].allowedRoutes = ['audit'];
    const patched = await app.inject({ method: 'PATCH',
      url: `/api/routes/sample/drafts/${draft.id}`,
      payload: { expectedRevision: 1, operations: [{ kind: 'putBootstrap', bootstrap,
        prompts: draft.bootstrapPrompts }] } });
    assert.equal(patched.statusCode, 200);
    const currentHash = await publishCurrent(store, baseHash, (next) => {
      next.routes.quick.route.title = 'Чужое название';
    });
    const rebased = await app.inject({ method: 'POST',
      url: `/api/routes/sample/drafts/${draft.id}/rebase`,
      payload: { expectedDraftRevision: 2, expectedCatalogHash: currentHash,
        resolutions: [] } });
    assert.equal(rebased.statusCode, 200);
    assert.equal(rebased.json().revision, 3);
    assert.equal(rebased.json().baseCatalogHash, currentHash);
    assert.deepEqual(rebased.json().bootstrap.escalation[0].allowedRoutes, ['audit']);
    assert.equal(rebased.json().routes.quick.route.title, 'Чужое название');
    const checked = await app.inject({ method: 'POST',
      url: `/api/routes/sample/drafts/${draft.id}/validate`, payload: {} });
    assert.equal(checked.statusCode, 200);
    assert.equal(checked.json().draftRevision, 3);
    assert.ok(checked.json().issues.some((issue) => issue.code === 'route_reference_missing'));
    assert.equal((await store.readCurrent('sample')).catalogHash, currentHash);
  });
