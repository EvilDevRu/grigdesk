import assert from 'node:assert/strict';
import test from 'node:test';

import { compileModule, compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

const EDITOR = webFile('src/views/routes/GraphWorkflowEditor.vue');

async function mountEditor(t, doc, props = {}) {
  const browser = await installUiBrowser(t);
  const [{ mount }, Editor] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(EDITOR),
  ]);
  const wrapper = mount(Editor, {
    attachTo: browser.document.querySelector('#mount'),
    props: { document: doc, busy: false, conflict: false, ...props },
  });

  t.after(() => wrapper.unmount());
  return { browser, wrapper };
}

test('автор задаёт кворум сборки и сохраняет использованную зависимость', async (t) => {
  const doc = {
    title: 'Отчёт', inputKind: 'documents',
    scope: {
      returns: ['out'],
      steps: [
        { id: 'a', title: 'Первый', kind: 'input' },
        { id: 'b', title: 'Второй', kind: 'input' },
        { id: 'out', title: 'Сборка', kind: 'join', needs: ['a'], mode: 'all' },
      ],
    },
  };
  const { wrapper } = await mountEditor(t, doc);
  const row = wrapper.get('[data-workflow-step="out"]');

  await row.get('[data-workflow-edge="b"] input').setValue(true);
  await row.get('[data-workflow-join-mode] select').setValue('quorum');
  await row.get('[data-workflow-min-success] input').setValue('2');
  await wrapper.get('[data-workflow-save]').trigger('click');

  const [[saved]] = wrapper.emitted('save');

  assert.deepEqual(saved.scope.steps[2], {
    id: 'out', title: 'Сборка', kind: 'join', needs: ['a', 'b'], mode: 'quorum', minSuccess: 2,
  });
  assert.deepEqual(doc.scope.steps[2].needs, ['a']);
});

test('создать вложенную ветку из пустого редактора', async (t) => {
  const doc = { title: '', inputKind: 'documents', scope: { steps: [], returns: [] } };
  const { wrapper } = await mountEditor(t, doc);

  await wrapper.get('[data-workflow-add]').trigger('click');
  const row = wrapper.get('[data-workflow-step="step-1"]');

  await row.get('select').setValue('forEach');
  await wrapper.get('[data-workflow-add]').trigger('click');
  await wrapper.get('[data-workflow-step="step-2"] select').setValue('input');
  await row.get('[data-workflow-edge="step-2"] input').setValue(true);
  await row.get('[data-workflow-from] select').setValue('step-2');
  await row.get('[data-workflow-parallelism] select').setValue('limited');
  await row.get('[data-workflow-parallelism] input').setValue('2');

  const scope = wrapper.vm.draft.scope.steps[0].scope;

  assert.ok(scope);
  await wrapper.get('[data-workflow-step="step-1"] [data-workflow-add]').trigger('click');
  const child = wrapper.get('[data-workflow-step="step-1"] [data-workflow-step="step-1"]');

  await child.get('select').setValue('call');
  await wrapper.get('[data-workflow-step="step-1"] [data-workflow-step="step-1"] [data-workflow-add]').trigger('click');
  await wrapper.get('[data-workflow-step="step-1"] [data-workflow-step="step-1"] [data-workflow-step="step-1"] select').setValue('agent');
  await wrapper.get('[data-workflow-step="step-1"] [data-workflow-step="step-1"] [data-workflow-step="step-1"] [data-workflow-return] input').setValue(true);
  await wrapper.get('[data-workflow-step="step-1"] [data-workflow-step="step-1"] [data-workflow-return] input').setValue(true);
  await wrapper.get('[data-workflow-save]').trigger('click');

  const [[saved]] = wrapper.emitted('save');
  const outer = saved.scope.steps[0];

  assert.equal(outer.kind, 'forEach');
  assert.equal(outer.source, 'step-2');
  assert.equal(outer.parallelism, 2);
  assert.deepEqual(outer.needs, ['step-2']);
  assert.equal(outer.scope.returns.length, 1);
  const inner = outer.scope.steps[0];

  assert.equal(inner.kind, 'call');
  assert.equal(inner.scope.steps[0].kind, 'agent');
  assert.equal(inner.scope.returns.length, 1);

  await wrapper.setProps({ document: structuredClone(saved) });
  assert.equal(row.get('[data-workflow-parallelism] input').element.value, '2');
  await row.get('[data-workflow-parallelism] select').setValue('all');
  assert.equal(wrapper.vm.draft.scope.steps[0].parallelism, undefined);
  assert.equal(row.find('[data-workflow-parallelism] input').exists(), false);
  await row.get('[data-workflow-parallelism] select').setValue('limited');
  await row.get('select').setValue('call');
  assert.equal(wrapper.vm.draft.scope.steps[0].parallelism, undefined);
});

