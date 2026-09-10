// Установка новой версии CLI исполнителя. Кнопок теперь две — в плашке настроек и во
// всплывашке топбара, — поэтому ход и его итог живут в сторе: смысл проверки в том, что
// вторая кнопка не начнёт свою установку поверх чужой и что отказ доезжает текстом.
import assert from 'node:assert/strict';
import test from 'node:test';

import { compileModule, webFile } from './helpers/compile-vue.js';

const STORE_PATH = webFile('src/stores/providers.js');

async function providersStore(t, api) {
  globalThis.__providersStoreApi = api;

  const module = await compileModule(STORE_PATH, {
    stubs: {
      '../shared/apiClient.ts': 'export const api = globalThis.__providersStoreApi;',
    },
  });
  const { createPinia, setActivePinia } = await import(
    '../../web/node_modules/pinia/dist/pinia.mjs'
  );

  setActivePinia(createPinia());

  const store = module.useProvidersStore();

  t.after(() => {
    store.$dispose();
    delete globalThis.__providersStoreApi;
  });

  return store;
}

test('удачная установка называет обе версии и перечитывает реестр', async (t) => {
  const calls = [];
  const store = await providersStore(t, {
    async get(path) {
      calls.push(path);
      return { providers: [{ id: 'claude', version: '2.1.259' }] };
    },
    async post(path) {
      calls.push(path);
      return { ok: true, changed: true, before: '2.1.258', after: '2.1.259' };
    },
  });

  const result = await store.updateCli('claude');

  assert.deepEqual(result, {
    type: 'ok',
    text: 'Обновлён: 2.1.258 → 2.1.259. Список моделей пересобран.',
    changed: true,
  });
  assert.deepEqual(store.updateResults.claude, result);
  assert.equal(store.updating, '', 'ход не закрыт — обе кнопки остались бы заблокированными');
  assert.deepEqual(calls, ['/api/providers/claude/update', '/api/providers?refresh=1'],
    'каталог моделей задаёт версия CLI, поэтому реестр обязан перечитаться принудительно');
});

test('чужая установка не начинается поверх идущей', async (t) => {
  const posts = [];
  let release = null;
  const store = await providersStore(t, {
    async get() { return { providers: [] }; },
    async post(path) {
      posts.push(path);
      await new Promise((resolve) => { release = resolve; });
      return { ok: true, changed: false, after: '1.0.0' };
    },
  });

  const first = store.updateCli('claude');

  await Promise.resolve();
  assert.equal(store.updating, 'claude');

  const second = await store.updateCli('codex');

  assert.deepEqual(second, { ok: false, error: 'другой CLI уже обновляется' });
  assert.deepEqual(posts, ['/api/providers/claude/update'], 'вторая установка всё-таки ушла');

  release();
  await first;
  assert.equal(store.updating, '');
});

test('отказ установки доезжает текстом, а не молчанием', async (t) => {
  const store = await providersStore(t, {
    async get() { return { providers: [] }; },
    async post() { return { ok: false, changed: false, output: 'npm ERR! code EACCES' }; },
  });

  const result = await store.updateCli('kimi');

  assert.equal(result.type, 'err');
  assert.match(result.text, /npm ERR! code EACCES/u);
  assert.equal(result.changed, false, 'по этому итогу всплывашка и решает, показывать ли строку');
});

test('упавший запрос не оставляет исполнителя в состоянии установки', async (t) => {
  const store = await providersStore(t, {
    async get() { return { providers: [] }; },
    async post() { throw new Error('сеть недоступна'); },
  });

  const result = await store.updateCli('claude');

  assert.deepEqual(result, { type: 'err', text: 'сеть недоступна', changed: false });
  assert.equal(store.updating, '');
});
