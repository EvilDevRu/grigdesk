import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import type { TestContext } from 'node:test';
import { createUiBrowser } from './helpers/ui-components.js';
import { compileBoundary, terminalDoubles, viewHarness } from './helpers/compile-vue.js';

process.env.NODE_ENV = 'test';

type ExposedView = import('vue').ComponentPublicInstance & {
  document: unknown;
  error: string;
  resolveError: string;
  resolving: boolean;
  repos: unknown[];
  tasks: unknown[];
  factoryRunners: unknown[];
  comments: unknown[];
  load(): Promise<void>;
  loadSnapshot(): Promise<void>;
  loadComments(): Promise<void>;
  loadFactoryRunners(): void;
  shellIsReady(): boolean;
  editForm: object;
  editUsers: unknown[];
  editGroups: unknown[];
  clarifyDrafts: Record<string, {
    text: string;
    optionIds: string[];
    attachments: unknown[]
  }>;
  loadEditOptions(): Promise<void>;
  uploadClarifyFiles(question: string, files: Blob[]): Promise<void>;
};

const browser = await createUiBrowser();
const { mount, flushPromises }: typeof import('../../web/node_modules/@vue/test-utils') = await import(
  new URL('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs', import.meta.url).href
);

after(() => browser.close());

/**
 * Экран монтируется с настоящими refs/watchers; ошибки Vue фиксируются отдельно.
 * Публичное тестовое expose позволяет проверить состояние до зависимого рендера.
 */
async function mountBoundary(t: TestContext, file: string, expose: string[], props = {}, stubs = {}) {
  viewHarness.errors = [];

  const Component = await compileBoundary(file, expose, stubs);
  const wrapper = mount(Component, {
    props,
    global: {
      config: {
        errorHandler(error: unknown) {
          viewHarness.errors.push(error);
        },
      },
    },
  });

  t.after(() => wrapper.unmount());
  await flushPromises();

  return { wrapper, state: wrapper.vm as ExposedView };
}

test('NET-document', async (t) => {
  const valid = {
    ref: { source: 'project', path: 'readme.txt' },
    source: { id: 'project', label: 'Проект' },
    name: 'readme.txt',
    displayPath: 'readme.txt',
    content: 'Текст документа',
    format: 'text',
    size: 32,
    modifiedAt: '2026-01-01T00:00:00Z',
  };
  let reply: unknown = valid;
  const calls: string[] = [];

  viewHarness.api = {
    async get(url: string) {
      calls.push(url);

      return reply;
    },
  };

  const { wrapper, state } = await mountBoundary(t, 'src/features/documents/DocumentPanel.vue',
    ['document', 'error', 'load'], { source: 'project', path: 'readme.txt' });

  assert.deepEqual(state.document, valid);
  assert.match(wrapper.text(), /Текст документа/);
  assert.deepEqual(viewHarness.errors, []);

  for (const malformed of [
    { ...valid, format: 7 }, { ...valid, content: {} },
    { ...valid, ref: { source: [], path: 42 } },
  ]) {
    reply = malformed;
    await state.load();
    assert.equal(state.document, null, 'неверный file DTO не публикуется');
    assert.ok(state.error);
    assert.equal(wrapper.emitted('loaded')?.at(-1)?.[0], null);
  }

  assert.equal(calls.length, 4);
});

test('NET-document-resolve', async (t) => {
  const replacements: unknown[] = [];
  const previousRoute = viewHarness.route;
  const previousRouter = viewHarness.router;

  t.after(() => {
    viewHarness.route = previousRoute;
    viewHarness.router = previousRouter;
  });

  viewHarness.route = { query: { open: '/workspace/readme.txt' } };
  viewHarness.router = {
    replace(value?: unknown) {
      replacements.push(value);
    },
    push() {},
    back() {},
  };
  viewHarness.api = { post: async () => ({ ref: { source: 7, path: [] } }) };

  const { wrapper, state } = await mountBoundary(
    t, 'src/views/DocumentsView.vue', ['resolveError', 'resolving'],
  );

  assert.deepEqual(replacements, [], 'неверный DocumentRef не передаётся router.replace');
  assert.ok(state.resolveError);
  assert.equal(state.resolving, false);
});

