import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { makeDraft } from '../fixtures/routes-editor.mjs';
import { DraftStore } from '../../server/src/modules/routes/draftStore.ts';
import { RoutesStore } from '../../server/src/modules/routes/store.ts';
import { ROUTES_EDITOR_LIMITS } from '../../shared/pipeline/routesEditorContracts.ts';

const DRAFT_ID = '44444444-4444-4444-8444-444444444444';

async function fixture(t, fsPort = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-draft-failures-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const baseDir = path.join(root, 'routes.authoring');
  const routesDir = path.join(root, 'routes');
  const routesStore = new RoutesStore({ baseDir: routesDir });
  const options = {
    baseDir,
    routesStore,
    now: () => '2026-01-01T12:00:00.000Z',
    uuid: () => DRAFT_ID,
  };
  const store = new DraftStore(options);
  const failingStore = new DraftStore({ ...options, fsPort });
  const source = makeDraft();
  const input = {
    title: source.title,
    baseCatalogHash: source.baseCatalogHash,
    baseSourceRevision: source.baseSourceRevision,
    document: {
      routes: source.routes,
      bootstrap: source.bootstrap,
      bootstrapPrompts: source.bootstrapPrompts,
      presentation: source.presentation,
      provenance: source.provenance,
    },
  };
  const file = path.join(baseDir, 'sample', 'drafts', `${DRAFT_ID}.json`);
  return { root, baseDir, routesDir, store, failingStore, file, input, options };
}

test('RE-B3-01: отказы до rename оставляют прежние байты и revision', async (t) => {
  for (const stage of ['write', 'sync', 'rename']) {
    await t.test(stage, async (subtest) => {
      const fsPort = {
        async open(name, flags, mode) {
          const handle = await fs.open(name, flags, mode);
          if (flags !== 'wx' || !String(name).endsWith('.tmp')) {
            return handle;
          }
          return {
            writeFile: stage === 'write'
              ? async () => { throw Object.assign(new Error('write'), { code: 'EIO' }); }
              : (bytes) => handle.writeFile(bytes),
            sync: stage === 'sync'
              ? async () => { throw Object.assign(new Error('sync'), { code: 'EIO' }); }
              : () => handle.sync(),
            close: () => handle.close(),
          };
        },
        async rename(from, to) {
          if (stage === 'rename') {
            throw Object.assign(new Error('rename'), { code: 'EIO' });
          }
          await fs.rename(from, to);
        },
      };
      const { store, failingStore, input, file, options, baseDir } =
        await fixture(subtest, fsPort);
      await store.create('sample', input);
      const before = await fs.readFile(file);

      await assert.rejects(failingStore.patch('sample', DRAFT_ID, {
        expectedRevision: 1,
        operations: [{ kind: 'setTitle', title: 'Не должно сохраниться' }],
      }), { code: 'routes_authoring_unavailable' });
      assert.deepEqual(await fs.readFile(file), before);
      assert.equal((await new DraftStore(options).read('sample', DRAFT_ID)).revision, 1);
      assert.deepEqual(await fs.readdir(path.join(baseDir, 'sample', 'drafts')),
        [`${DRAFT_ID}.json`]);
    });
  }
});

test('RE-B3-02: отказ fsync каталога после rename сообщает неопределённый исход', async (t) => {
  const fsPort = {
    async open(name, flags, mode) {
      const handle = await fs.open(name, flags, mode);
      if (flags !== 'r' || !String(name).endsWith('/drafts')) {
        return handle;
      }
      return {
        async sync() {
          throw Object.assign(new Error('directory fsync'), { code: 'EIO' });
        },
        close: () => handle.close(),
      };
    },
  };
  const { store, failingStore, input, file, options } = await fixture(t, fsPort);
  await store.create('sample', input);

  await assert.rejects(failingStore.patch('sample', DRAFT_ID, {
    expectedRevision: 1,
    operations: [{ kind: 'setTitle', title: 'Заменённый документ' }],
  }), {
    code: 'routes_authoring_unavailable',
    details: { outcome: 'unknown', canReread: true, currentRevision: 2 },
  });
  const reread = await new DraftStore(options).read('sample', DRAFT_ID);
  assert.equal(reread.revision, 2);
  assert.equal(reread.title, 'Заменённый документ');
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).revision, 2);
});

test('RE-B3-03: symlink в draft, каталоге и lock не выводит запись наружу', async (t) => {
  const { root, baseDir, routesDir, store, input, file } = await fixture(t);
  await store.create('sample', input);
  const outside = path.join(root, 'outside.txt');
  await fs.writeFile(outside, 'Сторонние байты');

  await fs.rm(file);
  await fs.symlink(outside, file);
  await assert.rejects(store.read('sample', DRAFT_ID), {
    code: 'routes_authoring_corrupted',
  });
  await assert.rejects(store.patch('sample', DRAFT_ID, {
    expectedRevision: 1,
    operations: [{ kind: 'setTitle', title: 'Опасная запись' }],
  }), { code: 'routes_authoring_corrupted' });
  await fs.rm(file);

  const profileDir = path.join(baseDir, 'sample');
  await fs.rm(profileDir, { recursive: true });
  await fs.symlink(root, profileDir);
  await assert.rejects(store.list('sample'), { code: 'routes_authoring_unavailable' });
  await assert.rejects(store.create('sample', input), { code: 'routes_authoring_unavailable' });
  await fs.rm(profileDir);

  const lockFile = path.join(routesDir, 'sample', 'catalog', '.current.lock');
  await fs.rm(lockFile);
  await fs.symlink(outside, lockFile);
  await assert.rejects(store.create('sample', input), { code: 'ROUTES_V2_TAMPERED' });
  assert.equal(await fs.readFile(outside, 'utf8'), 'Сторонние байты');
});

test('RE-B3-04: невалидные адреса не создают файлов вне своей области', async (t) => {
  const { root, baseDir, store, input } = await fixture(t);
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'marker'), 'Маркер');

  for (const profile of ['..', '../outside', 'sample/../../outside', '']) {
    await assert.rejects(store.list(profile), { code: 'routes_bad_request' });
    await assert.rejects(store.create(profile, input));
  }
  for (const id of ['..', '../outside', 'no-uuid']) {
    await assert.rejects(store.read('sample', id), { code: 'routes_bad_request' });
  }
  assert.equal(await fs.readFile(path.join(outside, 'marker'), 'utf8'), 'Маркер');
  await assert.rejects(fs.stat(baseDir), { code: 'ENOENT' });
});

test('RE-B3-05: слишком большой draft отклонён до записи, temp не читается', async (t) => {
  const { baseDir, store, input } = await fixture(t);
  input.document.presentation = { large: 'x'.repeat(ROUTES_EDITOR_LIMITS.draftBytes) };
  await assert.rejects(store.create('sample', input), { code: 'routes_payload_too_large' });
  await assert.rejects(fs.stat(baseDir), { code: 'ENOENT' });

  const created = await store.create('sample', { ...input, document: {
    ...input.document,
    presentation: {},
  } });
  const directory = path.join(baseDir, 'sample', 'drafts');
  await fs.writeFile(path.join(directory, 'pending.tmp'), JSON.stringify(created));
  assert.deepEqual((await store.list('sample')).drafts.map((draft) => draft.id), [DRAFT_ID]);
});
