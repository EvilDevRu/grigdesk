import assert from 'node:assert/strict';
import { after } from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';

import { capabilities, roleCatalog, seedDraft, serverFixture } from '../../fixtures/routes-stage-wizard.mjs';
import { compileVue, webFile } from './compile-vue.js';
import { createUiBrowser } from './ui-components.js';

let browserPromise;
let releaseCurrentFixture = async () => {};

after(async () => {
  await releaseCurrentFixture();
  await (await browserPromise)?.close();
});

const API_STUB = `
export const api = globalThis.__stageWizard.api;
export { ApiError, failureText } from './src/shared/apiClient.ts';
`;
const UI_STUB = `
export * from './src/ui.ts';
import { setUiLocale } from './src/services/locale.ts';
globalThis.__stageWizard.setLocale = setUiLocale;
export const confirmDialog = async () => true;
`;

/**
 * Корневой экран и все действия настоящие; сеть ведёт только в одноразовый Fastify.
 * Каталог — синтетический публичный DTO, чтобы UI не зависел от готовности нового API.
 */
export async function wizardFixture(t, options = {}) {
  // Vue сохраняет первый document; все последовательные сценарии используют одно окно.
  // Предыдущий mount снимается и при вложенном сценарии, чтобы Teleport не оставлял соседний диалог.
  await releaseCurrentFixture();
  browserPromise ??= createUiBrowser('http://grigdesk.test/#/routes');

  const browser = await browserPromise;

  browser.document.body.innerHTML = '<div id="mount"></div>';
  browser.localStorage.clear();

  const { app } = await serverFixture(t);
  const source = await app.inject({
    method: 'PUT',
    url: '/api/routes/sample/editor/source',
    payload: {
      mode: 'editor',
      expectedSourceRevision: 0,
      expectedCatalogHash: null,
    },
  });

  assert.equal(source.statusCode, 200, source.body);

  const initial = options.draft ?? await seedDraft({ minimal: Boolean(options.minimal) });
  const created = await app.inject({
    method: 'POST',
    url: '/api/routes/sample/drafts',
    payload: {
      kind: 'document',
      title: initial.title,
      baseCatalogHash: null,
      baseSourceRevision: source.json().source.revision,
      document: {
        routes: initial.routes,
        bootstrap: initial.bootstrap,
        bootstrapPrompts: initial.bootstrapPrompts,
        presentation: initial.presentation,
        provenance: initial.provenance,
      },
    },
  });

  assert.equal(created.statusCode, 201, created.body);

  const draft = created.json();
  const { reactive } = await import('../../../web/node_modules/vue/index.mjs');
  const { createPinia, setActivePinia } = await import('../../../web/node_modules/pinia/dist/pinia.mjs');
  const route = reactive({ path: '/routes', query: {
    profile: 'sample',
    draft: draft.id,
    route: 'feature',
    node: 'build',
    tab: 'graph',
  } });
  const catalog = await roleCatalog();
  const calls = [];
  const pending = {
    catalog: options.catalogGate,
    catalogError: options.catalogError,
    patchError: null,
    validateGate: null,
    validationIssues: null,
  };

  /**
   * Сохраняет реальный HTTP-контракт редактора, включая CAS и decoder клиента.
   * Управляемые отказы и задержки касаются лишь явно проверяемого сетевого события.
   */
  async function request(method, url, payload) {
    calls.push({
      method,
      url,
      payload: payload === undefined ? undefined : JSON.parse(JSON.stringify(payload)),
    });

    if (url === '/api/profiles') {
      return { profiles: ['sample', 'other'] };
    }
    if (url.endsWith('/editor/stage-roles')) {
      await pending.catalog;
      pending.catalog = null;

      if (pending.catalogError) {
        throw pending.catalogError;
      }

      return structuredClone(catalog);
    }
    if (method === 'PATCH' && pending.patchError) {
      throw pending.patchError;
    }
    if (url.endsWith('/validate')) {
      await pending.validateGate;
      pending.validateGate = null;
    }

    const response = await app.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload }),
    });

    if (response.statusCode >= 400) {
      const error = new Error(response.json().message ?? response.json().error);

      error.status = response.statusCode;

      throw error;
    }

    const value = response.json();

    if (url.endsWith('/editor')) {
      value.capabilities = structuredClone(options.capabilities ?? capabilities);
      value.capabilitiesHash = 'b'.repeat(64);
    }
    if (url.endsWith('/validate') && pending.validationIssues) {
      value.issues = pending.validationIssues;
    }

    return value;
  }

  const active = new Set();

  /**
   * Считает незавершённые запросы Fastify, включая файловый I/O его стора.
   * Управляемые тестом задержки не мешают проверить состояние ожидающего диалога.
   */
  async function trackedRequest(method, url, body) {
    const token = { url };

    active.add(token);

    try {
      return await request(method, url, body);
    } finally {
      active.delete(token);
    }
  }

  const api = {
    get: (url) => trackedRequest('GET', url),
    post: (url, body) => trackedRequest('POST', url, body),
    patch: (url, body) => trackedRequest('PATCH', url, body),
    put: (url, body) => trackedRequest('PUT', url, body),
    del: (url) => trackedRequest('DELETE', url),
  };

  globalThis.__stageWizard = { api };
  setActivePinia(createPinia());

  const component = await compileVue(webFile('src/views/RoutesView.vue'), {
    expose: ['routesStore', 'closeDraft', 'undoDraft', 'redoDraft', 'saveDraft', 'applyLocalChange'],
    stubs: {
      '../ui': UI_STUB,
      '../../ui': UI_STUB,
      '../shared/apiClient.ts': API_STUB,
      '../../shared/apiClient.ts': API_STUB,
      './apiClient.ts': API_STUB,
      'vue-router': `
        export const useRoute = () => globalThis.__stageWizard.route;
        export const useRouter = () => globalThis.__stageWizard.router;
        export const onBeforeRouteLeave = () => {};
        export const onBeforeRouteUpdate = () => {};`,
      '../composables/useUiContextSource.ts':
        'export const useUiContextSource = () => ({ focus() {}, update() {}, blur() {} });',
      '../../composables/useSse.ts': 'export const sseSubscribe = () => () => {};',
      './routes/RoutePromptEditor.vue': 'export default { template: "<div />" };',
      './routes/RouteJsonEditor.vue': 'export default { template: "<div />" };',
      './routes/RouteBootstrapEditor.vue': 'export default { template: "<div />" };',
      './RouteMarkdownInput.vue': 'export default { template: "<textarea />" };',
    },
  });

  globalThis.__stageWizard.route = route;
  globalThis.__stageWizard.router = {
    push: async (target) => {
      route.query = { ...target.query };
    },
    replace: async (target) => {
      route.query = { ...target.query };
    },
  };

  const { mount, flushPromises } = await import(
    '../../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );

  globalThis.__stageWizard.setLocale('ru');

  const wrapper = mount(component, { attachTo: browser.document.querySelector('#mount') });
  let released = false;

  /**
   * Вложенный сценарий может заменить mount раньше завершения родительского теста.
   * Повторный cleanup безопасен и не удаляет глобальные порты следующей фикстуры.
   */
  async function release() {
    if (released) {
      return;
    }

    released = true;

    wrapper.vm.closeDraft();
    wrapper.unmount();
    await flushPromises();
    delete globalThis.__stageWizard;
  }

  releaseCurrentFixture = release;
  t.after(release);

  /**
   * Vue flushPromises не ждёт дисковый I/O, который использует настоящий server fixture.
   * Ожидаем только свободные запросы, оставляя задержанные ответы под управлением теста.
   */
  async function settle() {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      await flushPromises();

      const waiting = [...active].some(({ url }) => !(
        (url.endsWith('/editor/stage-roles') && pending.catalog)
        || (url.endsWith('/validate') && pending.validateGate)
      ));

      if (!waiting) {
        await flushPromises();

        return;
      }

      await pause(10);
    }

    assert.fail('Синтетический transport не завершил запрос');
  }

  await settle();

  assert.equal(wrapper.vm.routesStore.opened?.draftId, draft.id, JSON.stringify({
    calls,
    error: wrapper.vm.routesStore.error,
    text: wrapper.text().slice(-1600),
  }));
  assert.equal(wrapper.find('[data-test="stage-add"]').exists(), true, 'Старый редактор доступен');

  return {
    wrapper,
    browser,
    route,
    calls,
    pending,
    draft,
    flushPromises: settle,
    store: wrapper.vm.routesStore,
    setLocale: globalThis.__stageWizard.setLocale,
  };
}

