import assert from 'node:assert/strict';
import test from 'node:test';

import catalog from '../fixtures/executor-settings/synthetic-catalog.json' with { type: 'json' };
import { compileModule, webFile } from './helpers/compile-vue.js';

test('карточка загружает каталог один раз и использует свежий результат', async () => {
  const { createPinia, setActivePinia } = await import('../../web/node_modules/pinia/dist/pinia.mjs');
  const { defineProviderSettingsStore } = await compileModule(webFile('src/stores/providerSettings.ts'));
  let reads = 0;
  const store = defineProviderSettingsStore(
    {
      async catalog() {
        reads += 1;

        return structuredClone(catalog);
      },
      async override() {
        throw new Error('Запись в этом сценарии не нужна');
      },
    },
    () => 1000,
  )(setActivePinia(createPinia()));

  await Promise.all([store.load('future-provider'), store.load('future-provider')]);
  await store.load('future-provider');

  assert.equal(store.panel('future-provider').catalog?.fields[0]?.kind, 'boolean');
  assert.equal(reads, 1);
  assert.equal(store.panel('future-provider').loading, false);
});

test('сохранение false использует ответ сервера и его новую ревизию', async () => {
  const { createPinia } = await import('../../web/node_modules/pinia/dist/pinia.mjs');
  const { defineProviderSettingsStore } = await compileModule(webFile('src/stores/providerSettings.ts'));
  const requests = [];
  const response = structuredClone(catalog);

  response.revision = '1';
  response.fields[0].override = { state: 'known', value: false };

  const store = defineProviderSettingsStore({
    catalog: async () => structuredClone(catalog),
    async override(id, request) {
      requests.push({ id, request });

      return {
        ok: true,
        changed: true,
        catalog: response,
      };
    },
  })(createPinia());

  await store.load('future-provider');

  const fieldId = catalog.fields[0].id;

  await store.save('future-provider', fieldId, false);

  assert.equal(requests[0]?.request.value, false);
  assert.equal(requests[0]?.request.revision, '0');
  assert.equal(store.panel('future-provider').catalog.revision, '1');
  assert.equal(store.panel('future-provider').catalog.fields[0].base.value, true);
});

test('409 останавливает очередь provider, перечитывает каталог и сохраняет оба drafts', async () => {
  const { createPinia } = await import('../../web/node_modules/pinia/dist/pinia.mjs');
  const { defineProviderSettingsStore } = await compileModule(webFile('src/stores/providerSettings.ts'));
  let writes = 0;
  let reads = 0;
  const conflict = Promise.withResolvers();
  const store = defineProviderSettingsStore({
    async catalog() {
      reads += 1;

      return { ...structuredClone(catalog), revision: String(reads) };
    },
    async override() {
      writes += 1;
      await conflict.promise;

      throw Object.assign(new Error('Другая вкладка изменила настройки'), { status: 409 });
    },
  })(createPinia());

  await store.load('future-provider');

  const first = store.save('future-provider', '["enabled"]', false);
  const second = store.save('future-provider', '["future"]', true);

  conflict.resolve();
  await Promise.all([first, second]);

  assert.equal(writes, 1);
  assert.equal(reads, 2);
  assert.equal(store.panel('future-provider').drafts['["enabled"]'], false);
  assert.equal(store.panel('future-provider').drafts['["future"]'], true);
  assert.equal(store.panel('future-provider').saving, false);
});

test('успешный unset убирает прежний черновик и оставляет новое значение источника', async () => {
  const { createPinia } = await import('../../web/node_modules/pinia/dist/pinia.mjs');
  const { defineProviderSettingsStore } = await compileModule(webFile('src/stores/providerSettings.ts'));
  const fieldId = catalog.fields[0].id;
  const saved = structuredClone(catalog);
  const reset = structuredClone(catalog);

  saved.fields[0].override = { state: 'known', value: false };
  reset.fields[0].base = { state: 'known', value: true };

  const store = defineProviderSettingsStore({
    catalog: async () => saved,
    async override(_id, request) {
      assert.equal(request.operation, 'unset');
      assert.equal(Object.hasOwn(request, 'value'), false);

      return {
        ok: true,
        changed: true,
        catalog: reset,
      };
    },
  })(createPinia());

  await store.load('future-provider');
  store.draft('future-provider', fieldId, false);
  await store.reset('future-provider', fieldId);

  assert.equal(Object.hasOwn(store.panel('future-provider').drafts, fieldId), false);
  assert.equal(store.panel('future-provider').catalog.fields[0].base.value, true);
});
