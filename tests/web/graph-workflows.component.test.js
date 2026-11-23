import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { compileModule, compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

const RUN_ID = 'd11dce6a-b7cc-4654-96b4-3ea48ed46a81';

function node(id, parent, title, kind, status, slot, extra = {}) {
  return {
    id, parent, title, kind, status, generation: 1, slot,
    after: [], members: [], ...extra,
  };
}

async function mountRun(t, run, props = {}) {
  const browser = await installUiBrowser(t);
  const [{ mount }, Run] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/views/pipeline/GraphWorkflowRun.vue')),
  ]);
  const wrapper = mount(Run, {
    attachTo: browser.document.querySelector('#mount'),
    props: { run, ...props },
  });

  t.after(() => wrapper.unmount());
  return { browser, wrapper };
}

test('живой граф добавляет обе ветки в открытую карточку и сохраняет выбранную группу', async (t) => {
  const root = {
    id: 'files', parent: '', title: 'Документы', kind: 'forEach', generation: 1,
    status: 'pending', after: [], members: [], slot: 0,
  };
  const base = {
    id: RUN_ID, title: 'Пакет',
    templateId: 'builtin-documents', revision: 1, status: 'running', nodes: [root],
  };
  const { wrapper } = await mountRun(t, base);

  await wrapper.get('[data-node="files"]').trigger('click');
  const child = (ordinal, title) => ({
    id: 'files.' + ordinal + '.read', parent: 'files', title, kind: 'agent',
    generation: 1, status: 'running', after: ['files'], members: [], slot: ordinal,
  });
  const a = child(1, 'Первый документ');
  const b = child(2, 'Второй документ');
  const group = { ...root, status: 'running', members: [a.id, b.id], outputs: [a.id, b.id] };
  const join = { ...root, id: 'out', kind: 'join', title: 'Сборка', slot: 3,
    after: ['files'], status: 'pending', members: [] };

  await wrapper.setProps({ run: { ...base, revision: 2, nodes: [group, a, b, join] } });

  assert.equal(wrapper.get('[data-workflow-selection]').attributes('data-workflow-selection'), 'files');
  assert.ok(wrapper.get('[data-node="files.1.read"]').text().includes('Первый документ'));
  assert.ok(wrapper.get('[data-node="files.2.read"]').text().includes('Второй документ'));
  assert.equal(wrapper.find('[data-source="files.1.read"][data-destination="out"]').exists(), true);
  assert.equal(wrapper.find('[data-source="files.2.read"][data-destination="out"]').exists(), true);
  await wrapper.get('[data-node="files"]').trigger('click');
  assert.equal(wrapper.find('[data-node="files.2.read"]').exists(), false);
  assert.equal(wrapper.find('[data-source="files"][data-destination="out"]').exists(), true);
});

test('группа из 20 результатов даёт сводку и переход к ошибке', async (t) => {
  const members = Array.from({ length: 20 }, (_, index) => 'files.' + (index + 1) + '.a');
  const children = members.map((id, index) => node(id, 'files', 'Лист ' + (index + 1), 'agent',
    index === 4 ? 'failed' : 'done', index + 1, { after: ['files'], errorCode: index === 4 ? 'run_failed' : undefined }));
  const group = node('files', '', 'Документы', 'forEach', 'running', 0, {
    members, outputs: members, counts: { total: 20, done: 19, running: 0, failed: 1 },
  });
  const run = { id: RUN_ID, title: 'Пакет', templateId: 'builtin-documents', revision: 1,
    status: 'running', nodes: [group, ...children] };
  const { wrapper } = await mountRun(t, run);

  assert.ok(wrapper.get('[data-node="files"]').text().includes('19'));
  assert.equal(wrapper.find('[data-node="files.5.a"]').exists(), false);
  wrapper.vm.openNode('files.5.a');
  await wrapper.vm.$nextTick();
  assert.equal(wrapper.get('[data-workflow-selection]').attributes('data-workflow-selection'), 'files.5.a');
  assert.ok(wrapper.get('[data-node="files.5.a"]').exists());
  assert.ok(wrapper.get('[data-workflow-error]').text().length > 0);
});