test('условная ветка после повторного открытия и удаление связей', async (t) => {
  const doc = {
    title: 'Условия', inputKind: 'documents',
    scope: {
      returns: ['out'],
      steps: [
        { id: 'items', title: 'Список', kind: 'input' },
        { id: 'ifAdded', title: 'Если есть', kind: 'agent', needs: ['items'], prompt: 'x',
          when: { source: 'items', test: 'nonempty' } },
        { id: 'ifEmpty', title: 'Если пусто', kind: 'agent', needs: ['items'], prompt: 'y',
          when: { source: 'items', test: 'empty' } },
        { id: 'out', title: 'Сборка', kind: 'join', needs: ['ifAdded', 'ifEmpty'], mode: 'all' },
      ],
    },
  };
  const { wrapper } = await mountEditor(t, doc);

  assert.equal(wrapper.get('[data-workflow-step="ifAdded"] [data-workflow-condition-test] select').element.value, 'nonempty');
  assert.equal(wrapper.get('[data-workflow-step="ifEmpty"] [data-workflow-condition-test] select').element.value, 'empty');
  await wrapper.get('[data-workflow-step="ifAdded"] [data-workflow-edge="items"] input').setValue(false);
  await wrapper.get('[data-workflow-save]').trigger('click');

  const [[saved]] = wrapper.emitted('save');
  const changed = saved.scope.steps.find((step) => step.id === 'ifAdded');

  assert.deepEqual(changed.needs, []);
  assert.equal(changed.when, undefined);
  assert.equal(changed.reads, undefined);
});

test('прежняя правка не теряется после 409 и сохраняется копией', async (t) => {
  const doc = {
    title: 'Копия', inputKind: 'documents',
    scope: { returns: ['s'], steps: [{ id: 's', title: 'Источник', kind: 'input' }] },
  };
  const { wrapper } = await mountEditor(t, doc, { conflict: true });

  await wrapper.get('[data-workflow-title] input').setValue('Копия 2');
  assert.ok(wrapper.find('[data-workflow-save-copy]').exists());
  await wrapper.get('[data-workflow-save-copy]').trigger('click');

  const [[saved]] = wrapper.emitted('save-copy');

  assert.equal(saved.title, 'Копия 2');
  assert.equal(wrapper.vm.draft.title, 'Копия 2');
});

test('шаблоны доступны без Git на 390px и повторяют тот же UUID после потери ответа', async (t) => {
  const browser = await installUiBrowser(t);

  browser.happyDOM.setWindowSize({ width: 390, height: 844 });
  const posts = [];
  let loseResponse;
  const lost = new Promise((_resolve, reject) => {
    loseResponse = reject;
  });
  const store = {
    templates: [{ id: 'builtin-documents', revision: 'rev-1', builtIn: true, title: 'Разбор документов', inputKind: 'documents' }],
    templatesCursor: null,
    runs: [],
    runsCursor: null,
    models: [{ provider: 'claude', model: 'fake', label: 'Тестовая' }],
    run: null,
    details: null,
    result: null,
    resultNotice: null,
    resultLoading: false,
    pending: false,
    async loadTemplates() {},
    async loadModels() {},
    async loadRuns() {},
    async loadRunsMore() {},
    async openRun() {},
    async openNode() {},
    async openResult() {},
    async loadMoreResult() {},
    async act() {},
    async startRun(payload) {
      posts.push(payload);
      if (posts.length === 1) {
        return lost;
      }
      return payload.id;
    },
    subscribe() {},
    dispose() {},
  };

  globalThis.__graphLauncherStore = store;
  const [{ mount }, Launcher] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/views/pipeline/GraphWorkflowLauncher.vue'), {
      stubs: {
        '../../stores/graphWorkflows.ts': 'export function useGraphWorkflowsStore() { return globalThis.__graphLauncherStore; }',
      },
    }),
  ]);
  const wrapper = mount(Launcher, {
    attachTo: browser.document.querySelector('#mount'),
    global: { stubs: { teleport: true } },
  });

  t.after(() => {
    wrapper.unmount();
    delete globalThis.__graphLauncherStore;
  });
  await wrapper.get('[data-workflow-launch]').trigger('click');
  await wrapper.get('[data-workflow-launch-template] select').setValue('builtin-documents');
  await wrapper.get('[data-workflow-launch-model] select').setValue('claude/fake');
  assert.equal(wrapper.find('[data-workflow-launch-version]').exists(), false);

  const picker = wrapper.findComponent({ name: 'UiFilePicker' });

  picker.vm.$emit('change', [new browser.File(['# A\nодин'], 'a.md', { type: 'text/markdown' })]);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(wrapper.get('[data-workflow-launch-start]').attributes('disabled'), undefined);
  const start = wrapper.get('[data-workflow-launch-start]');

  await Promise.all([start.trigger('click'), start.trigger('click')]);
  assert.equal(posts.length, 1);
  loseResponse(new Error('Потерян ответ'));
  await new Promise((resolve) => setTimeout(resolve, 30));
  await start.trigger('click');
  assert.equal(posts.length, 2);
  assert.equal(posts[1].id, posts[0].id);
  assert.equal(posts[0].templateId, 'builtin-documents');
  assert.equal(posts[0].expectedRevision, 'rev-1');
  assert.deepEqual(posts[0].files, [{ name: 'a.md', text: '# A\nодин' }]);
  assert.ok(posts[0].id);
});

