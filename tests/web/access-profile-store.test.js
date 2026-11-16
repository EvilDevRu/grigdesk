import assert from 'node:assert/strict';
import test from 'node:test';

import { createPinia } from '../../web/node_modules/pinia/dist/pinia.mjs';
import { compileModule, compileVue, webFile } from './helpers/compile-vue.js';

/**
 * Фикстура подменяет только транспорт, сохраняя production store и Pinia.
 * Публичное хранилище позволяет проверить reload без запуска отдельного браузера.
 */
async function storeFixture(t) {
  const storage = new Map();
  const original = globalThis.sessionStorage;
  const control = {
    online: false,
    committed: true,
    serverError: false,
  };
  const posts = [];
  const list = {
    revision: 1,
    activeProfileId: null,
    profiles: [],
    methods: [],
  };
  const attempt = {
    id: 'fixture-attempt',
    revision: 1,
    state: 'saved',
    step: { id: 'result', kind: 'result' },
  };

  globalThis.sessionStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  };
  globalThis.__accessStoreFixture = {
    async post(_url, body) {
      posts.push(body);

      if (control.serverError) {
        throw Object.assign(new Error('Неизвестный исход сервера'), { apiStatus: 500 });
      }

      throw new TypeError('Ответ потерян');
    },
    /**
     * Ответ операции использует настоящий DTO с attemptId вместо тела мутации.
     * Отсутствующий исход и ошибка транспорта моделируются независимо.
     */
    async get(url) {
      if (!control.online) {
        throw new TypeError('Нет связи');
      }

      if (url.includes('/operations/')) {
        if (!control.committed) {
          throw Object.assign(new Error('Неизвестная операция'), { apiStatus: 404 });
        }

        return { state: 'completed', attemptId: attempt.id };
      }

      return url.endsWith('/attempts') ? { attempts: [attempt] }
        : url.includes('/attempts/') ? attempt : list;
    },
  };

  t.after(() => {
    globalThis.sessionStorage = original;
    delete globalThis.__accessStoreFixture;
  });

  const module = await compileModule(webFile('src/stores/accessProfiles.ts'), {
    stubs: {
      '../shared/apiClient.ts': `
        export class ApiError extends Error {
          constructor(message, status) {
            super(message);
            this.status = status;
          }
        }
        const wrap = method => async (...args) => {
          try {
            return await globalThis.__accessStoreFixture[method](...args);
          } catch (error) {
            if (error.apiStatus) {
              throw new ApiError(error.message, error.apiStatus);
            }
            throw error;
          }
        };
        export const api = { post: wrap('post'), get: wrap('get') };
        export const failureText = error => error.message;
      `,
    },
  });

  return {
    control,
    posts,
    storage,
    list,
    attempt,
    store: module.useAccessProfilesStore(createPinia()),
    reload: () => module.useAccessProfilesStore(createPinia()),
  };
}

test('AP23_store: потерянный ACK удерживает operationId до восстановления production DTO', async (t) => {
  const f = await storeFixture(t);
  const body = {
    name: 'Подключение',
    methodId: 'api-key',
    input: { key: 'fixture-private-key' },
  };

  await f.store.mutate('fixture', '/attempts', body);
  await f.store.mutate('fixture', '/attempts', body);
  assert.equal(f.posts.length, 1);
  assert.ok(f.store.unresolved.fixture);
  assert.equal(JSON.stringify([...f.storage]).includes('fixture-private-key'), false);
  assert.equal(JSON.stringify(f.store.$state).includes('fixture-private-key'), false);

  const restored = f.reload();

  f.control.online = true;
  await restored.load('fixture');
  assert.equal(restored.unresolved.fixture, undefined);
  assert.equal(restored.attempts.fixture.state, 'saved');
  assert.equal(f.posts.length, 1);
});

test('переключение требует явного серверного допуска и успешного чтения', async (t) => {
  const f = await storeFixture(t);

  f.control.online = true;
  await f.store.load('fixture');
  await f.store.activate('fixture', 'another');
  assert.equal(f.posts.length, 0, 'Отсутствующий допуск не разрешает переключение');
  f.list.switchAllowed = false;
  await f.store.load('fixture');
  await f.store.activate('fixture', 'another');
  assert.equal(f.posts.length, 0);
  f.list.switchAllowed = true;
  await f.store.load('fixture');
  f.store.errors.fixture = 'Нет связи';
  await f.store.activate('fixture', 'another');
  assert.equal(f.posts.length, 0, 'Старое разрешение не действует после отказа чтения');
  await f.store.load('fixture');
  await f.store.activate('fixture', 'another');
  assert.equal(f.posts.length, 1);
});