test('ожидание человека видимо при работающей сестринской ветке', async (t) => {
  const review = node('review', '', 'Утверждение', 'approval', 'waiting', 1, { after: ['work'] });
  const work = node('work', '', 'Модель', 'agent', 'running', 0);
  const run = { id: RUN_ID, title: 'Встреча', templateId: 'builtin-meeting', revision: 2,
    status: 'running', nodes: [work, review] };
  const details = {
    id: 'review', generation: 1, revision: 2, status: 'waiting', rows: [], attempts: 0,
    inputs: [], approval: { state: 'pending', reviewActions: { approve: true, rejectMode: 'close', targets: [] } },
  };
  const { wrapper } = await mountRun(t, run, { selectionDetails: details });

  await wrapper.get('[data-node="review"]').trigger('click');
  assert.ok(wrapper.get('[data-workflow-selection]').text().includes('Ждёт решения'));
  assert.ok(wrapper.find('[data-workflow-approve]').exists());
  assert.ok(wrapper.find('[data-workflow-reject]').exists());
  assert.ok(wrapper.get('[data-node="work"]').exists());
});

test('раскрытие и выбор сохраняются при 390 px после обновления снимка', async (t) => {
  const root = node('files', '', 'Документы', 'forEach', 'running', 0, {
    members: ['files.1.a', 'files.2.a'], outputs: ['files.1.a', 'files.2.a'],
  });
  const a = node('files.1.a', 'files', 'Первый', 'agent', 'running', 1, { after: ['files'] });
  const b = node('files.2.a', 'files', 'Второй', 'agent', 'done', 2, { after: ['files'] });
  const base = { id: RUN_ID, title: 'Пакет', templateId: 'builtin-documents', revision: 1,
    status: 'running', nodes: [root, a, b] };
  const { browser, wrapper } = await mountRun(t, base);

  browser.happyDOM.setWindowSize({ width: 390, height: 844 });
  await wrapper.get('[data-node="files.1.a"]').trigger('click');
  assert.equal(wrapper.get('[data-workflow-selection]').attributes('data-workflow-selection'), 'files.1.a');
  await wrapper.setProps({ run: { ...base, revision: 2, nodes: [root, { ...a, status: 'done' }, b] } });
  assert.equal(wrapper.get('[data-workflow-selection]').attributes('data-workflow-selection'), 'files.1.a');
  assert.ok(wrapper.get('[data-node="files.2.a"]').exists());
  assert.equal(browser.innerWidth, 390);
});

test('реальный экземпляр sandbox доступен с клавиатуры и открывает ошибку по Enter', async (t) => {
  const sandbox = node('sandbox', '', 'Стенд', 'agent', 'failed', 0, { errorCode: 'run_failed' });
  const run = { id: RUN_ID, title: 'Пакет', templateId: 'builtin-documents', revision: 1,
    status: 'failed', nodes: [sandbox] };
  const { wrapper } = await mountRun(t, run);
  const target = wrapper.get('[data-node="sandbox"]');

  assert.equal(target.attributes('role'), 'button');
  await target.trigger('keydown', { key: 'Enter' });
  assert.equal(wrapper.get('[data-workflow-selection]').attributes('data-workflow-selection'), 'sandbox');
  assert.ok(wrapper.find('[data-workflow-retry]').exists());
});

async function storeFixture(t, control) {
  const { createPinia } = await import('../../web/node_modules/pinia/dist/pinia.mjs');

  globalThis.__graphFixture = control;
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
            return await globalThis.__graphFixture[method](...args);
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
      '../composables/useSse.ts': `
        export function sseSubscribe(fn) {
          globalThis.__graphSse = fn;
          return () => {};
        }
      `,
    },
  });

  t.after(() => {
    delete globalThis.__graphFixture;
    delete globalThis.__graphSse;
  });
  return module.useGraphWorkflowsStore(createPinia());
}

