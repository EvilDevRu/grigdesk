import assert from 'node:assert/strict';
import test from 'node:test';

import { createPinia, setActivePinia } from '../../web/node_modules/pinia/dist/pinia.mjs';
import { compileModule, webFile } from './helpers/compile-vue.js';

const module = await compileModule(webFile('src/stores/videoSession.ts'), {
  stubs: {
    '../shared/apiClient.ts': `export const api = {
      post: (...args) => globalThis.__multiVideoPost(...args),
    };`,
    './plugins.ts': 'export const usePluginsStore = () => ({ byId: () => null });',
  },
});

for (const fails of [false, true]) {
  test(`MD-VIDEO-LEGACY: create без цели, отказ=${fails}, без автоматического повтора`, async (t) => {
    setActivePinia(createPinia());

    const calls = [];

    globalThis.__multiVideoPost = async (...args) => {
      calls.push(args);

      if (fails) {
        throw new Error('Драйвер временно недоступен');
      }

      return { id: 43 };
    };
    t.after(() => delete globalThis.__multiVideoPost);

    const session = module.useVideoSessionStore();
    const draft = {
      ...session.emptyDraft(),
      title: '  Задача встречи  ',
      description: 'Текст',
    };
    const result = await session.createOne(draft);

    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], '/api/tracker/tasks');
    assert.deepEqual(calls[0][1], {
      title: 'Задача встречи',
      description: 'Текст',
      createdById: null,
      responsibleId: null,
      groupId: null,
      priority: Number(draft.priority),
      frames: [],
      clips: [],
    });
    assert.equal(result, fails ? null : 43);
    assert.equal(draft.creating, false);

    if (fails) {
      assert.match(draft.error, /недоступен/u);
      assert.equal(draft.createdId, null);
    } else {
      await session.createOne(draft);
      assert.equal(calls.length, 1);
    }
  });
}
