import assert from 'node:assert/strict';
import test from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { createUiBrowser } from './helpers/ui-components.js';
import { measured } from './helpers/performance-surface.js';

const browser = await createUiBrowser();

test.after(() => browser.close());

const API_STUB = `
  export const api = { get: (url) => globalThis.__docDiagApi.get(url),
    post: (url, body) => globalThis.__docDiagApi.post(url, body) };
  export const failureText = (error) => error.message;
`;
const DOCS_API_STUB = `
  export const documentsApi = {
    resolve: (open, scope) => globalThis.__docDiagApi.resolve(open, scope),
  };
`;
const TEST_UTILS = '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs';

test('PERF: страница документа объявляет resolve, отказ даёт error', async (t) => {
  globalThis.__docDiagRoute = { query: { open: 'docs/x.md' } };
  globalThis.__docDiagApi = {
    get: async () => {
      throw new Error('file down');
    },
    post: async () => {
      throw new Error('resolve down');
    },
    resolve: async () => {
      throw new Error('resolve down');
    },
  };

  const { mount, flushPromises } = await import(TEST_UTILS);
  const View = await compileVue(webFile('src/views/DocumentsView.vue'), {
    stubs: {
      '../shared/apiClient.ts': API_STUB,
      'vue-router': `export const useRoute = () => globalThis.__docDiagRoute;
        export const useRouter = () => ({ replace: async () => {} });`,
    },
  });
  const wrapper = mount(View, { attachTo: document.querySelector('#mount') });

  t.after(() => {
    wrapper.unmount();
    delete globalThis.__docDiagApi;
    delete globalThis.__docDiagRoute;
  });
  await flushPromises();

  const f = measured(t, wrapper, 'document', 'route');

  await f.paint();
  assert.equal(f.log.snapshot().entries.at(-1).data.phase, 'error');
});

test('PERF: DocumentPanel error получает повтор через data-perf-pending и новый итог',
  async (t) => {
  
    let attempts = 0;
    let release;

    globalThis.__docDiagApi = {
      get: async () => {
        attempts += 1;

        if (attempts === 1) {
          throw new Error('file down');
        }

        return new Promise((_resolve, reject) => {
          release = reject;
        });
      },
      post: async () => {
        throw new Error('unused');
      },
    };

    const { mount, flushPromises } = await import(TEST_UTILS);
    const Panel = await compileVue(webFile('src/features/documents/DocumentPanel.vue'), {
      stubs: { '../../shared/apiClient.ts': API_STUB },
    });
    const wrapper = mount(Panel, {
      props: {
        source: 'workspace',
        path: 'docs/x.md',
        anchor: '',
        line: 0
      },
      attachTo: document.querySelector('#mount'),
    });

    t.after(() => {
      wrapper.unmount();
      delete globalThis.__docDiagApi;
    });

    const f = measured(t, wrapper, 'document', 'dialog');

    await flushPromises();
    await f.paint();

    const failure = f.log.snapshot().entries.at(-1).data;

    assert.equal(failure.phase, 'error');

    const retry = wrapper.findAll('button').find((button) => button.text() === 'Повторить');

    assert.ok(retry);
    await retry.trigger('click');
    await flushPromises();
    await f.paint();
    assert.equal(f.log.snapshot().entries.at(-1).data.phase, 'start');
    release(new Error('file down again'));
    await flushPromises();
    await f.paint();

    const last = f.log.snapshot().entries.at(-1).data;

    assert.equal(last.phase, 'error');
    assert.notEqual(last.surface, failure.surface);
  });

test('PERF: диалог документа объявляет resolve, отказ и повтор дают error в диалоге',
  async (t) => {
  
    const { createPinia, setActivePinia } = await import(
      '../../web/node_modules/pinia/dist/pinia.mjs');
    const { useDocumentPreviewStore } = await import('../../web/src/stores/documentPreview.ts');
    const { mount, flushPromises } = await import(TEST_UTILS);
    const pinia = createPinia();

    setActivePinia(pinia);

    let attempts = 0;
    let release;

    globalThis.__docDiagApi = {
      get: async () => {
        throw new Error('file down');
      },
      post: async () => {
        throw new Error('resolve down');
      },
      resolve: async () => {
        attempts += 1;

        if (attempts === 1) {
          throw new Error('resolve down');
        }

        return new Promise((_resolve, reject) => {
          release = reject;
        });
      },
    };

    const Modal = await compileVue(webFile('src/views/DocumentModal.vue'), {
      stubs: { '../shared/documentsApi.ts': DOCS_API_STUB },
    });
    const wrapper = mount(Modal, {
      attachTo: document.querySelector('#mount'),
      global: { plugins: [pinia] },
    });

    t.after(() => {
      wrapper.unmount();
      delete globalThis.__docDiagApi;
    });
    useDocumentPreviewStore().show('#/documents?open=docs/x.md');
    await flushPromises();

    const f = measured(t, { element: null }, 'document', 'dialog',
      document.querySelector('.document-dialog'));

    await f.paint();

    const failure = f.log.snapshot().entries.at(-1).data;

    assert.equal(failure.phase, 'error');
    useDocumentPreviewStore().show('#/documents?open=docs/y.md');
    await flushPromises();
    await f.paint();
    assert.equal(f.log.snapshot().entries.at(-1).data.phase, 'start');
    release(new Error('resolve down again'));
    await flushPromises();
    await f.paint();

    const last = f.log.snapshot().entries.at(-1).data;

    assert.equal(last.phase, 'error');
    assert.notEqual(last.surface, failure.surface);
  });