test('поздний снимок ревизии 2 после 3 и поздняя деталь другого прогона игнорируются', async (t) => {
  let releaseOld;
  const old = new Promise((resolve) => {
    releaseOld = resolve;
  });
  const graph = (revision) => ({
    id: RUN_ID, title: 'Пакет', templateId: 'builtin-documents', revision,
    status: 'running', nodes: [],
  });
  const store = await storeFixture(t, {
    async get(url) {
      if (url.endsWith('/runs/' + RUN_ID)) {
        return graph(3);
      }
      if (url.includes('/nodes/')) {
        return { id: 'a', generation: 1, revision: 3, status: 'running', rows: [], attempts: 0, inputs: [] };
      }
      throw Object.assign(new Error('нет'), { apiStatus: 404 });
    },
    async post() {
      return {};
    },
  });

  await store.openRun(RUN_ID);
  assert.equal(store.run.revision, 3);
  const pendingNode = store.openNode('a');

  await store.openRun('b1690525-b349-422c-a165-778def939e5c');
  releaseOld();
  await pendingNode;
  assert.equal(store.details, null);
  assert.equal(store.currentId, 'b1690525-b349-422c-a165-778def939e5c');
  void old;
});

test('поздняя деталь того же поколения не перекрывает новую ошибку', async (t) => {
  let releaseOld;
  const old = new Promise((resolve) => {
    releaseOld = resolve;
  });
  const store = await storeFixture(t, {
    async get(url) {
      if (url.endsWith('/runs/' + RUN_ID)) {
        return { id: RUN_ID, title: 'Пакет', templateId: 'builtin-documents', revision: 3,
          status: 'failed', nodes: [{ id: 'a', parent: '', title: 'A', kind: 'agent',
            status: 'failed', generation: 1, slot: 0, after: [], members: [], errorCode: 'run_failed' }] };
      }
      if (url.includes('/nodes/')) {
        await old;
        return { id: 'a', generation: 1, revision: 2, status: 'running', rows: [], attempts: 0, inputs: [] };
      }
      throw Object.assign(new Error('нет'), { apiStatus: 404 });
    },
    async post() {
      return {};
    },
  });

  await store.openRun(RUN_ID);
  const pendingNode = store.openNode('a');

  await store.refreshCurrent();
  assert.equal(store.run.revision, 3);
  releaseOld();
  await pendingNode;
  assert.equal(store.details, null);
  assert.equal(store.run.nodes[0].status, 'failed');
});

test('результат дочитывается по курсорам до конца и заменяется после 409', async (t) => {
  const rows = Array.from({ length: 9 }, (_, index) => ({
    key: 'row-' + (index + 1), title: 'Строка ' + (index + 1), text: 'текст ' + (index + 1),
  }));
  let changed = false;
  const store = await storeFixture(t, {
    async get(url) {
      if (url.includes('/result')) {
        const cursor = new URL(url, 'http://local').searchParams.get('cursor');

        if (changed && cursor) {
          throw Object.assign(new Error('result_changed'), { apiStatus: 409 });
        }
        if (!cursor) {
          return { revision: 5, incomplete: false, nextCursor: 'c2', inputs: [],
            rows: rows.slice(0, 4), missing: [], approvals: [] };
        }
        if (cursor === 'c2') {
          return { revision: 5, incomplete: false, nextCursor: null, inputs: [],
            rows: rows.slice(4), missing: [], approvals: [] };
        }
      }
      if (url.endsWith('/runs/' + RUN_ID)) {
        return { id: RUN_ID, title: 'Пакет', templateId: 'builtin-documents', revision: 5,
          status: 'done', nodes: [] };
      }
      throw Object.assign(new Error('нет'), { apiStatus: 404 });
    },
    async post() {
      return {};
    },
  });

  await store.openRun(RUN_ID);
  await store.openResult(RUN_ID);
  assert.equal(store.result.rows.length, 4);
  assert.equal(store.result.nextCursor, 'c2');
  await store.loadMoreResult();
  assert.equal(store.result.rows.length, 9);
  assert.equal(new Set(store.result.rows.map((row) => row.key)).size, 9);
  assert.equal(store.result.nextCursor, null);

  changed = true;
  await store.openResult(RUN_ID);
  await store.loadMoreResult();
  assert.equal(store.result.rows.length, 4);
  assert.ok(store.resultNotice);
});

