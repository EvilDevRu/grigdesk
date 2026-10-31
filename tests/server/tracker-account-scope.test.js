import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { trackerAccountScope } from '../../server/src/lib/trackers/accountScope.ts';
import { TaskFavoritesService } from '../../server/src/lib/taskFavoritesService.ts';
import { TaskFavoritesStore } from '../../server/src/lib/taskFavoritesStore.ts';
import { TaskSeenService } from '../../server/src/lib/taskSeenService.ts';
import { TaskSeenStore } from '../../server/src/lib/taskSeenStore.ts';
import { TaskShelfService } from '../../server/src/lib/taskShelfService.ts';
import { TaskShelfStore } from '../../server/src/lib/taskShelfStore.ts';

const baseUrl = 'https://portal.example.test';
const previousScope = createHash('sha256').update(`${baseUrl}\0${77}`).digest('hex');

test('Числовой id и его строковая запись сохраняют прежний хеш побитово', () => {
  assert.equal(trackerAccountScope({ baseUrl, userId: 77 }), previousScope);
  assert.equal(trackerAccountScope({ baseUrl: `${baseUrl}/?query=1#part`, userId: '77' }), previousScope);
});

test('Строковый id нового драйвера допускается, пустая идентичность отклоняется', () => {
  const identity = { baseUrl, userId: 'jira:user-7' };

  assert.equal(trackerAccountScope(identity),
    createHash('sha256').update(`${baseUrl}\0jira:user-7`).digest('hex'));
  assert.throws(() => trackerAccountScope({ baseUrl, userId: '  ' }));
  assert.throws(() => trackerAccountScope(null));
  assert.throws(() => trackerAccountScope({ baseUrl: '', userId: '77' }));
});

for (const kind of ['favorites', 'seen', 'shelf']) {
  test(`Старая запись ${kind} читается новым сервисом по прежнему скопу без миграции`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tracker-scope-'));
    const filePath = path.join(root, `${kind}.json`);
    const tracker = { accountIdentity: async () => ({ baseUrl, userId: '77' }) };

    t.after(() => rm(root, { recursive: true, force: true }));

    if (kind === 'favorites') {
      await new TaskFavoritesStore({ filePath }).add(previousScope, '42');

      const service = new TaskFavoritesService({ store: new TaskFavoritesStore({ filePath }), tracker });
      const current = await service.list();

      assert.equal(current.scope, previousScope);
      assert.deepEqual(current.taskIds, ['42']);
      assert.equal(current.revision, 1);
    } else if (kind === 'seen') {
      await new TaskSeenStore({ filePath }).markSeen(previousScope, ['42'], { baseline: true });

      const service = new TaskSeenService({ store: new TaskSeenStore({ filePath }), tracker });
      const current = await service.list();

      assert.equal(current.scope, previousScope);
      assert.deepEqual(current.taskIds, ['42']);
      assert.equal(current.initialized, true);
      assert.equal(current.revision, 1);
    } else {
      await new TaskShelfStore({ filePath }).put(previousScope, '42', {
        title: 'Старая запись',
        reason: 'manual',
        snapshot: {
          analysis: null,
          pipeline: null,
          b24: null,
        },
        createIfMissing: true,
      });

      const service = new TaskShelfService({ store: new TaskShelfStore({ filePath }), tracker });
      const current = await service.list();

      assert.equal(current.scope, previousScope);
      assert.equal(current.entries[0].taskId, '42');
      assert.equal(current.entries[0].title, 'Старая запись');
      assert.equal(current.revision, 1);
    }
  });
}
