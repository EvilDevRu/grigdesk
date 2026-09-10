import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';

import { compileVue, webFile } from './compile-vue.js';

const VIEW = webFile('src/views/KnowledgeView.vue');
const BACKUP_TEXT = '{"schemaVersion":1,"snapshotHash":"snapshot-preview","records":[]}';
const API_STUB = `
  export const api = {
    get: (...args) => globalThis.__knowledgeApi.get(...args),
    post: (...args) => globalThis.__knowledgeApi.post(...args),
    put: (...args) => globalThis.__knowledgeApi.put(...args),
    del: (...args) => globalThis.__knowledgeApi.del(...args),
    download: (...args) => globalThis.__knowledgeApi.download(...args),
    upload: (...args) => globalThis.__knowledgeApi.upload(...args),
  };
`;
const UI_STUB = `
  import { defineComponent, h } from 'vue';
  const field = (tag, event = 'input') => defineComponent({
    inheritAttrs: false,
    props: { modelValue: { default: '' } },
    emits: ['update:modelValue'],
    setup(props, { attrs, emit, slots }) {
      return () => h(tag, {
        ...attrs,
        value: props.modelValue,
        [event === 'change' ? 'onChange' : 'onInput']:
          (value) => emit('update:modelValue', value.target.value),
      }, slots.default?.());
    },
  });
  const container = (tag = 'div') => defineComponent({
    inheritAttrs: false,
    setup(_props, { attrs, slots }) {
      return () => h(tag, attrs, slots.default?.());
    },
  });
  export const UiInput = field('input');
  export const UiSearchInput = field('input');
  export const UiSelect = field('select', 'change');
  export const UiTextarea = field('textarea');
  export const UiButton = container('button');
  export const UiField = container('label');
  export const UiFormActions = container();
  export const UiInlineMessage = container();
  export const UiSpinner = container();
  export const UiSelectableRow = container('button');
  export const UiFilePicker = defineComponent({
    inheritAttrs: false,
    emits: ['change', 'reset'],
    setup(_props, { attrs, emit, slots }) {
      return () => h('button', {
        ...attrs,
        'data-file-picker': '',
        onClick: () => emit('change', [globalThis.__knowledgeFile]),
      }, slots.default?.() || 'Импортировать');
    },
  });
  export const UiInlineConfirm = defineComponent({
    emits: ['confirm', 'cancel'],
    setup(_props, { attrs, emit, slots }) {
      return () => h('button', { ...attrs, onClick: () => emit('confirm') }, slots.default?.());
    },
  });
  export const confirmDialog = (...args) => globalThis.__knowledgeConfirm(...args);
`;
const ROUTER_STUB = `
  export const useRoute = () => globalThis.__knowledgeRoute;
  export const useRouter = () => globalThis.__knowledgeRouter;
`;
let componentPromise;

export function apiError(status, data) {
  const error = new Error(data.message || data.error || `HTTP ${status}`);
  error.status = status;
  error.data = data;
  return error;
}

async function component() {
  try {
    await access(VIEW);
  } catch (error) {
    assert.fail(`Страница знаний ещё не реализована: ${error.message}`);
  }
  componentPromise ||= compileVue(VIEW, {
    stubs: {
      './apiClient.ts': API_STUB,
      '../ui.ts': UI_STUB,
      'vue-router': ROUTER_STUB,
    },
  });
  return componentPromise;
}

async function installBrowser(t) {
  const { Window } = await import('../../../web/node_modules/happy-dom/lib/index.js');
  const browser = new Window({ url: 'http://cockpit.test/#/knowledge' });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    location: browser.location,
    Node: browser.Node,
    Document: browser.Document,
    DocumentFragment: browser.DocumentFragment,
    ShadowRoot: browser.ShadowRoot,
    Text: browser.Text,
    Comment: browser.Comment,
    Element: browser.Element,
    HTMLElement: browser.HTMLElement,
    HTMLButtonElement: browser.HTMLButtonElement,
    HTMLAnchorElement: browser.HTMLAnchorElement,
    HTMLInputElement: browser.HTMLInputElement,
    HTMLSelectElement: browser.HTMLSelectElement,
    HTMLTextAreaElement: browser.HTMLTextAreaElement,
    SVGElement: browser.SVGElement,
    Event: browser.Event,
    CustomEvent: browser.CustomEvent,
    Blob: browser.Blob,
    File: browser.File,
    FormData: browser.FormData,
    URL: browser.URL,
    getComputedStyle: browser.getComputedStyle.bind(browser),
  })) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  browser.document.body.innerHTML = '<div id="mount"></div>';
  t.after(() => browser.close());
  return browser;
}

export async function settle(flushPromises, cycles = 8) {
  for (let index = 0; index < cycles; index += 1) {
    await flushPromises();
  }
}

export async function mountKnowledgeView(t, {
  api,
  confirm = async () => true,
  routeId = undefined,
} = {}) {
  const browser = await installBrowser(t);
  const downloads = { created: [], revoked: [], clicked: [] };
  browser.URL.createObjectURL = (blob) => {
    downloads.created.push(blob);
    return `blob:knowledge-${downloads.created.length}`;
  };
  browser.URL.revokeObjectURL = (url) => downloads.revoked.push(url);
  browser.HTMLAnchorElement.prototype.click = function click() {
    downloads.clicked.push({ href: this.href, download: this.download });
  };
  const { reactive } = await import('../../../web/node_modules/vue/index.mjs');
  const route = reactive({ path: routeId ? `/knowledge/${routeId}` : '/knowledge', params: {} });
  if (routeId) {
    route.params.id = routeId;
  }
  const pushes = [];
  const router = {
    async push(target) {
      pushes.push(target);
      const path = typeof target === 'string' ? target : target?.path;
      const id = typeof target === 'object' ? target?.params?.id : path?.split('/')[2];
      route.path = path || (id ? `/knowledge/${id}` : '/knowledge');
      if (id) {
        route.params.id = id;
      } else {
        delete route.params.id;
      }
    },
  };
  globalThis.__knowledgeApi = api;
  globalThis.__knowledgeConfirm = confirm;
  globalThis.__knowledgeRoute = route;
  globalThis.__knowledgeRouter = router;
  globalThis.__knowledgeFile = new browser.File([BACKUP_TEXT], 'cockpit-knowledge-2026-08-30.json', {
    type: 'application/json',
  });
  const [{ mount, flushPromises }, view] = await Promise.all([
    import('../../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    component(),
  ]);
  const wrapper = mount(view, { attachTo: browser.document.querySelector('#mount') });
  t.after(() => {
    wrapper.unmount();
    delete globalThis.__knowledgeApi;
    delete globalThis.__knowledgeConfirm;
    delete globalThis.__knowledgeRoute;
    delete globalThis.__knowledgeRouter;
    delete globalThis.__knowledgeFile;
  });
  await settle(flushPromises);
  return {
    wrapper,
    browser,
    downloads,
    file: globalThis.__knowledgeFile,
    pushes,
    setRouteId(id) {
      route.path = id ? `/knowledge/${id}` : '/knowledge';
      if (id) {
        route.params.id = id;
      } else {
        delete route.params.id;
      }
    },
    flushPromises,
    settle: () => settle(flushPromises),
  };
}

export function button(wrapper, text) {
  const found = wrapper.findAll('button').find((item) => item.text().trim() === text);
  assert.ok(found, `не найдена кнопка «${text}»`);
  return found;
}