test('источник открывается по точному inputKey и выделяет строку 2', async (t) => {
  const browser = await installUiBrowser(t);
  const [{ mount }, Run] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/views/pipeline/GraphWorkflowRun.vue'), {
      stubs: {
        '../../shared/apiClient.ts': `
          export const api = {
            async get(url) {
              globalThis.__graphSourceUrl = url;
              return {
                key: 'file-1', name: 'meeting.json', text: '',
                segments: [
                  { line: 1, timeMs: 12000, text: ' ' },
                  { line: 2, timeMs: 12000, text: 'Решили проверить отчёт' },
                ],
              };
            },
          };
          export class ApiError extends Error {}
        `,
      },
    }),
  ]);
  const review = node('review', '', 'Ворота', 'approval', 'waiting', 0);
  const run = { id: RUN_ID, title: 'Встреча', templateId: 'builtin-meeting', revision: 1,
    status: 'waiting', nodes: [review] };
  const details = {
    id: 'review', generation: 1, revision: 1, status: 'waiting', attempts: 0, inputs: [],
    rows: [{ key: 'row-1', title: 'Решение', text: 'Проверить отчёт',
      sources: [{ inputKey: 'file-1', line: 2, timeMs: 12000 }] }],
    approval: { state: 'pending', reviewActions: { approve: true, rejectMode: 'close', targets: [] } },
  };
  const wrapper = mount(Run, {
    attachTo: browser.document.querySelector('#mount'),
    props: { run, selectionDetails: details },
  });

  t.after(() => {
    wrapper.unmount();
    delete globalThis.__graphSourceUrl;
  });
  await wrapper.get('[data-node="review"]').trigger('click');
  await wrapper.get('.gw-source').trigger('click');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(globalThis.__graphSourceUrl.includes('/inputs/file-1'));
  const active = wrapper.get('[data-workflow-source-line="2"]');

  assert.ok(active.classes().includes('gw-line-active'));
  assert.ok(active.text().includes('Решили проверить отчёт'));
});
test('пороговый SVG меняет рёбра сборки с 3 на 2 и сохраняет поздний отказ', async (t) => {
  const fixture = (name) => readFile(new URL('../fixtures/graph-workflow/' + name + '.json', import.meta.url), 'utf8').then(JSON.parse);
  const open = await fixture('quorum-open');
  const met = await fixture('quorum-met');
  const late = await fixture('quorum-late-failure');
  const { browser, wrapper } = await mountRun(t, open);

  browser.happyDOM.setWindowSize({ width: 390, height: 844 });
  const reportPaths = () => wrapper.findAll('[data-destination="report"] path').length;
  const reportSources = () => wrapper.findAll('g[data-destination="report"]').map((g) => g.attributes('data-source'));

  assert.equal(reportPaths(), 3);
  assert.deepEqual(reportSources().sort(), ['files.1.a', 'files.2.a', 'files.3.a']);
  await wrapper.get('[data-node="files.2.a"]').trigger('click');
  const zoomBefore = wrapper.find('svg.graph').exists();

  await wrapper.setProps({ run: met });
  assert.equal(reportPaths(), 2);
  assert.deepEqual(reportSources().sort(), ['files.2.a', 'files.3.a']);
  assert.equal(wrapper.get('[data-workflow-selection]').attributes('data-workflow-selection'), 'files.2.a');
  assert.equal(zoomBefore, true);

  await wrapper.setProps({ run: late });
  assert.equal(reportPaths(), 2);
  const failed = wrapper.get('[data-node="files.1.a"]');

  assert.equal(failed.attributes('role'), 'button');
  await failed.trigger('click');
  assert.ok(wrapper.get('[data-workflow-error]').text().length > 0);
  await wrapper.get('[data-node="files"]').trigger('click');
  assert.equal(wrapper.findAll('[data-destination="report"] path').length, 1);
  assert.equal(wrapper.get('g[data-destination="report"]').attributes('data-source'), 'files');
  await wrapper.get('[data-node="files"]').trigger('click');
  assert.equal(wrapper.findAll('[data-destination="report"] path').length, 2);
});