/**
 * Запрашивает мастер из существующего входа RoutesView и проверяет видимый результат.
 * На исходнике кнопка создаёт пустой этап: RED возникает на отсутствии диалога.
 */
export async function openWizard(fixture) {
  await fixture.wrapper.get('[data-test="stage-add"]').trigger('click');
  await fixture.flushPromises();

  const dialog = fixture.browser.document.querySelector('[role="dialog"]');

  assert.equal(Boolean(dialog), true, 'Добавить этап должно открыть мастер этапа');

  return dialog;
}

/**
 * В телепортированном диалоге нет wrapper.find: клики идут в реальные DOM-controls.
 * Отсутствующий элемент сравнивается скаляром, чтобы assert не печатал граф happy-dom.
 */
export async function click(fixture, selector) {
  const element = fixture.browser.document.querySelector(selector);

  assert.equal(Boolean(element), true, `Ожидается control ${selector}`);
  assert.equal(Boolean(element.disabled), false, `Control доступен: ${selector}`);
  element.dispatchEvent(new fixture.browser.MouseEvent('click', { bubbles: true, cancelable: true }));
  await fixture.flushPromises();
}

/**
 * Изменяет настоящее поле и посылает события native-контрола.
 * Продуктовый v-model обрабатывает значение тем же путём, что ввод человека.
 */
