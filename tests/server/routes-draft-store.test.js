import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { makeDraft } from '../fixtures/routes-editor.mjs';
import { DraftStore } from '../../server/src/modules/routes/draftStore.ts';
import { RoutesStore } from '../../server/src/modules/routes/store.ts';

const DRAFT_ID = '44444444-4444-4444-8444-444444444444';
const NOW = '2026-01-01T12:00:00.000Z';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-draft-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const baseDir = path.join(root, 'routes.authoring');
  const routesDir = path.join(root, 'routes');
  const routesStore = new RoutesStore({ baseDir: routesDir });
  const store = new DraftStore({
    baseDir,
    routesStore,
    now: () => NOW,
    uuid: () => DRAFT_ID,
  });

  return { root, baseDir, routesDir, routesStore, store };
}

function createInput() {
  const draft = makeDraft();

  return {
    title: draft.title,
    baseCatalogHash: draft.baseCatalogHash,
    baseSourceRevision: draft.baseSourceRevision,
    document: {
      routes: draft.routes,
      bootstrap: draft.bootstrap,
      bootstrapPrompts: draft.bootstrapPrompts,
      presentation: draft.presentation,
      provenance: draft.provenance,
    },
  };
}

test('RE-B1-01: конструктор не пишет, новый экземпляр читает тот же draft', async (t) => {
  const { baseDir, routesStore, store } = await fixture(t);
  await assert.rejects(stat(baseDir), { code: 'ENOENT' });

  const created = await store.create('sample', createInput());
  assert.equal(created.id, DRAFT_ID);
  assert.equal(created.revision, 1);
  assert.equal(created.createdAt, NOW);
  assert.equal(created.updatedAt, NOW);

  const restarted = new DraftStore({ baseDir, routesStore });
  const loaded = await restarted.read('sample', DRAFT_ID);
  assert.deepEqual(loaded, created);
});

test('RE-B1-02: список содержит только метаданные без prompt-текстов', async (t) => {
  const { store } = await fixture(t);
  const created = await store.create('sample', createInput());
  const list = await store.list('sample');

  assert.deepEqual(list, {
    drafts: [{
      id: created.id,
      profile: created.profile,
      title: created.title,
      revision: created.revision,
      baseCatalogHash: created.baseCatalogHash,
      state: created.state,
      updatedAt: created.updatedAt,
    }],
  });
  assert.equal(JSON.stringify(list).includes('Создай проверяемый результат'), false);
});

test('RE-B1-03: одинаковые названия дают два независимых ID', async (t) => {
  const { baseDir, routesStore } = await fixture(t);
  const ids = [
    '44444444-4444-4444-8444-444444444444',
    '55555555-5555-4555-8555-555555555555',
  ];
  const store = new DraftStore({ baseDir, routesStore, now: () => NOW, uuid: () => ids.shift() });
  const first = await store.create('sample', createInput());
  const second = await store.create('sample', createInput());

  assert.notEqual(first.id, second.id);
  assert.equal(first.title, second.title);
  assert.deepEqual(new Set((await store.list('sample')).drafts.map((draft) => draft.id)),
    new Set([first.id, second.id]));
});

test('RE-B1-04: повреждённый JSON остаётся прежним и отличается от отсутствия', async (t) => {
  const { baseDir, store } = await fixture(t);
  await store.create('sample', createInput());
  const file = path.join(baseDir, 'sample', 'drafts', `${DRAFT_ID}.json`);
  const corrupted = Buffer.from('{broken JSON', 'utf8');
  await writeFile(file, corrupted);

  await assert.rejects(store.read('sample', DRAFT_ID), {
    code: 'routes_authoring_corrupted',
  });
  assert.deepEqual(await readFile(file), corrupted);
  await assert.rejects(store.read('sample', '66666666-6666-4666-8666-666666666666'), {
    code: 'routes_draft_not_found',
  });
});

test('RE-B1-05: создание и чтение черновика не активируют каталог', async (t) => {
  const { routesDir, store } = await fixture(t);
  const created = await store.create('sample', createInput());
  await store.read('sample', created.id);

  await assert.rejects(stat(path.join(routesDir, 'sample', 'catalog', 'current.json')),
    { code: 'ENOENT' });
  await assert.rejects(stat(path.join(routesDir, 'sample', 'catalog', 'revisions')),
    { code: 'ENOENT' });
  await assert.rejects(stat(path.join(routesDir, 'sample', 'quick', 'revisions')),
    { code: 'ENOENT' });
});

