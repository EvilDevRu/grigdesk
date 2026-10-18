import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DraftStore } from '../../server/src/modules/routes/draftStore.ts';
import { RoutesPublicationCoordinator } from '../../server/src/modules/routes/publicationCoordinator.ts';
import { RoutesStore } from '../../server/src/modules/routes/store.ts';
import { makeCatalogInput, makeDraft } from '../fixtures/routes-editor.mjs';

const PROFILE = 'sample';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-routes-upgrade-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const routesDir = path.join(root, 'routes');
  const authoringDir = path.join(root, 'authoring');
  const profilesDir = path.join(root, 'profiles');
  const profileDir = path.join(profilesDir, PROFILE);
  await fs.mkdir(path.join(profileDir, 'routes'), { recursive: true });
  await fs.writeFile(path.join(profileDir, 'graph.json'), '{}');
  await fs.writeFile(path.join(profileDir, 'routes', 'editor-capabilities.json'),
    JSON.stringify({ schema: 1, commands: [{ id: 'project-check',
      label: 'Проверка', filesystem: ['state-only'] }], contextSections: [] }));
  const instance = () => {
    const store = new RoutesStore({ baseDir: routesDir });
    const drafts = new DraftStore({ baseDir: authoringDir, routesStore: store });
    return { store, drafts,
      coordinator: new RoutesPublicationCoordinator(store, drafts, profilesDir) };
  };
  return { root, routesDir, authoringDir, instance };
}

async function scriptCatalog(store) {
  const input = makeCatalogInput();
  const routeHashes = {};
  for (const [routeId, bundle] of Object.entries(input.routes)) {
    routeHashes[routeId] = (await store.publishRoute(PROFILE, routeId, bundle)).routeHash;
  }
  return store.publishCatalog(PROFILE, {
    catalog: { schema: 2, profile: PROFILE, routes: routeHashes,
      bootstrap: { file: 'bootstrap/scout.json' } },
    bootstrap: input.bootstrap,
    prompts: input.bootstrapPrompts,
  }, { expectedCatalogHash: null });
}

test('RE-H3-03: новый экземпляр читает script-каталог без authoringDir и сохраняет source-mode',
  async (t) => {
    const { authoringDir, instance } = await fixture(t);
    const old = instance();
    const published = await scriptCatalog(old.store);
    await assert.rejects(fs.stat(authoringDir), { code: 'ENOENT' });

    const newer = instance();
    assert.equal((await newer.store.readCurrent(PROFILE)).catalogHash,
      published.catalogHash);
    assert.equal((await newer.store.readCatalog(PROFILE, published.catalogHash)).catalogHash,
      published.catalogHash);
    assert.deepEqual(await newer.store.readEditorSource(PROFILE),
      { mode: 'profile-script', revision: 0 });
    const repeated = await scriptCatalogOnCurrent(newer.store, published.catalogHash);
    assert.equal(repeated.catalogHash, published.catalogHash);
    await assert.rejects(fs.stat(authoringDir), { code: 'ENOENT' });

    await newer.store.switchEditorSource(PROFILE, {
      mode: 'editor', expectedSourceRevision: 0,
      expectedCatalogHash: published.catalogHash,
    });
    assert.deepEqual(await instance().store.readEditorSource(PROFILE),
      { mode: 'editor', revision: 1 });
  });

async function scriptCatalogOnCurrent(store, expectedCatalogHash) {
  const input = makeCatalogInput();
  const routeHashes = {};
  for (const [routeId, bundle] of Object.entries(input.routes)) {
    routeHashes[routeId] = (await store.publishRoute(PROFILE, routeId, bundle)).routeHash;
  }
  return store.publishCatalog(PROFILE, {
    catalog: { schema: 2, profile: PROFILE, routes: routeHashes,
      bootstrap: { file: 'bootstrap/scout.json' } },
    bootstrap: input.bootstrap, prompts: input.bootstrapPrompts,
  }, { expectedCatalogHash });
}

test('RE-H3-04: draft и receipt читаются новым экземпляром, pending CAS восстанавливается',
  async (t) => {
    const { instance } = await fixture(t);
    const first = instance();
    await first.store.switchEditorSource(PROFILE, {
      mode: 'editor', expectedSourceRevision: 0, expectedCatalogHash: null,
    });
    const value = makeDraft();
    const draft = await first.drafts.create(PROFILE, {
      title: 'Переживший обновление черновик', baseCatalogHash: null,
      baseSourceRevision: 1,
      document: { routes: value.routes, bootstrap: value.bootstrap,
        bootstrapPrompts: value.bootstrapPrompts, presentation: value.presentation,
        provenance: value.provenance },
    });
    const input = { draftId: draft.id, expectedRevision: draft.revision,
      expectedCatalogHash: null, expectedSourceRevision: 1,
      operationId: '44444444-4444-4444-8444-444444444444' };
    const second = instance();
    assert.deepEqual(await second.drafts.read(PROFILE, draft.id), draft);
    await assert.rejects(first.coordinator.publish(PROFILE, input, {
      afterActivation: async () => { throw new Error('обрыв после CAS'); },
    }), /обрыв после CAS/);
    assert.equal((await second.coordinator.journal.readIntent(PROFILE)).operationId,
      input.operationId);

    const third = instance();
    const recovered = await third.coordinator.status(PROFILE, input.operationId);
    assert.equal(recovered.state, 'committed');
    assert.equal(recovered.toCatalogHash,
      (await third.store.readCurrent(PROFILE)).catalogHash);
    assert.deepEqual(await third.coordinator.journal.readReceipt(PROFILE, input.operationId),
      recovered);
    assert.equal((await third.drafts.read(PROFILE, draft.id)).state, 'published');
    assert.deepEqual(await instance().coordinator.status(PROFILE, input.operationId),
      recovered);
  });

test('RE-H3-04: неизвестная версия authoring-файла отвергается без миграции',
  async (t) => {
    const { authoringDir, instance } = await fixture(t);
    const first = instance();
    const value = makeDraft();
    const draft = await first.drafts.create(PROFILE, {
      title: 'Старая версия', baseCatalogHash: null, baseSourceRevision: 0,
      document: { routes: value.routes, bootstrap: value.bootstrap,
        bootstrapPrompts: value.bootstrapPrompts, presentation: value.presentation,
        provenance: value.provenance },
    });
    const file = path.join(authoringDir, PROFILE, 'drafts', `${draft.id}.json`);
    const unknown = { ...JSON.parse(await fs.readFile(file, 'utf8')), schema: 99 };
    const bytes = JSON.stringify(unknown);
    await fs.writeFile(file, bytes);
    await assert.rejects(instance().drafts.read(PROFILE, draft.id),
      { code: 'routes_authoring_corrupted' });
    assert.equal(await fs.readFile(file, 'utf8'), bytes);
  });