export async function field(fixture, selector, value) {
  const element = fixture.browser.document.querySelector(selector);

  assert.equal(Boolean(element), true, `Ожидается поле ${selector}`);
  element.value = value;
  element.dispatchEvent(new fixture.browser.Event('input', { bubbles: true }));
  element.dispatchEvent(new fixture.browser.Event('change', { bubbles: true }));
  await fixture.flushPromises();
}

/**
 * Проходит три шага по публичным контролам, оставляя реальное Apply отдельным действием.
 * Выбор места список/схема проверяется независимо от команды вставки.
 */
export async function chooseRole(fixture, role = 'review', after = 'build') {
  await openWizard(fixture);
  await click(fixture, `[data-test="wizard-role-${role}"]`);
  await click(fixture, '[data-test="wizard-next"]');

  if (role === 'custom') {
    await field(fixture, '[data-test="wizard-description"]', 'Проверь результат.\nСохрани отчёт.');
  }

  await click(fixture, '[data-test="wizard-next"]');
  await field(fixture, '[data-test="wizard-after"]', after);
}

/**
 * Отделяет содержимое от ревизии, которую меняет серверный ACK.
 * Undo обязан восстановить все файлы и связи этого содержимого.
 */
export function content(draft) {
  const { routes, bootstrap, bootstrapPrompts, presentation, provenance } = JSON.parse(JSON.stringify(draft));

  return {
    routes,
    bootstrap,
    bootstrapPrompts,
    presentation,
    provenance,
  };
}

/**
 * Разделяет начало запроса и ответ без таймеров и фонового сервиса.
 * Тест сам освобождает ожидание после изменения адресата или поколения.
 */
export function deferred() {
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });

  return { promise, resolve };
}
