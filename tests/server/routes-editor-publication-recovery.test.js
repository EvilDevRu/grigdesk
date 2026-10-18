import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DraftStore } from '../../server/src/modules/routes/draftStore.ts';
import { RoutesPublicationCoordinator } from '../../server/src/modules/routes/publicationCoordinator.ts';
import { prepareDraftCatalog } from '../../server/src/modules/routes/publicationService.ts';
import { RoutesStore, serializeRoutesJson } from '../../server/src/modules/routes/store.ts';
import { makeDraft } from '../fixtures/routes-editor.mjs';

const CHILD = fileURLToPath(new URL('./fixtures/routes-publication-child.mjs', import.meta.url));
const OPERATION = '77777777-7777-4777-8777-777777777777';

async function fixture(t, { baseline = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-routes-recovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profilesDir = path.join(root, 'profiles');
  const profileDir = path.join(profilesDir, 'sample');
  await fs.mkdir(path.join(profileDir, 'routes'), { recursive: true });
  await fs.writeFile(path.join(profileDir, 'graph.json'), '{}');
  await fs.writeFile(path.join(profileDir, 'routes', 'editor-capabilities.json'),
    JSON.stringify({ schema: 1, commands: [{
      id: 'project-check', label: 'Проверка', filesystem: ['state-only'],
    }], contextSections: [] }));
  const routesDir = path.join(root, 'routes');
  const authoringDir = path.join(root, 'authoring');
  const store = new RoutesStore({ baseDir: routesDir });
  const drafts = new DraftStore({ baseDir: authoringDir, routesStore: store });
  let baseHash = null;
  if (baseline) {
    const earlier = makeDraft();
    earlier.routes.quick.route.title = 'Каталог до аварийной публикации';
    baseHash = (await prepareDraftCatalog(store, earlier)).catalogHash;
    await store.compareAndSwapCurrent('sample', baseHash, { expectedCatalogHash: null });
  }
  await store.switchEditorSource('sample', {
    mode: 'editor', expectedSourceRevision: 0, expectedCatalogHash: baseHash,
  });
  const value = makeDraft();
  const draft = await drafts.create('sample', {
    title: 'Аварийная публикация', baseCatalogHash: baseHash, baseSourceRevision: 1,
    document: {
      routes: value.routes, bootstrap: value.bootstrap,
      bootstrapPrompts: value.bootstrapPrompts,
      presentation: value.presentation, provenance: value.provenance,
    },
  });
  const input = {
    draftId: draft.id, expectedRevision: draft.revision,
    expectedCatalogHash: baseHash, expectedSourceRevision: 1, operationId: OPERATION,
  };
  const coordinator = new RoutesPublicationCoordinator(store, drafts, profilesDir);
  const configFile = path.join(root, 'child-config.json');
  await fs.writeFile(configFile, JSON.stringify({
    profile: 'sample', routesDir, authoringDir, profilesDir, input,
  }));
  return { root, routesDir, authoringDir, profilesDir, store, drafts, draft, baseHash,
    input, coordinator, configFile };
}

async function stopAtBarrier(t, configFile, stage) {
  const child = spawn(process.execPath, [CHILD, configFile, stage], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const barrier = await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`Нет барьера ${stage}: ${stderr}`)), 30000);
    const done = (error, message) => {
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve(message);
    };
    child.on('message', (message) => {
      if (message?.type === 'barrier') done(null, message);
      else done(new Error(`Child не достиг барьера: ${JSON.stringify(message)} ${stderr}`));
    });
    child.once('error', (error) => done(error));
    child.once('exit', (code, signal) => done(new Error(
      `Child завершился до барьера: ${code}/${signal} ${stderr}`,
    )));
  });
  assert.equal(barrier.stage, stage);
  const exited = new Promise((resolve) => child.once('exit', resolve));
  assert.equal(child.kill('SIGKILL'), true);
  await exited;
  assert.equal(child.signalCode, 'SIGKILL');
}

test('RE-D5-01: crash после intent до CAS восстанавливается как aborted', async (t) => {
  const { root, routesDir, authoringDir, profilesDir, store, draft, input, configFile } =
    await fixture(t);
  await stopAtBarrier(t, configFile, 'afterIntent');
  const pending = path.join(root, 'routes', 'sample', 'catalog', 'editor-pending.json');
  assert.equal(JSON.parse(await fs.readFile(pending, 'utf8')).operationId, OPERATION);
  assert.equal(await store.readCurrent('sample'), null);

  const anotherStore = new RoutesStore({ baseDir: routesDir });
  const anotherDrafts = new DraftStore({ baseDir: authoringDir, routesStore: anotherStore });
  const another = new RoutesPublicationCoordinator(anotherStore, anotherDrafts, profilesDir);
  const receipt = await another.publish('sample', input);
  assert.equal(receipt.state, 'aborted');
  assert.equal(receipt.currentChanged, false);
  assert.equal(await anotherStore.readCurrent('sample'), null);
  assert.equal((await anotherDrafts.read('sample', draft.id)).state, 'editing');
  await assert.rejects(fs.stat(pending), { code: 'ENOENT' });
  assert.deepEqual(await another.journal.readReceipt('sample', OPERATION), receipt);
});