test('NET-diff', async (t) => {
  let reply: unknown = { repos: [] };
  const calls: string[] = [];

  viewHarness.api = {
    async get(url: string) {
      calls.push(url);

      return reply;
    },
  };

  const { wrapper, state } = await mountBoundary(
    t, 'src/views/diff/DiffPanel.vue', ['repos', 'error', 'load'],
    { taskId: '42' }, {
      '../../shared/monaco.ts': `export const monaco = {editor: {
        createDiffEditor: () => ({dispose() {}, setModel() {}, updateOptions() {}}),
      }}; export const READONLY_OPTS = {}; export const langOf = () => 'text';`,
    });

  assert.deepEqual(state.repos, []);
  assert.equal(state.error, '');
  reply = { repos: 'bad' };
  await state.load();
  assert.deepEqual(state.repos, [], 'неверный список очищается штатной веткой ошибки');
  assert.ok(state.error);
  assert.deepEqual(calls, ['/api/tasks/42/diff', '/api/tasks/42/diff']);
});

test('NET-pipeline', async (t) => {
  let initial = true;
  let graph: unknown = {
    nodes: 'bad',
    statuses: {},
    progress: 'bad'
  };
  const calls: string[] = [];

  viewHarness.stores = {
    useUiStore: { openTask() {} },
    useTasksStore: { load: async () => ({}), title: () => 'Задача' },
    useBoardStore: { data: null, load() {} },
  };
  viewHarness.api = {
    /**
     * Первое чтение даёт пустой валидный снимок для штатного mount экрана.
     * Следующее отделяет ошибку графа от начальной загрузки и побочных запросов.
     */
    async get(url: string) {
      calls.push(url);

      if (url === '/api/tasks') {
        return { tasks: initial ? [] : [{ task: '42', title: 'Задача' }] };
      }

      return graph;
    },
  };

  const { wrapper, state } = await mountBoundary(t, 'src/views/PipelineView.vue',
    ['tasks', 'error', 'loadSnapshot', 'factoryRunners', 'loadFactoryRunners']);

  assert.equal(state.error, null);
  initial = false;
  await state.loadSnapshot();
  assert.deepEqual(state.tasks, [], 'неверный граф не попадает в свежий snapshot');
  assert.ok(state.error);
  graph = { runners: 'bad' };
  state.loadFactoryRunners();
  await flushPromises();
  assert.deepEqual(state.factoryRunners, []);
  assert.ok(calls.includes('/api/tasks/42/graph'));
});

