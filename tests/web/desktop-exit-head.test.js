import assert from 'node:assert/strict';
import test from 'node:test';

import { loadProductModule } from './helpers/compile-vue.js';
import { protocolHead } from './helpers/chat-protocol.js';

test('EXIT-HEAD: название незагруженного чата читается без истории', async (t) => {
  const calls = [];

  globalThis.__exitHeadApi = {
    /**
     * Чтение названия допускает только лёгкую голову нужного id.
     * Любая попытка получить полную историю немедленно проваливает проверку.
     */
    async get(url) {
      calls.push(url);

      if (url === '/api/chat/active') {
        return { active: [{ chatKey: 'local' }, { chatKey: 'remote' }], queued: [] };
      }
      if (url === '/api/tasks') {
        return { tasks: [] };
      }

      assert.equal(url, '/api/chat/store/head/remote');

      return { head: protocolHead({
        id: 'remote',
        title: 'Серверное имя',
        messages: [],
      }) };
    },
  };
  t.after(() => delete globalThis.__exitHeadApi);

  const { inspectDesktopExitActivity } = await loadProductModule('src/shared/desktopExitActivity.ts', {
    '../ui.ts': 'export const t = (key) => key;',
    './apiClient.ts': 'export const api = globalThis.__exitHeadApi;',
  });
  const result = await inspectDesktopExitActivity([{ id: 'local', title: 'Местное имя' }],
    new AbortController().signal);

  assert.deepEqual(result, {
    chats: [
      { chatKey: 'local', title: 'Местное имя' },
      { chatKey: 'remote', title: 'Серверное имя' },
    ],
    pipelines: [],
  });
  assert.equal(calls.some((url) => url.includes('/store/chat/')), false);
});