test('query workflow заполняет только поле выбора шаблона', async (t) => {
  const browser = await installUiBrowser(t);
  const store = {
    templates: [{ id: 'builtin-documents', revision: 'rev-1', builtIn: true, title: 'Разбор документов', inputKind: 'documents' }],
    templatesCursor: null,
    runs: [],
    runsCursor: null,
    models: [{ provider: 'claude', model: 'fake', label: 'Тестовая' }],
    run: null,
    details: null,
    result: null,
    resultNotice: null,
    resultLoading: false,
    pending: false,
    async loadTemplates() {},
    async loadModels() {},
    async loadRuns() {},
    async openRun() {},
    async openNode() {},
    async openResult() {},
    async loadMoreResult() {},
    async act() {},
    async startRun(payload) { return payload.id; },
    subscribe() {},
    dispose() {},
  };

  globalThis.__graphLauncherStore = store;
  globalThis.__graphLauncherRoute = { query: { workflow: 'builtin-documents' } };
  const [{ mount }, Launcher] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/views/pipeline/GraphWorkflowLauncher.vue'), {
      stubs: {
        '../../stores/graphWorkflows.ts': 'export function useGraphWorkflowsStore() { return globalThis.__graphLauncherStore; }',
        'vue-router': 'export const useRoute = () => globalThis.__graphLauncherRoute;'
          + ' export const useRouter = () => ({ push: async () => {} });',
      },
    }),
  ]);
  const wrapper = mount(Launcher, {
    attachTo: browser.document.querySelector('#mount'),
    global: { stubs: { teleport: true } },
  });

  t.after(() => {
    wrapper.unmount();
    delete globalThis.__graphLauncherStore;
    delete globalThis.__graphLauncherRoute;
  });
  await wrapper.get('[data-workflow-launch]').trigger('click');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(wrapper.get('[data-workflow-launch-template] select').element.value, 'builtin-documents');
  assert.equal(wrapper.get('[data-workflow-launch-model] select').element.value, '');
});

