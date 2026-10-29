import assert from 'node:assert/strict';
import { compileVue, webFile } from '../../helpers/compile-vue.js';
import { installUiBrowser } from '../../helpers/ui-components.js';
import { documentDto } from './cases.mjs';

/**
 * Разрешение ссылки и последующее чтение документа проходят настоящие watchers.
 * Сеть ограничена двумя синтетическими адресами, никакие файлы владельца не открываются.
 */
export async function mountResolvingDocument(t, modal) {
  const browser = await installUiBrowser(t);

  browser.document.body.insertAdjacentHTML('beforeend', '<div id="tb-slot"></div>');

  const { reactive } = await import('../../../../web/node_modules/vue/index.mjs');
  const { mount, flushPromises } = await import(
    '../../../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const pending = Promise.withResolvers();
  const calls = [];
  const route = reactive({ query: { open: '/fixture/readme.txt' } });
  const port = {
    route,
    preview: reactive({
      href: '#/documents?open=%2Ffixture%2Freadme.txt',
      close() {}
    }),
    api: {
      get(url) {
        calls.push(['GET', url]);
        assert.equal(url, '/api/documents/file?source=fixture&path=readme.txt');

        return Promise.resolve(documentDto);
      },
      /**
       * Ссылка разрешается единственным запросом с исходным путём из маршрута.
       * Чтение содержимого разрешено только после подтверждения этого ответа.
       */
      post(url, body) {
        calls.push(['POST', url, body]);
        assert.equal(url, '/api/documents/resolve');
        assert.deepEqual(body, { path: '/fixture/readme.txt' });

        return pending.promise;
      },
    },
  };

  globalThis.__loadingResolution = port;

  const api = `export const api = globalThis.__loadingResolution.api;
    export { failureText } from './src/shared/apiClient.ts';`;
  const component = await compileVue(webFile(modal ? 'src/views/DocumentModal.vue'
    : 'src/views/DocumentsView.vue'), { stubs: {
    'vue-router': `export const useRoute = () => globalThis.__loadingResolution.route;
      export const useRouter = () => ({
        replace: async (value) => { globalThis.__loadingResolution.route.query = value.query; },
      });`,
    '../stores/documentPreview.ts': `export const useDocumentPreviewStore = () =>
      globalThis.__loadingResolution.preview;`,
    '../shared/apiClient.ts': api,
    '../../shared/apiClient.ts': api,
    './apiClient.ts': api,
  } });
  const wrapper = mount(component, { global: { stubs: { teleport: true } } });

  t.after(() => {
    wrapper.unmount();
    delete globalThis.__loadingResolution;
  });
  await flushPromises();

  return {
    wrapper,
    pending,
    calls,
    async resolve() {
      pending.resolve(documentDto);
      await flushPromises();
      await flushPromises();
    },
  };
}
