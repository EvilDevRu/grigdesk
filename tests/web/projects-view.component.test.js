import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.NODE_ENV = 'test';

const PROJECTS_VIEW_PATH = fileURLToPath(
  new URL('../../web/src/views/ProjectsView.vue', import.meta.url),
);
const VUE_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/node_modules/vue/index.mjs', import.meta.url),
)).href;

async function compileProjectsView() {
  const { parse, compileScript } = await import(
    '../../web/node_modules/@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js'
  );
  const source = await readFile(PROJECTS_VIEW_PATH, 'utf8');
  const { descriptor, errors } = parse(source, { filename: PROJECTS_VIEW_PATH });
  assert.deepEqual(errors, []);
  let code = compileScript(descriptor, {
    id: 'data-v-projects-review-status-test',
    inlineTemplate: true,
  }).content;

  code = code
    .replaceAll('from "vue"', `from "${VUE_URL}"`)
    .replaceAll("from 'vue'", `from "${VUE_URL}"`)
    .replace(
      "import { useRouter } from 'vue-router';",
      'const useRouter = () => ({ push() {} });',
    )
    .replace(
      "import { api } from '../shared/api-client.js';",
      'const api = globalThis.__projectsReviewStatusApi;',
    )
    .replace(
      "import { alertDialog } from '../shared/ui/confirm.js';",
      'const alertDialog = async () => {};',
    )
    .replace(
      "import HelpTip from '../shared/ui/HelpTip.vue';",
      'const HelpTip = { name: "HelpTip", template: "<span></span>" };',
    );

  return (await import(
    `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
  )).default;
}

test('ProjectsView явно показывает деградацию review status и экранирует её текст', async (t) => {
  const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
  const browser = new Window({ url: 'http://cockpit.test/#/projects' });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    location: browser.location,
    localStorage: browser.localStorage,
    Node: browser.Node,
    Element: browser.Element,
    HTMLElement: browser.HTMLElement,
    SVGElement: browser.SVGElement,
    Event: browser.Event,
    CustomEvent: browser.CustomEvent,
    getComputedStyle: browser.getComputedStyle.bind(browser),
  })) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  browser.document.body.innerHTML = '<div id="mount"></div>';
  globalThis.__projectsReviewStatusApi = {
    async get() {
      return {
        projects: [{
          id: 'demo',
          factory: false,
          reviewReady: false,
          routes: [],
          repos: [{
            key: 'app',
            dir: '/workspace/app',
            exists: true,
            github: { confirmed: true, slug: 'team/app' },
            reviewStatus: null,
            reviewStatusError: {
              code: 'REVIEW_STATUS_UNAVAILABLE',
              message: 'Состояние ревью временно недоступно <img src=x onerror=alert(1)>',
            },
          }, {
            key: 'fixable',
            dir: '/workspace/fixable',
            exists: true,
            github: { confirmed: true, slug: 'team/fixable' },
            reviewStatus: {
              openPullRequests: 2,
              attentionPullRequests: 1,
              canFix: true,
              reviewRoute: {
                profileId: 'demo',
                routeId: 'review-fix',
                stages: ['BUILD', 'VERIFY', 'GATE_ACCEPT'],
                revision: 'factory-review-route:v1:secret-technical-revision',
              },
              configurationError: null,
            },
          }, {
            key: 'readonly',
            dir: '/workspace/readonly',
            exists: true,
            github: { confirmed: true, slug: 'team/readonly' },
            reviewStatus: {
              openPullRequests: 0,
              attentionPullRequests: 0,
              canFix: false,
              reviewRoute: null,
              configurationError: {
                code: 'REVIEW_ROUTE_INVALID_TECHNICAL_CODE',
                message: 'Маршрут исправления для проекта ещё не настроен',
              },
            },
          }],
        }],
      };
    },
  };
  t.after(() => {
    delete globalThis.__projectsReviewStatusApi;
    browser.close();
  });

  const [{ mount, flushPromises }, ProjectsView] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileProjectsView(),
  ]);
  const wrapper = mount(ProjectsView, {
    attachTo: browser.document.querySelector('#mount'),
  });
  t.after(() => wrapper.unmount());
  await flushPromises();

  const warning = wrapper.find('[role="alert"].review-status-error');
  assert.ok(warning.exists());
  assert.match(warning.text(), /Состояние ревью временно недоступно/);
  assert.equal(warning.element.querySelector('img'), null);
  assert.equal(wrapper.element.querySelector('[onerror]'), null);
  assert.match(wrapper.text(), /может исправлять через demo\/review-fix/);
  assert.match(wrapper.text(), /только просмотр: Маршрут исправления для проекта ещё не настроен/);
  assert.doesNotMatch(wrapper.text(), /REVIEW_ROUTE_INVALID_TECHNICAL_CODE/);
  assert.doesNotMatch(wrapper.text(), /secret-technical-revision/);
  assert.doesNotMatch(wrapper.text(), /GATE_ACCEPT/);
});