test('AP23_store: неизвестный 404 допускает явный повтор только с прежним operationId', async (t) => {
  const f = await storeFixture(t);
  const body = { name: 'Подключение', methodId: 'api-key' };

  await f.store.mutate('fixture', '/attempts', body);
  f.control.online = true;
  f.control.committed = false;
  await f.store.mutate('fixture', '/another-action', {});
  assert.equal(f.posts.length, 1, 'другая операция не обгоняет неизвестный результат');
  await f.store.mutate('fixture', '/attempts', { ...body, profileId: 'another-profile' });
  assert.equal(f.posts.length, 1, 'другой профиль не получает ID старого мастера');
  await f.store.mutate('fixture', '/attempts', body);
  assert.equal(f.posts.length, 2);
  assert.equal(f.posts[0].operationId, f.posts[1].operationId);
});

test('AP23_store: HTTP 500 после мутации тоже требует чтения исхода', async (t) => {
  const f = await storeFixture(t);

  f.control.serverError = true;
  await f.store.mutate('fixture', '/attempts', { name: 'Подключение', methodId: 'api-key' });
  assert.ok(f.store.unresolved.fixture);
  f.control.online = true;
  await f.store.load('fixture');
  assert.equal(f.store.attempts.fixture.state, 'saved');
  assert.equal(f.posts.length, 1);
});

test('AP23_store: позднее чтение A не удаляет неизвестный исход операции B', async (t) => {
  const f = await storeFixture(t);

  await f.store.mutate('fixture', '/attempts', { name: 'A', methodId: 'api-key' });
  f.control.online = true;

  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const originalGet = globalThis.__accessStoreFixture.get;
  let hold = true;

  t.after(() => release.resolve());
  globalThis.__accessStoreFixture.get = async (url) => {
    const result = await originalGet(url);

    if (hold && url.includes('/operations/')) {
      hold = false;
      entered.resolve();
      await release.promise;
    }

    return result;
  };

  const late = f.store.load('fixture');

  await entered.promise;
  await f.store.load('fixture');
  f.control.committed = false;
  await f.store.mutate('fixture', '/attempts', { name: 'B', methodId: 'api-key' });

  const pendingId = f.store.unresolved.fixture.id;

  release.resolve();
  await late;
  assert.equal(f.store.unresolved.fixture.id, pendingId);
});

test('AP23_panel: reload неизвестного create открывает тот же мастер и исходного владельца', async (t) => {
  const f = await storeFixture(t);

  f.list.profiles.push(...['a', 'b'].map((id) => ({
    id,
    name: `Аккаунт ${id}`,
    methodId: 'api-key',
    revision: 1,
    authState: 'ready',
  })));
  await f.store.mutate('fixture', '/attempts', {
    name: 'Вход A',
    profileId: 'a',
    methodId: 'api-key',
  });
  f.control.online = true;
  f.control.committed = false;

  const restored = f.reload();

  globalThis.__accessPanelFixture = restored;
  t.after(() => {
    delete globalThis.__accessPanelFixture;
  });

  const component = await compileVue(webFile('src/shared/AccessProfilePanel.vue'), {
    expose: ['begin', 'wizard', 'editing', 'recovery'],
    stubs: {
      '../ui.ts': `
        export const UiButton = {};
        export const UiIconButton = {};
        export const UiInlineMessage = {};
        export const UiRefreshIcon = {};
        export const vTooltip = {};
        export const confirmDialog = async () => true;
        export const promptDialog = async () => '';
        export const t = key => key;
      `,
      '../stores/accessProfiles.ts': `
        export const useAccessProfilesStore = () => globalThis.__accessPanelFixture;
      `,
      '../composables/useSse.ts': 'export const useSse = () => ({});',
      './AccessProfileDialog.vue': 'export default {};',
    },
  });
  let exposed;

  component.setup({ providerId: 'fixture' }, { expose: (value) => {
    exposed = value;
  } });
  await exposed.begin({ id: 'b', name: 'Аккаунт b' });

  assert.equal(exposed.wizard.value, true);
  assert.equal(exposed.editing.value.id, 'a');
  assert.equal(exposed.recovery.value.methodId, 'api-key');
  assert.equal(f.posts.length, 1);
});