for (const scenario of ['comments', 'lists', 'attachment']) {
  test(scenario === 'comments' ? 'NET-task' : `NET-task-${scenario}`, async (t) => {
    const { reactive }: typeof import('vue') = await import(
      new URL('../../web/node_modules/vue/dist/vue.runtime.esm-bundler.js', import.meta.url).href
    );
    const ui = reactive({ taskId: '42' as string | null });
    let reply: unknown = { comments: [] };
    const calls: string[] = [];

    viewHarness.stores = {
      useUiStore: ui,
      useTasksStore: { load: async () => ({ id: '42', title: 'Задача' }) },
      useBoardStore: { data: { tasks: [] } },
      usePluginsStore: { enabled: () => false, byId: () => ({ enabled: false }) },
      useTaskFavoritesStore: {
        load: async () => {},
        loaded: true,
        isFavorite: () => false,
        isPending: () => false
      },
      useTaskSeenStore: { markSeen: async () => {} },
      useTaskShelfStore: {
        loaded: true,
        entries: [],
        isOnShelf: () => false,
        isPending: () => false
      },
    };
    viewHarness.api = {
      async get(url: string) {
        calls.push(url);

        return reply;
      },
    };

    const { wrapper, state } = await mountBoundary(t, 'src/views/TaskModal.vue',
      ['comments', 'loadComments', 'taskId', 'editForm', 'editUsers', 'editGroups',
        'loadEditOptions', 'clarifyDrafts', 'uploadClarifyFiles'], {}, {
        pinia: 'import {toRefs} from "vue"; export const storeToRefs = toRefs;',
        '../actions/analysis': `export const useAnalysisStore = () => ({});
          export const analyzeTask = () => {}; export const readAnalysisDetail = () => {};`,
        '../shared/analysisApi.ts': 'export const analysisApi = {};',
        '../features/speech/provider.ts': `export const useDictationController = () => ({
          acquire: () => ({state: {}, cancel() {}, release() {}}),
        });`,
      });

    if (scenario === 'lists') {
      state.editForm = {};
      reply = { users: [{id: {}, name: []}], groups: [{id: [], name: 7}] };
      await state.loadEditOptions();
      assert.deepEqual(state.editUsers, []);
      assert.deepEqual(state.editGroups, []);

      return;
    }

    if (scenario === 'attachment') {
      state.clarifyDrafts = {question: {
        text: '',
        optionIds: [],
        attachments: []
      }};
      viewHarness.api.upload = async () => ({
        file: 7,
        name: 'Картинка',
        mime: 'image/png',
        url: '/api/chat/attachment/image.png'
      });
      await state.uploadClarifyFiles('question', [new Blob(['image'], {type: 'image/png'})]);
      assert.deepEqual(state.clarifyDrafts.question?.attachments, []);

      return;
    }

    await state.loadComments();
    assert.deepEqual(state.comments, []);
    reply = { comments: 'bad' };
    await state.loadComments();
    assert.deepEqual(state.comments, [], 'неверный список комментариев не попадает в UI');
    assert.equal(calls.filter((url) => url.endsWith('/comments')).length, 2);
  });
}

test('NET-terminal', async (t) => {
  const previousSocket = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');

  t.after(() => {
    if (previousSocket) {
      Object.defineProperty(globalThis, 'WebSocket', previousSocket);
    } else {
      Reflect.deleteProperty(globalThis, 'WebSocket');
    }
  });

  viewHarness.api = { wsUrl: (url: string) => `ws://terminal.test${url}` };

  const { wrapper, state } = await mountBoundary(t, 'src/views/terminal/TerminalPanel.vue',
    ['shellIsReady: () => shellReady'], { active: true }, terminalDoubles());
  const socket = viewHarness.sockets[0];
  const terminal = viewHarness.terminals[0];

  assert.ok(socket);
  assert.ok(terminal);
  socket.onmessage({ data: { bad: true } });
  assert.equal(terminal.writes.length, 0, 'объект не является выводом PTY');
  assert.equal(state.shellIsReady(), false);
  socket.onmessage({ data: '$ ' });
  assert.equal(terminal.writes[0], '$ ');
  assert.equal(state.shellIsReady(), true);
  socket.onmessage({ data: new Uint8Array([65]).buffer });

  const binary = terminal.writes[1];

  assert.ok(binary instanceof Uint8Array);
  assert.deepEqual([...binary], [65]);
});

test('NET-task-chat-attachment', async (t) => {
  const { chatUploadBoundaryFixture } = await import('./helpers/chat-session.js');
  const { wrapper, sessions, reply, calls } = await chatUploadBoundaryFixture(t);

  reply.value = {
    file: 42,
    name: 'Картинка',
    mime: 'image/png',
    url: '/api/chat/attachment/image.png'
  };
  await wrapper.vm.addFiles([new Blob(['image'], { type: 'image/png' })]);
  assert.deepEqual(sessions[0]?.draftAttachments, [], 'неверный attachment не попадает в черновик');
  assert.deepEqual(sessions[1]?.draftAttachments, []);
  assert.deepEqual(calls, ['/api/chat/upload']);
  assert.ok(wrapper.vm.inputErr);
});