test('сохранение копии без ID создаёт новый UUID шаблона', async (t) => {
  const posts = [];

  globalThis.__graphEditorApi = {
    async get(url) {
      if (url.includes('/templates')) {
        return { templates: [], nextCursor: null };
      }
      throw Object.assign(new Error('нет'), { apiStatus: 404 });
    },
    async post(url, body) {
      posts.push([url, body]);
      return { id: body.id, revision: 'hash-1', builtIn: false, title: body.document.title, inputKind: body.document.inputKind };
    },
  };
  const { createPinia } = await import('../../web/node_modules/pinia/dist/pinia.mjs');
  const module = await compileModule(webFile('src/stores/graphWorkflows.ts'), {
    stubs: {
      '../shared/apiClient.ts': `
        export class ApiError extends Error {
          constructor(message, status, data) {
            super(message);
            this.status = status;
            this.data = data;
          }
        }
        const wrap = method => async (...args) => {
          try {
            return await globalThis.__graphEditorApi[method](...args);
          } catch (error) {
            if (error.apiStatus) {
              throw new ApiError(error.message, error.apiStatus, error.data);
            }
            throw error;
          }
        };
        export const api = { post: wrap('post'), get: wrap('get') };
        export const failureText = error => error.message;
      `,
      '../composables/useSse.ts': 'export function sseSubscribe() { return () => {}; }',
    },
  });
  const store = module.useGraphWorkflowsStore(createPinia());

  t.after(() => {
    delete globalThis.__graphEditorApi;
  });
  const document = {
    title: 'Копия', inputKind: 'documents',
    scope: { returns: ['s'], steps: [{ id: 's', title: 'Источник', kind: 'input' }] },
  };
  const header = await store.saveTemplate({ id: null, expectedRevision: null, document });
  const post = posts.find(([url]) => url.endsWith('/templates/save'));

  assert.match(post[1].id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
  assert.equal(header.id, post[1].id);
});

test('контроллер сохраняет граф через API и открывает принятую редакцию', async (t) => {
  const browser = await installUiBrowser(t);
  const requests = [];
  const saved = {
    id: 'a2372fd2-e591-41c8-964a-64d321e3c677',
    revision: 'hash-2',
    builtIn: false,
    title: 'Граф',
    inputKind: 'documents',
  };
  let document = {
    title: 'Граф', inputKind: 'documents',
    scope: { returns: ['s'], steps: [{ id: 's', title: 'Источник', kind: 'input' }] },
  };

  globalThis.__graphEditorApi = {
    async get(url) {
      requests.push(['GET', url]);
      if (url.includes('/templates/')) {
        return { ...saved, document };
      }
      if (url.includes('/templates')) {
        return { templates: [saved], nextCursor: null };
      }
      throw Object.assign(new Error('нет'), { apiStatus: 404 });
    },
    async post(url, body) {
      requests.push(['POST', url, body]);
      document = body.document;
      saved.revision = 'hash-2';
      return saved;
    },
  };
  const { createPinia } = await import('../../web/node_modules/pinia/dist/pinia.mjs');
  const module = await compileModule(webFile('src/stores/graphWorkflows.ts'), {
    stubs: {
      '../shared/apiClient.ts': `
        export class ApiError extends Error {
          constructor(message, status, data) {
            super(message);
            this.status = status;
            this.data = data;
          }
        }
        const wrap = method => async (...args) => {
          try {
            return await globalThis.__graphEditorApi[method](...args);
          } catch (error) {
            if (error.apiStatus) {
              throw new ApiError(error.message, error.apiStatus, error.data);
            }
            throw error;
          }
        };
        export const api = { post: wrap('post'), get: wrap('get') };
        export const failureText = error => error.message;
      `,
      '../composables/useSse.ts': 'export function sseSubscribe() { return () => {}; }',
    },
  });
  const store = module.useGraphWorkflowsStore(createPinia());
  const [{ mount }, Editor] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(EDITOR),
  ]);
  const wrapper = mount(Editor, {
    attachTo: browser.document.querySelector('#mount'),
    props: { document, busy: false, conflict: false },
  });

  t.after(() => {
    wrapper.unmount();
    delete globalThis.__graphEditorApi;
  });
  await wrapper.get('[data-workflow-add]').trigger('click');
  await wrapper.get('[data-workflow-step="step-1"] select').setValue('forEach');
  await wrapper.get('[data-workflow-step="step-1"] [data-workflow-edge="s"] input').setValue(true);
  await wrapper.get('[data-workflow-step="step-1"] [data-workflow-from] select').setValue('s');
  await wrapper.get('[data-workflow-step="step-1"] [data-workflow-join-mode] select').setValue('quorum');
  await wrapper.get('[data-workflow-step="step-1"] [data-workflow-min-success] input').setValue('1');
  await wrapper.get('[data-workflow-save]').trigger('click');
  const [[emitted]] = wrapper.emitted('save');

  await store.saveTemplate({ id: saved.id, expectedRevision: 'hash-1', document: emitted });
  const post = requests.find((entry) => entry[0] === 'POST');

  assert.equal(post[1], '/api/graph-workflows/templates/save');
  assert.equal(post[2].expectedRevision, 'hash-1');
  assert.equal(post[2].document.scope.steps[1].kind, 'forEach');
  assert.equal(post[2].document.scope.steps[1].mode, 'quorum');

  const reopened = await store.loadTemplateDocument(saved.id);

  assert.ok(requests.some((entry) => entry[0] === 'GET' && entry[1].includes('/templates/' + saved.id)));
  await wrapper.setProps({ document: reopened.document });
  assert.equal(wrapper.get('[data-workflow-step="step-1"] [data-workflow-join-mode] select').element.value, 'quorum');
});

test('вставка в дочернюю область сохраняет её шаги, смена вида удаляет прежние поля', async (t) => {
  const doc = {
    title: 'Вложенный редактор', inputKind: 'documents',
    scope: {
      returns: ['outer'],
      steps: [{
        id: 'outer', title: 'Подмаршрут', kind: 'call',
        scope: {
          returns: ['leaf'],
          steps: [{ id: 'leaf', title: 'Лист', kind: 'agent', prompt: 'Старый prompt' }],
        },
      }],
    },
  };
  const { wrapper } = await mountEditor(t, doc);
  const outer = wrapper.get('[data-workflow-step="outer"]');

  await outer.get('[data-workflow-insert-subflow]').trigger('click');
  await outer.get('[data-workflow-step="leaf"] select').setValue('input');
  await wrapper.get('[data-workflow-save]').trigger('click');

  const [[saved]] = wrapper.emitted('save');
  const child = saved.scope.steps[0].scope;

  assert.deepEqual(child.returns, ['leaf']);
  assert.deepEqual(child.steps.map((step) => step.kind), ['input', 'call']);
  assert.deepEqual(child.steps[0], { id: 'leaf', title: 'Лист', kind: 'input' });
});