test('RE-B1-06: config даёт соседний authoringDir и принимает явный override', async (t) => {
  const { root } = await fixture(t);
  const routesDir = path.join(root, 'published');
  const override = path.join(root, 'drafts');
  const readConfig = (authoringDir) => {
    const child = spawnSync(process.execPath, [
      '--input-type=module',
      '-e',
      [
        "import { config } from './server/src/config.ts';",
        'process.stdout.write(JSON.stringify({',
        'routesDir: config.routesDir,',
        'authoringDir: config.routesAuthoringDir,',
        '}));',
      ].join(' '),
    ], {
      cwd: path.resolve(new URL('../..', import.meta.url).pathname),
      env: {
        ...process.env,
        COCKPIT_ROUTES_DIR: routesDir,
        COCKPIT_ROUTES_AUTHORING_DIR: authoringDir,
      },
      encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  };

  assert.deepEqual(readConfig(''), {
    routesDir,
    authoringDir: `${routesDir}.authoring`,
  });
  assert.deepEqual(readConfig(override), { routesDir, authoringDir: override });
});

test('RE-B1-07: содержимое не может подменить серверный ID и состояние', async (t) => {
  const { store } = await fixture(t);
  const input = createInput();
  input.document.id = '77777777-7777-4777-8777-777777777777';
  input.document.state = 'published';

  await assert.rejects(store.create('sample', input), /document|id|state/i);
  assert.deepEqual((await store.list('sample')).drafts, []);
});

test('RE-B1-08: служебные каталоги приватны, вложенный захват замка запрещён', async (t) => {
  const { baseDir, routesStore, store } = await fixture(t);
  const created = await store.create('sample', createInput());
  const directory = path.join(baseDir, 'sample', 'drafts');
  const file = path.join(directory, `${created.id}.json`);

  assert.equal((await stat(baseDir)).mode & 0o777, 0o700);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await assert.rejects(routesStore.withProfileMutation('sample', async () => (
    routesStore.withProfileMutation('sample', async () => 'nested')
  )), { code: 'ROUTES_V2_LOCKED' });
});

test('RE-B2-01: PATCH повышает revision, stale-запись получает фактическую версию', async (t) => {
  const { store } = await fixture(t);
  const created = await store.create('sample', createInput());
  const updated = await store.patch('sample', created.id, {
    expectedRevision: 1,
    operations: [{ kind: 'setTitle', title: 'Новая редакция' }],
  });

  assert.equal(updated.revision, 2);
  assert.equal(updated.title, 'Новая редакция');
  await assert.rejects(store.patch('sample', created.id, {
    expectedRevision: 1,
    operations: [{ kind: 'setTitle', title: 'Устаревшая редакция' }],
  }), { code: 'routes_draft_conflict', details: { currentRevision: 2 } });
  assert.deepEqual(await store.read('sample', created.id), updated);
});

/**
 * Ждёт следующее IPC-сообщение дочернего писателя без таймингового предположения.
 */
function childMessage(child) {
  return new Promise((resolve, reject) => {
    const onMessage = (message) => {
      cleanup();
      resolve(message);
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`Писатель завершился до ответа: ${code}`));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('error', onError);
    };

    child.on('message', onMessage);
    child.on('exit', onExit);
    child.on('error', onError);
  });
}

test('RE-B2-02: два процесса с одной revision дают одного победителя', async (t) => {
  const { baseDir, routesDir, store } = await fixture(t);
  const created = await store.create('sample', createInput());
  const script = new URL('./fixtures/routes-draft-writer.mjs', import.meta.url).pathname;
  const titles = ['Первый писатель', 'Второй писатель'];
  const children = titles.map((title) => fork(script, [
    baseDir, routesDir, 'sample', created.id, title,
  ], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
  t.after(() => {
    for (const child of children) {
      if (child.exitCode === null) {
        child.kill();
      }
    }
  });

  const ready = await Promise.all(children.map(childMessage));
  assert.deepEqual(ready.map((message) => message.revision), [1, 1]);

  const responses = children.map(childMessage);
  children.forEach((child) => child.send({ type: 'go' }));
  const results = await Promise.all(responses);
  const winner = results.find((result) => result.state === 'success');
  const loser = results.find((result) => result.state === 'error');

  assert.equal(results.filter((result) => result.state === 'success').length, 1);
  assert.equal(loser?.code, 'routes_draft_conflict');
  assert.equal(loser?.currentRevision, 2);
  assert.equal((await store.read('sample', created.id)).title, winner?.title);
});

test('RE-B2-03: неверная последняя команда не сохраняет первую', async (t) => {
  const { store } = await fixture(t);
  const created = await store.create('sample', createInput());

  await assert.rejects(store.patch('sample', created.id, {
    expectedRevision: 1,
    operations: [
      { kind: 'setTitle', title: 'Не должно сохраниться' },
      {
        kind: 'putBootstrap',
        bootstrap: created.bootstrap,
        prompts: { 'bootstrap/prompts/scout.base.md': 42 },
      },
    ],
  }));
  assert.deepEqual(await store.read('sample', created.id), created);
});

test('RE-B2-04: no-op не повышает revision, архив закрывает запись', async (t) => {
  const { baseDir, store } = await fixture(t);
  const created = await store.create('sample', createInput());
  const unchanged = await store.patch('sample', created.id, {
    expectedRevision: 1,
    operations: [],
  });

  assert.deepEqual(unchanged, created);
  const archived = await store.archive('sample', created.id, 1);
  assert.equal(archived.state, 'archived');
  assert.equal(archived.revision, 2);
  assert.deepEqual(await store.archive('sample', created.id, 2), archived);
  await assert.rejects(store.patch('sample', created.id, {
    expectedRevision: 2,
    operations: [{ kind: 'setTitle', title: 'Нельзя' }],
  }), { code: 'routes_draft_closed' });

  const published = { ...archived, state: 'published' };
  const file = path.join(baseDir, 'sample', 'drafts', `${created.id}.json`);
  await writeFile(file, JSON.stringify(published));
  await assert.rejects(store.patch('sample', created.id, {
    expectedRevision: 2,
    operations: [{ kind: 'setTitle', title: 'Нельзя после публикации' }],
  }), { code: 'routes_draft_closed' });
  await assert.rejects(store.archive('sample', created.id, 2), {
    code: 'routes_draft_closed',
  });
});

test('RE-B2-05: профиль с тем же UUID не читает чужой черновик', async (t) => {
  const { store } = await fixture(t);
  const created = await store.create('sample', createInput());

  await assert.rejects(store.read('another', created.id), { code: 'routes_draft_not_found' });
  await assert.rejects(store.patch('another', created.id, {
    expectedRevision: 1,
    operations: [{ kind: 'setTitle', title: 'Чужая правка' }],
  }), { code: 'routes_draft_not_found' });
  assert.equal((await store.read('sample', created.id)).title, created.title);
});