test('новое поколение ворот ждёт нового текста перед решением', async (t) => {
  const review = node('review', '', 'Утверждение', 'approval', 'waiting', 1);
  const run = {
    id: RUN_ID, title: 'Проверка', templateId: 'builtin-meeting',
    revision: 4, status: 'waiting', nodes: [review],
  };
  const details = {
    id: 'review', generation: 1, revision: 4, status: 'waiting', attempts: 0, inputs: [],
    rows: [{ key: 'old', title: 'Старый текст', text: 'Первая версия' }],
    approval: { state: 'pending', reviewActions: { approve: true, rejectMode: 'close', targets: [] } },
  };
  const { wrapper } = await mountRun(t, run, { selectionDetails: details });

  await wrapper.get('[data-node="review"]').trigger('click');
  assert.ok(wrapper.get('[data-workflow-selection]').text().includes('Первая версия'));
  assert.ok(wrapper.find('[data-workflow-approve]').exists());

  await wrapper.setProps({ run: { ...run, revision: 5, nodes: [{ ...review, generation: 2 }] } });
  assert.equal(wrapper.find('[data-workflow-approve]').exists(), false);
  assert.equal(wrapper.get('[data-workflow-selection]').text().includes('Первая версия'), false);
  assert.equal(wrapper.emitted('select').length, 2);

  await wrapper.setProps({ selectionDetails: {
    ...details, revision: 5, generation: 2,
    rows: [{ key: 'new', title: 'Новый текст', text: 'Вторая версия' }],
  } });
  assert.ok(wrapper.get('[data-workflow-selection]').text().includes('Вторая версия'));
  await wrapper.get('[data-workflow-approve]').trigger('click');

  assert.deepEqual(wrapper.emitted('action'), [[{
    nodeId: 'review', generation: 2, expectedRevision: 5, action: 'approve',
  }]]);
});

test('быстрый выбор запускает GET второй карточки до ответа первой', async (t) => {
  let finishFirst;
  const first = new Promise((resolve) => {
    finishFirst = resolve;
  });
  const other = 'second';
  const graph = (id) => ({ id, revision: 1, status: 'done', nodes: [] });
  const store = await storeFixture(t, {
    async get(url) {
      return url.endsWith(RUN_ID) ? first : graph(other);
    },
  });

  const delayed = store.openRun(RUN_ID);
  await store.openRun(other);
  assert.equal(store.run.id, other);

  finishFirst(graph(RUN_ID));
  await delayed;
  assert.equal(store.run.id, other);
});

test('каталог загружает шаблоны после первой страницы', async (t) => {
  const store = await storeFixture(t, {
    async get(url) {
      return url.endsWith('?cursor=next')
        ? { templates: [{ id: 'second-page' }], nextCursor: null }
        : { templates: [{ id: 'first-page' }], nextCursor: 'next' };
    },
  });

  await store.loadTemplates();
  assert.deepEqual(store.templates.map((item) => item.id), ['first-page', 'second-page']);
});
