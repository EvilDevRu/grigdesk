import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FactoryStateAdapter } from '../../server/src/adapters/factoryState.ts';
import { PrefsStore } from '../../server/src/lib/prefsStore.ts';
import projectsModule from '../../server/src/modules/projects/index.ts';
import { DraftStore } from '../../server/src/modules/routes/draftStore.ts';
import { RoutesPublicationCoordinator } from '../../server/src/modules/routes/publicationCoordinator.ts';
import { RoutesStore } from '../../server/src/modules/routes/store.ts';
import { makeCatalogInput } from '../fixtures/routes-editor.mjs';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-editor-consumers-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profilesDir = path.join(root, 'profiles');
  const profileDir = path.join(profilesDir, 'sample');
  const routesDir = path.join(root, 'routes');
  await fs.mkdir(path.join(profileDir, 'routes'), { recursive: true });
  await fs.writeFile(path.join(profileDir, 'graph.json'), '{}');
  await fs.writeFile(path.join(profileDir, 'routes', 'editor-capabilities.json'),
    JSON.stringify({ schema: 1, commands: [{ id: 'project-check', label: 'Проверка',
      filesystem: ['state-only'] }], contextSections: [] }));
  const store = new RoutesStore({ baseDir: routesDir });
  const draftStore = new DraftStore({ baseDir: path.join(root, 'authoring'), routesStore: store });
  const coordinator = new RoutesPublicationCoordinator(store, draftStore, profilesDir);
  const source = await store.switchEditorSource('sample', { mode: 'editor',
    expectedSourceRevision: 0, expectedCatalogHash: null });
  assert.equal(source.revision, 1);
  const adapter = new FactoryStateAdapter({ stateDir: path.join(root, 'state'),
    profilesDir, routesDir });
  const prefs = new PrefsStore({ prefsPath: path.join(root, 'prefs.json') });
  const app = Fastify({ logger: false });
  await app.register(projectsModule, { config: { factoryHome: root, profilesDir, routesDir }, prefs });
  await app.ready();
  t.after(() => app.close());
  let publicationNumber = 0;
  const publish = async (content, expectedCatalogHash = null) => {
    const draft = await draftStore.create('sample', {
      title: `Каталог ${publicationNumber + 1}`,
      baseCatalogHash: expectedCatalogHash,
      baseSourceRevision: 1,
      document: { routes: content.routes, bootstrap: content.bootstrap,
        bootstrapPrompts: content.bootstrapPrompts, presentation: {}, provenance: {} },
    });
    publicationNumber += 1;
    return coordinator.publish('sample', {
      draftId: draft.id, expectedRevision: draft.revision,
      expectedCatalogHash, expectedSourceRevision: 1,
      operationId: `22222222-2222-4222-8222-${String(publicationNumber).padStart(12, '0')}`,
    });
  };
  return { root, profileDir, routesDir, app, store, draftStore, adapter, publish, prefs };
}

function twoRoutes() {
  const content = makeCatalogInput();
  const audit = structuredClone(content.routes.quick);
  audit.route.id = 'audit';
  audit.route.title = 'Аудит';
  content.routes.audit = audit;
  content.bootstrap.nodes[0].on.done.escalate.routes = ['quick', 'audit'];
  content.bootstrap.escalation[0].allowedRoutes = ['quick', 'audit'];
  return content;
}

test('RE-H2-01/02/04: публикация меняет запуск и паспорт, но сохраняет историю и проект',
  async (t) => {
    const { app, adapter, store, publish, prefs } = await fixture(t);
    const before = (await app.inject({ method: 'GET', url: '/api/projects/sample' })).json();
    const v1 = await publish(twoRoutes());
    assert.equal(v1.state, 'committed');
    assert.deepEqual((await adapter.catalog('sample')).routes, ['audit', 'quick']);
    const projectV1 = (await app.inject({ method: 'GET', url: '/api/projects/sample' })).json();
    assert.deepEqual(projectV1.routes, ['audit', 'quick']);
    assert.deepEqual(projectV1.repos, before.repos);
    assert.equal(projectV1.revision, before.revision);

    const next = makeCatalogInput();
    const v2 = await publish(next, v1.toCatalogHash);
    assert.equal(v2.state, 'committed');
    assert.deepEqual((await adapter.catalog('sample')).routes, ['quick']);
    const projectV2 = (await app.inject({ method: 'GET', url: '/api/projects/sample' })).json();
    assert.deepEqual(projectV2.routes, ['quick']);
    assert.deepEqual(projectV2.repos, before.repos);
    assert.equal(projectV2.revision, before.revision);
    assert.deepEqual(prefs.readStored().projects ?? {}, {});

    const oldCatalog = await store.readCatalog('sample', v1.toCatalogHash);
    assert.ok(oldCatalog.catalog.routes.audit);
    assert.equal((await store.readRoute('sample', 'audit',
      oldCatalog.catalog.routes.audit)).route.title, 'Аудит');
    const pinned = await adapter.routeDef({ CATALOG_PROTOCOL: 'route-v2',
      PROFILE: 'sample', ROUTE: 'audit', ATTEMPT_ID: `a_${'1'.repeat(32)}`,
      ROUTE_HASH: oldCatalog.catalog.routes.audit,
      CATALOG_HASH: v1.toCatalogHash });
    assert.equal(pinned.route, 'audit');
  });

test('RE-H2-03: удаление routeId из literal policy блокируется до активации', async (t) => {
  const { profileDir, store, publish } = await fixture(t);
  const v1 = await publish(twoRoutes());
  const marker = path.join(profileDir, 'profile-was-executed');
  await fs.writeFile(path.join(profileDir, 'profile.sh'),
    `PROFILE_TRIAGE_ROUTES="feature:full=audit"\ntouch "${marker}"\n`);
  await assert.rejects(() => publish(makeCatalogInput(), v1.toCatalogHash),
    (error) => error?.code === 'routes_validation_failed'
      && error.details?.issues?.some((issue) => issue.code === 'external_route_dependency'
        && issue.routeId === 'audit'));
  assert.equal((await store.readCurrent('sample')).catalogHash, v1.toCatalogHash);
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
});
