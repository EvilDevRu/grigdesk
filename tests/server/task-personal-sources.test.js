import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

import { TaskFavoritesStore } from '../../server/src/lib/taskFavoritesStore.ts';
import { TaskSeenStore } from '../../server/src/lib/taskSeenStore.ts';
import { TaskShelfStore } from '../../server/src/lib/taskShelfStore.ts';
import { TaskFavoritesService } from '../../server/src/lib/taskFavoritesService.ts';
import { TaskSeenService } from '../../server/src/lib/taskSeenService.ts';
import { TaskShelfService } from '../../server/src/lib/taskShelfService.ts';
import favoritesModule from '../../server/src/modules/task-favorites/index.ts';
import seenModule from '../../server/src/modules/task-seen/index.ts';
import shelfModule from '../../server/src/modules/task-shelf/index.ts';

const require = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = require('fastify');
const own = '100000000000';

/**
 * Три сервиса делят собственные записи, но сохраняют разные файлы и ревизии.
 * Недоступный трекер намеренно падает при любом вызове identity.
 */
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'personal-sources-'));
  const tracker = { accountIdentity: async () => {
    throw new Error('Сеть запрещена');
  } };
  const ownTasks = { list: async () => ({ tasks: [{ id: own }, { id: '100000000001' }] }) };
  const favorites = new TaskFavoritesService({
    store: new TaskFavoritesStore({ filePath: path.join(root, 'favorites.json') }),
    tracker,
    ownTasks,
  });
  const seen = new TaskSeenService({
    store: new TaskSeenStore({ filePath: path.join(root, 'seen.json') }),
    tracker,
    ownTasks,
  });
  const shelf = new TaskShelfService({
    store: new TaskShelfStore({ filePath: path.join(root, 'shelf.json') }),
    tracker,
    ownTasks,
  });
  const app = Fastify();

  app.decorate('pluginEnabled', () => true);
  await app.register(favoritesModule, { favorites });
  await app.register(seenModule, { seen });
  await app.register(shelfModule, { shelf });
  t.after(async () => {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  return {
    app,
    favorites,
    seen,
    shelf
  };
}

test('own метки читаются и меняются без identity внешнего трекера', async (t) => {
  const { app } = await fixture(t);

  for (const kind of ['favorites', 'seen', 'shelf']) {
    const response = await app.inject(`/api/grigdesk-tasks/task-${kind}`);

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().scope, 'grigdesk');
    assert.equal(response.headers['cache-control'], 'no-store');
  }

  const added = await app.inject({ method: 'PUT', url: `/api/grigdesk-tasks/task-favorites/${own}` });

  assert.equal(added.statusCode, 200);
  assert.deepEqual(added.json().taskIds, [own]);
  assert.equal((await app.inject({ method: 'PUT',
    url: '/api/grigdesk-tasks/task-favorites/100000000002' })).statusCode, 404);
  assert.equal((await app.inject({ method: 'PUT',
    url: '/api/grigdesk-tasks/task-favorites/42' })).statusCode, 400);
  assert.equal((await app.inject({ method: 'DELETE',
    url: '/api/grigdesk-tasks/task-favorites/100000000002' })).statusCode, 200);
  assert.equal((await app.inject('/api/tracker/task-favorites')).statusCode, 503);
  assert.deepEqual((await app.inject('/api/grigdesk-tasks/task-favorites')).json().taskIds, [own]);
});

test('два окна и порции baseline инициализируют own один раз', async (t) => {
  const { seen } = await fixture(t);
  const options = { source: 'grigdesk' };

  await seen.markSeen([own], {
    ...options,
    baselineId: 'window-a',
    baseline: false
  });
  await seen.markSeen(['100000000001'], {
    ...options,
    baselineId: 'window-b',
    baseline: false
  });

  const first = await seen.markSeen([], {
    ...options,
    baselineId: 'window-a',
    baseline: true
  });
  const second = await seen.markSeen([], {
    ...options,
    baselineId: 'window-b',
    baseline: true
  });

  assert.equal(first.initialized, true);
  assert.deepEqual(first.taskIds, [own]);
  assert.deepEqual(second.taskIds, [own]);
  assert.equal(second.revision, first.revision);
});

test('обычный просмотр own не поднимает initialized', async (t) => {
  const { seen } = await fixture(t);
  const viewed = await seen.markSeen([own], { source: 'grigdesk' });

  assert.equal(viewed.initialized, false);
  assert.deepEqual(viewed.taskIds, [own]);
});

test('own полка сохраняет null внешнего снимка и удаляется без identity трекера', async (t) => {
  const { app } = await fixture(t);
  const added = await app.inject({
    method: 'PUT',
    url: `/api/grigdesk-tasks/task-shelf/${own}`,
    payload: {
      title: 'Своя задача',
      reason: 'manual',
      createIfMissing: true,
      snapshot: {
        analysis: null,
        pipeline: null,
        b24: null,
      },
    },
  });

  assert.equal(added.statusCode, 200);
  assert.equal(added.json().entries[0].snapshot.b24, null);

  const deleted = await app.inject({ method: 'DELETE', url: `/api/grigdesk-tasks/task-shelf/${own}` });

  assert.equal(deleted.statusCode, 200);
  assert.deepEqual(deleted.json().entries, []);
});