test('RE-D5-02: crash после CAS до receipt восстанавливается без второго CAS', async (t) => {
  const { root, routesDir, authoringDir, profilesDir, input, configFile } = await fixture(t);
  await stopAtBarrier(t, configFile, 'afterActivation');
  const pointerFile = path.join(root, 'routes', 'sample', 'catalog', 'current.json');
  const before = await fs.stat(pointerFile);
  const expectedHash = JSON.parse(await fs.readFile(pointerFile, 'utf8')).catalogHash;
  const anotherStore = new RoutesStore({ baseDir: routesDir });
  const anotherDrafts = new DraftStore({ baseDir: authoringDir, routesStore: anotherStore });
  const another = new RoutesPublicationCoordinator(anotherStore, anotherDrafts, profilesDir);
  const receipt = await another.publish('sample', input);
  assert.equal(receipt.state, 'committed');
  assert.equal(receipt.currentChanged, true);
  assert.equal(receipt.toCatalogHash, expectedHash);
  assert.equal((await fs.stat(pointerFile)).ino, before.ino);
  assert.deepEqual(await another.publish('sample', input), receipt);
  assert.equal((await fs.stat(pointerFile)).ino, before.ino);
});

test('RE-D5-03: receipt после crash закрывает draft и переживает rollback', async (t) => {
  const { root, routesDir, authoringDir, profilesDir, draft, baseHash, input, configFile } =
    await fixture(t, { baseline: true });
  await stopAtBarrier(t, configFile, 'afterReceipt');
  const rawFile = path.join(authoringDir, 'sample', 'drafts', `${draft.id}.json`);
  assert.equal(JSON.parse(await fs.readFile(rawFile, 'utf8')).state, 'editing');

  const anotherStore = new RoutesStore({ baseDir: routesDir });
  const anotherDrafts = new DraftStore({ baseDir: authoringDir, routesStore: anotherStore });
  const another = new RoutesPublicationCoordinator(anotherStore, anotherDrafts, profilesDir);
  const receipt = await another.journal.readReceipt('sample', OPERATION);
  assert.equal(receipt.state, 'committed');
  assert.deepEqual(await another.publish('sample', input), receipt);
  assert.equal(await another.journal.readIntent('sample'), null);
  assert.equal((await anotherDrafts.read('sample', draft.id)).state, 'published');
  assert.deepEqual((await anotherDrafts.read('sample', draft.id)).publication, receipt);
  assert.equal((await anotherDrafts.list('sample')).drafts[0].state, 'published');
  await assert.rejects(anotherDrafts.patch('sample', draft.id, {
    expectedRevision: draft.revision,
    operations: [{ kind: 'setTitle', title: 'Нельзя изменить' }],
  }), { code: 'routes_draft_closed' });
  await anotherStore.compareAndSwapCurrent('sample', baseHash, {
    expectedCatalogHash: receipt.toCatalogHash,
  });
  assert.equal((await anotherStore.readCurrent('sample')).catalogHash, baseHash);
  assert.deepEqual(await another.publish('sample', input), receipt);
  assert.equal((await anotherStore.readCurrent('sample')).catalogHash, baseHash);
});

test('RE-D5-04: rollback writer сначала восстанавливает pending intent', async (t) => {
  const { store, coordinator, baseHash, configFile } = await fixture(t, { baseline: true });
  const alternate = makeDraft();
  alternate.routes.quick.route.title = 'Третий каталог после обрыва';
  const thirdHash = (await prepareDraftCatalog(store, alternate)).catalogHash;
  await stopAtBarrier(t, configFile, 'afterIntent');
  const switched = await store.compareAndSwapCurrent('sample', thirdHash, {
    expectedCatalogHash: baseHash,
  });
  assert.equal(switched.changed, true);
  assert.equal((await store.readCurrent('sample')).catalogHash, thirdHash);
  const receipt = await coordinator.journal.readReceipt('sample', OPERATION);
  assert.equal(receipt.state, 'aborted');
  assert.equal(receipt.fromCatalogHash, baseHash);
  assert.notEqual(thirdHash, receipt.toCatalogHash);
});

test('RE-D5-05: неизвестный внешний current не исправляется восстановлением', async (t) => {
  const { root, store, coordinator, baseHash, configFile } =
    await fixture(t, { baseline: true });
  const external = makeDraft();
  external.routes.quick.route.title = 'Внешний каталог вне протокола';
  const externalHash = (await prepareDraftCatalog(store, external)).catalogHash;
  await stopAtBarrier(t, configFile, 'afterIntent');
  const pointer = path.join(root, 'routes', 'sample', 'catalog', 'current.json');
  await fs.writeFile(pointer, serializeRoutesJson({ schema: 2, catalogHash: externalHash }));
  await assert.rejects(store.compareAndSwapCurrent('sample', baseHash, {
    expectedCatalogHash: externalHash,
  }), { code: 'routes_recovery_conflict' });
  assert.equal((await store.readCurrent('sample')).catalogHash, externalHash);
  assert.equal(await coordinator.journal.readReceipt('sample', OPERATION), null);
  assert.equal((await coordinator.journal.readIntent('sample')).operationId, OPERATION);
});

test('RE-D5-06: после crash lock свободен, повторный захват из callback отвергнут',
  { timeout: 10000 }, async (t) => {
    const { store, coordinator, configFile } = await fixture(t);
    await stopAtBarrier(t, configFile, 'afterIntent');
    await assert.rejects(store.withProfileMutation('sample',
      async () => store.withProfileMutation('sample', async () => 'недостижимо')),
    { code: 'ROUTES_V2_LOCKED' });
    assert.equal((await coordinator.journal.readReceipt('sample', OPERATION)).state, 'aborted');
    assert.equal(await coordinator.journal.readIntent('sample'), null);
  });
