import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { compileVue, webFile } from './helpers/compile-vue.js';

process.env.NODE_ENV = 'test';

// Маршрутный CodeView теперь только adapter. Состояние и Monaco живут в единственном
// CodePanel, поэтому компонентные контракты проверяем непосредственно на нём.
const VIEW_PATH = webFile('src/views/code/CodePanel.vue');
let sharedBrowser = null;

after(() => {
  sharedBrowser?.close();
  sharedBrowser = null;
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function mainTree(path, branch = 'main') {
  return { path, main: true, name: 'основной', task: '', branch };
}

function worktree(path, name, branch, task = '') {
  return { path, main: false, name, task, branch };
}

/**
 * Сводка проектов передаёт описания репозиториев, как настоящий /api/projects.
 * Короткие пути фикстуры преобразуются до сетевого вызова, без обхода декодера.
 */
function projectFixture(id, directories) {
  return {
    id,
    repos: directories.map((dir) => ({ key: dir.split('/').pop(), dir })),
  };
}

function query(url) {
  return new URL(url, 'http://grigdesk.test').searchParams;
}

async function compileCodeView() {
  return compileVue(VIEW_PATH, {
    stubs: {
      './apiClient.ts': 'export const api = globalThis.__codeViewApi;',
      '../../shared/monaco': `
        export const monaco = globalThis.__codeViewMonaco;
        export const langOf = (path) => path.split('.').pop() || 'plaintext';
        export const READONLY_OPTS = {};
      `,
      '../../composables/useSse': `
        export function useSse(listener) {
          globalThis.__codeViewSse = listener;
          return { connected: { value: true } };
        }
      `,
      '../../stores/chat.ts': `
        export const useChatStore = () => globalThis.__codeViewChat;
      `,
      '../../router.ts': `
        export const router = globalThis.__codeViewRouter;
      `,
      '../../ui': (`
        export { default as UiButton } from './src/components/primitives/UiButton.vue';
        export { default as UiIconButton } from './src/components/primitives/UiIconButton.vue';
        export { default as UiInlineMessage } from './src/components/feedback/UiInlineMessage.vue';
        export { default as UiPopover } from './src/components/overlays/UiPopover.vue';
        export { default as UiPressable } from './src/components/primitives/UiPressable.vue';
        export { default as UiSearchInput } from './src/components/composites/UiSearchInput.vue';
        export { default as UiSelect } from './src/components/primitives/UiSelect.vue';
        export { default as UiSwitch } from './src/components/primitives/UiSwitch.vue';
        export { default as UiTab } from './src/components/composites/UiTab.vue';
        export { default as UiTabs } from './src/components/composites/UiTabs.vue';
        export { default as UiTextarea } from './src/components/primitives/UiTextarea.vue';
        export const confirmDialog = (text, options) => globalThis.__codeViewConfirm(text, options);
        export const promptDialog = (options) => globalThis.__codeViewPrompt(options);
      `) +
        "\nexport { vTooltip } from \"./src/services/tooltipDirective.ts\";",
    },
  });
}

function installBrowser(t, storage = {}) {
  return import('../../web/node_modules/happy-dom/lib/index.js').then(({ Window }) => {
    sharedBrowser ||= new Window({ url: 'http://grigdesk.test/#/code' });
    const browser = sharedBrowser;

    browser.localStorage.clear();
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      location: browser.location,
      localStorage: browser.localStorage,
      Node: browser.Node,
      Element: browser.Element,
      HTMLElement: browser.HTMLElement,
      HTMLButtonElement: browser.HTMLButtonElement,
      HTMLSelectElement: browser.HTMLSelectElement,
      SVGElement: browser.SVGElement,
      Event: browser.Event,
      CustomEvent: browser.CustomEvent,
      getComputedStyle: browser.getComputedStyle.bind(browser),
    })) {
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    }
    for (const [key, value] of Object.entries(storage)) browser.localStorage.setItem(key, value);
    browser.document.body.innerHTML = '<div id="mount"></div>';
    return browser;
  });
}

function makeMonaco() {
  const state = {
    models: [],
    fileEditors: [],
    diffEditors: [],
    colorizeCalls: [],
    decorationCollections: [],
  };
  const makeEditor = (kind, options = {}) => {
    const editor = {
      kind,
      options: { ...options },
      optionCalls: [],
      model: undefined,
      setCalls: [],
      disposed: false,
      revealed: [],
      position: null,
      selection: null,
      mouseDown: null,
      setModel(model) { this.model = model; this.setCalls.push(model); },
      revealLineInCenter(line) { this.revealed.push(line); },
      setPosition(value) { this.position = value; },
      getPosition() { return this.position; },
      getSelection() { return this.selection; },
      setSelection(value) { this.selection = value; },
      onMouseDown(listener) {
        this.mouseDown = listener;
        return {
          dispose: () => {
            if (this.mouseDown === listener) {
              this.mouseDown = null;
            }
          },
        };
      },
      createDecorationsCollection(decorations) {
        const collection = {
          decorations: [...decorations],
          clear() {
            this.decorations = [];
          },
          set(value) {
            this.decorations = [...value];

            return [];
          },
        };
        state.decorationCollections.push(collection);
        return collection;
      },
      updateOptions(value) {
        this.options = { ...this.options, ...value };
        this.optionCalls.push(value);
      },
      dispose() { this.disposed = true; },
    };
    state[kind === 'file' ? 'fileEditors' : 'diffEditors'].push(editor);
    return editor;
  };
  const monaco = {
    editor: {
      async colorize(content) {
        state.colorizeCalls.push(content);
        if (content.includes('COLORIZE_REJECT')) throw new Error('tokenizer failed');
        return `<span class="mtk1">${content}</span>`;
      },
      create: (_host, options) => makeEditor('file', options),
      createDiffEditor: (_host, options) => makeEditor('diff', options),
      createModel(content, language) {
        const model = {
          content,
          language,
          disposed: false,
          dispose() { this.disposed = true; },
        };
        state.models.push(model);
        return model;
      },
    },
  };
  return { monaco, state };
}

function installResizeObserver(t) {
  const previous = globalThis.ResizeObserver;
  const observers = new Set();

  class TestResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.targets = new Set();
      observers.add(this);
    }

    observe(target) { this.targets.add(target); }
    unobserve(target) { this.targets.delete(target); }
    disconnect() {
      this.targets.clear();
      observers.delete(this);
    }
  }

  Object.defineProperty(globalThis, 'ResizeObserver', {
    value: TestResizeObserver,
    configurable: true,
    writable: true,
  });
  t.after(() => {
    if (previous === undefined) {
      delete globalThis.ResizeObserver;
    } else {
      Object.defineProperty(globalThis, 'ResizeObserver', {
        value: previous,
        configurable: true,
        writable: true,
      });
    }
  });

  return {
    resize(target, width, height = 720) {
      Object.defineProperty(target, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
          x: 0, y: 0, left: 0, top: 0, right: width, bottom: height,
          width, height,
        }),
      });
      for (const observer of observers) {
        if (observer.targets.has(target)) observer.callback([], observer);
      }
    },
  };
}

async function settle(flushPromises, cycles = 5) {
  for (let i = 0; i < cycles; i += 1) await flushPromises();
}

async function openFileActions(wrapper, browser, flushPromises) {
  await wrapper.get('button[data-action="file-actions"]').trigger('click');
  await settle(flushPromises);
  const panel = browser.document.querySelector('[role="dialog"] .code-popover-panel');

  assert.ok(panel, 'popover действий файла не открылся');
  return panel;
}

async function openCommitMore(wrapper, browser, flushPromises) {
  await wrapper.get('button[data-action="commit-more"]').trigger('click');
  await settle(flushPromises);
  const panel = browser.document.querySelector('.commit-more-panel');

  assert.ok(panel, 'popover дополнительных действий коммита не открылся');
  return panel;
}

async function refreshCurrentCode(wrapper, browser, flushPromises) {
  const panel = await openFileActions(wrapper, browser, flushPromises);
  const refresh = panel.querySelector('button[data-action="refresh-file"]');

  assert.ok(refresh, 'действие обновления отсутствует');
  refresh.click();
  await settle(flushPromises);
}

async function selectCodeTab(wrapper, value) {
  await wrapper.get(`button[data-tab="${value}"]`).trigger('click');
}

/** Заголовки групп изменений: имя группы, подпись и счётчик файлов рядом с ней. */
function groupHeads(wrapper) {
  return wrapper.findAll('.subhead[data-group]').map((node) => ({
    group: node.attributes('data-group'),
    title: node.findAll('span')[0].text(),
    count: node.find('.cnt').exists() ? node.find('.cnt').text() : '',
  }));
}

async function waitFor(check, message) {
  for (let i = 0; i < 40; i += 1) {
    if (check()) return;
    await new Promise((resolve) => { setImmediate(resolve); });
  }
  assert.fail(message);
}

async function mountCodeView(t, {
  api,
  storage = {},
  props = {},
  confirm = async () => false,
  prompt = async () => null,
  chat = { newSession: () => '' },
  router = { push: async () => {} },
}) {
  const browser = await installBrowser(t, storage);
  const { monaco, state: monacoState } = makeMonaco();
  let lastGit = null;
  // Старые сценарии хранят стороны прямо в фикстуре `/git`. Производственный
  // декодер их теперь отбрасывает; адаптер теста отдаёт те же стороны через новый
  // ленивый endpoint, пока конкретный сценарий не подменил его явно.
  globalThis.__codeViewApi = {
    ...api,
    async get(url) {
      try {
        const value = await api.get(url);

        if (url.includes('/git?')) {
          lastGit = value;
        }

        return value;
      } catch (error) {
        if (!url.includes('/file-diff?') || !lastGit) {
          throw error;
        }

        const params = query(url);
        const files = params.get('group') === 'staged' ? lastGit.staged : lastGit.files;
        const file = files?.find((entry) => entry.path === params.get('path'));

        if (!file) {
          throw error;
        }

        return {
          path: file.path,
          status: file.status,
          binary: !!file.binary,
          tooBig: !!file.tooBig,
          oldContent: file.oldContent || '',
          newContent: file.newContent || '',
        };
      }
    },
  };
  globalThis.__codeViewMonaco = monaco;
  globalThis.__codeViewConfirm = confirm;
  globalThis.__codeViewPrompt = prompt;
  globalThis.__codeViewChat = chat;
  globalThis.__codeViewRouter = router;
  const [{ mount, flushPromises }, CodeView] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileCodeView(),
  ]);
  const wrapper = mount(CodeView, {
    attachTo: browser.document.querySelector('#mount'),
    props,
    global: {
      stubs: { RouterLink: { template: '<a href="/projects"><slot /></a>' } },
    },
  });
  t.after(() => {
    wrapper.unmount();
    delete globalThis.__codeViewApi;
    delete globalThis.__codeViewMonaco;
    delete globalThis.__codeViewConfirm;
    delete globalThis.__codeViewPrompt;
    delete globalThis.__codeViewChat;
    delete globalThis.__codeViewRouter;
    delete globalThis.__codeViewSse;
  });
  await settle(flushPromises);
  return { browser, wrapper, flushPromises, monacoState };
}

test('холодный запуск Code сразу занимает финальную сетку без пустого loading-кадра', async (t) => {
  const projectsRequest = deferred();
  const api = {
    async get(url) {
      if (url === '/api/projects') return projectsRequest.promise;
      if (url === '/api/code/demo/repos') {
        return { repos: [{ key: 'demo', dir: '/demo', trees: [mainTree('/demo')] }] };
      }
      if (url.includes('/ls?')) return { entries: [] };
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const { wrapper, flushPromises } = await mountCodeView(t, {
    api,
    props: { active: true, compact: true },
  });

  const loading = wrapper.get('.lay.code-loading');
  assert.equal(wrapper.get('.code-panel').attributes('aria-busy'), 'true');
  assert.equal(loading.attributes('role'), undefined);
  assert.equal(loading.classes().includes('compact'), true);
  // Каркас сразу держит колонку рейки разделов, а живых кнопок в нём ещё нет.
  assert.equal(loading.find('.rail').exists(), true);
  assert.equal(loading.findAll('.loading-rail-item').length, 3);
  assert.equal(wrapper.findAll('button[data-context="code-rail-item"]').length, 0);
  assert.equal(loading.find('.panel').exists(), true);
  assert.equal(loading.find('.code-split').exists(), true);
  assert.equal(loading.find('.editorwrap').exists(), true);
  assert.equal(wrapper.find('.empty').exists(), false);

  projectsRequest.resolve({ projects: [projectFixture('demo', ['/demo'])] });
  await settle(flushPromises);
  assert.equal(wrapper.find('.code-loading').exists(), false);
  assert.equal(wrapper.get('.lay').classes().includes('compact'), true);
});

test('CodeView показывает два подписанных уровня, хранит контекст по проекту и сообщает о недоступном repo', async (t) => {
  const calls = [];
  const projects = [
    projectFixture('grigdesk', ['/engine', '/web', '/broken']),
    projectFixture('solo', ['/solo']),
  ];
  const repos = {
    grigdesk: [
      {
        key: 'engine', dir: '/engine', trees: [
          mainTree('/engine', 'master'),
          worktree('/work/t46', 't46', 'task-46', 't46'),
        ],
      },
      {
        key: 'web', dir: '/web', trees: [
          mainTree('/web', 'main'),
          worktree('/work/web-preview', 'web-preview', '(detached)'),
        ],
      },
      { key: 'broken', dir: '/missing/broken', trees: [] },
    ],
    solo: [{ key: 'solo', dir: '/solo', trees: [mainTree('/solo', 'trunk')] }],
  };
  const api = {
    async get(url) {
      calls.push(url);
      if (url === '/api/projects') return { projects };
      const repoMatch = url.match(/^\/api\/code\/([^/]+)\/repos$/);
      if (repoMatch) return { repos: repos[repoMatch[1]] };
      if (url.includes('/ls?')) return { entries: [] };
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const storedWeb = JSON.stringify({
    v: 1,
    repoKey: 'web',
    treePath: '/work/web-preview',
  });
  const { browser, wrapper, flushPromises } = await mountCodeView(t, {
    api,
    storage: {
      'grigdesk-project': 'grigdesk',
      'grigdesk-code-context:grigdesk': storedWeb,
    },
  });

  // Оба уровня выбираются в шапке раздела: панель отдана содержимому.
  assert.equal(wrapper.findAll('.code-head select').length, 2);
  assert.equal(wrapper.findAll('.panel select').length, 0);
  assert.equal(wrapper.get('label[for="code-project"]').text(), 'проект');
  assert.equal(wrapper.get('label[for="code-context"]').text(), 'рабочая копия');
  assert.equal(wrapper.get('#code-context').element.value, JSON.stringify(['web', '/work/web-preview']));
  assert.deepEqual(wrapper.findAll('#code-context optgroup').map((group) => group.attributes('label')), [
    'engine', 'web',
  ]);
  const optionTexts = wrapper.findAll('#code-context option').map((option) => option.text());
  assert.ok(optionTexts.includes('engine · Основная · master'));
  assert.ok(optionTexts.includes('engine · Задача t46 · task-46'));
  assert.ok(optionTexts.includes('web · Worktree web-preview · detached HEAD'));
  assert.match(wrapper.get('.context-warning').text(), /broken.*\/missing\/broken/s);
  assert.match(wrapper.get('.context-warning a').text(), /Проекты/);

  const restoredLs = calls.find((url) => url.includes('/api/code/grigdesk/ls?'));
  assert.equal(query(restoredLs).get('repo'), 'web');
  assert.equal(query(restoredLs).get('root'), '/work/web-preview');

  await wrapper.get('#code-context').setValue(JSON.stringify(['engine', '/engine']));
  await settle(flushPromises);
  assert.deepEqual(JSON.parse(browser.localStorage.getItem('grigdesk-code-context:grigdesk')), {
    v: 1,
    repoKey: 'engine',
    treePath: '/engine',
  });
  const latestGrigDeskLs = calls.filter((url) => url.includes('/api/code/grigdesk/ls?')).at(-1);
  assert.equal(query(latestGrigDeskLs).get('repo'), 'engine');
  assert.equal(query(latestGrigDeskLs).get('root'), '/engine');

  // Переключатель рабочей копии остаётся и у проекта с единственным вариантом:
  // человек должен видеть, где вообще меняют копию, а не угадывать.
  await wrapper.get('#code-project').setValue('solo');
  await settle(flushPromises);
  assert.equal(wrapper.findAll('.code-head select').length, 2);
  assert.deepEqual(
    wrapper.findAll('#code-context option').map((option) => option.text()),
    ['solo · Основная · trunk'],
  );
  assert.equal(wrapper.find('.code-head .tlabel').exists(), false);

  await wrapper.get('#code-project').setValue('grigdesk');
  await settle(flushPromises);
  assert.equal(wrapper.get('#code-context').element.value, JSON.stringify(['engine', '/engine']));
  assert.equal(browser.localStorage.getItem('grigdesk-code-context:solo'), JSON.stringify({
    v: 1,
    repoKey: 'solo',
    treePath: '/solo',
  }));
});

test('вкладки разделяют файлы, уникальные изменения и журнал без потери диапазона', async (t) => {
  const git = {
    branch: 'main',
    stat: '',
    staged: [{ path: 'shared.js', status: 'M', add: 1, del: 0, binary: false }],
    files: [
      { path: 'shared.js', status: 'M', add: 1, del: 0, binary: false },
      { path: 'other.js', status: 'A', add: 1, del: 0, binary: false },
    ],
    tracking: { detached: false, upstream: '', ahead: 0, behind: 0 },
    log: [{ hash: 'ccccccc', subject: 'change', when: 'сейчас' }],
    headMessage: '',
  };
  const api = {
    async get(url) {
      if (url === '/api/projects') return { projects: [projectFixture('demo', ['/demo'])] };
      if (url === '/api/code/demo/repos') {
        return { repos: [{ key: 'demo', dir: '/demo', trees: [mainTree('/demo')] }] };
      }
      if (url.includes('/ls?')) return { entries: [] };
      if (url.includes('/git?')) return git;
      if (url.includes('/commits-diff?')) {
        return {
          branch: 'main', stat: 'commit.js | 1 +',
          files: [{ path: 'commit.js', status: 'M', add: 1, del: 0, binary: false }],
          range: {
            from: 'c'.repeat(40), to: 'c'.repeat(40), base: 'b'.repeat(40), commits: 1,
            work: true,
          },
        };
      }
      if (url.includes('/file-diff?')) {
        return {
          path: query(url).get('path'), status: 'M', binary: false, tooBig: false,
          oldContent: 'old', newContent: 'new',
        };
      }
      if (url.includes('/file-log?')) {
        return { entries: [{
          hash: 'ccccccc', base: 'b'.repeat(40), subject: 'change', when: 'сейчас',
          path: 'commit.js',
        }] };
      }
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const { wrapper, flushPromises } = await mountCodeView(t, { api });
  const rail = wrapper.get('aside.rail');
  const items = rail.findAll('button[data-context="code-rail-item"]');

  // Разделы — небольшие кнопки в рейке слева от навигатора, а не вкладки в шапке.
  assert.equal(rail.attributes('aria-label'), 'Разделы кода');
  assert.equal(wrapper.find('.code-head [role="tablist"]').exists(), false);
  assert.equal(rail.element.nextElementSibling === wrapper.get('.panel').element, true);
  assert.deepEqual(items.map((item) => item.attributes('data-tab')), [
    'files', 'changes', 'commits',
  ]);
  assert.deepEqual(items.map((item) => item.attributes('aria-pressed')), ['true', 'false', 'false']);
  assert.equal(wrapper.get('button[data-tab="changes"]').attributes('aria-label'), 'Изменения · 2');
  assert.equal(wrapper.get('button[data-tab="changes"] .rail-badge').text(), '2');
  assert.equal(wrapper.find('button[data-tab="files"] .rail-badge').exists(), false);

  await selectCodeTab(wrapper, 'changes');
  await settle(flushPromises);
  assert.equal(wrapper.findAll('.subhead[data-group="work"]').length, 1);
  assert.equal(wrapper.findAll('button.commit').length, 0);

  await wrapper.get('.navigator-toggle').trigger('click');
  assert.equal(wrapper.get('.lay').classes().includes('navigator-collapsed'), true);
  await selectCodeTab(wrapper, 'commits');
  await settle(flushPromises);
  assert.equal(wrapper.get('.lay').classes().includes('navigator-collapsed'), false);
  assert.equal(wrapper.findAll('.subhead[data-group="work"]').length, 0);
  assert.equal(wrapper.findAll('button.commit').length, 1);

  await wrapper.get('button.commit[data-hash="ccccccc"]').trigger('click');
  await settle(flushPromises);
  await selectCodeTab(wrapper, 'changes');
  await settle(flushPromises);
  assert.equal(wrapper.find('.subhead[data-group="commits"]').exists(), false);
  assert.equal(wrapper.find('button[data-action="clear-commits"]').exists(), true);

  await selectCodeTab(wrapper, 'commits');
  await settle(flushPromises);
  assert.equal(wrapper.get('button.commit[data-hash="ccccccc"]').attributes('aria-pressed'), 'true');

  await wrapper.get('button[data-action="file-history"]').trigger('click');
  await settle(flushPromises);
  assert.equal(wrapper.find('.file-history').exists(), true);
  await wrapper.get('button[data-action="close-file-history"]').trigger('click');
  await settle(flushPromises);
  assert.equal(wrapper.get('button[data-tab="commits"]').attributes('aria-pressed'), 'true');
  assert.equal(wrapper.get('button[data-tab="changes"]').attributes('aria-pressed'), 'false');
});

test('Git по умолчанию показан деревом, доступно переключается в список и сохраняет выбранный diff', async (t) => {
  const git = {
    stat: '',
    staged: [],
    tracking: { detached: false, upstream: '', ahead: 0, behind: 0 },
    branch: 'main',
    files: [
      {
        binary: false,
        tooBig: false,
        path: 'src/deep/b.js',
        status: 'M',
        add: 2,
        del: 1,
        oldContent: 'old b',
        newContent: 'new b'
      },
      {
        binary: false,
        tooBig: false,
        path: 'src/a.js',
        status: 'A',
        add: 4,
        del: 0,
        oldContent: '',
        newContent: 'a'
      },
      {
        binary: false,
        tooBig: false,
        path: 'root.md',
        status: 'D',
        add: 0,
        del: 3,
        oldContent: 'root',
        newContent: ''
      },
      {
        binary: false,
        tooBig: false,
        path: 'foo',
        status: 'D',
        add: 0,
        del: 1,
        oldContent: 'file',
        newContent: ''
      },
      {
        binary: false,
        tooBig: false,
        path: 'foo/bar.js',
        status: 'A',
        add: 1,
        del: 0,
        oldContent: '',
        newContent: 'bar'
      },
    ],
    log: [],
  };
  const api = {
    async get(url) {
      if (url === '/api/projects') return { projects: [projectFixture('demo', ['/demo'])] };
      if (url === '/api/code/demo/repos') {
        return { repos: [{ key: 'demo', dir: '/demo', trees: [mainTree('/demo')] }] };
      }
      if (url.includes('/ls?')) return { entries: [] };
      if (url.includes('/git?')) return git;
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const { wrapper, flushPromises, monacoState } = await mountCodeView(t, {
    api,
    storage: { 'grigdesk-code-git-view': 'damaged' },
  });

  await selectCodeTab(wrapper, 'changes');
  await settle(flushPromises);

  const toggle = wrapper.get('[role="group"][aria-label="Вид изменений"]');
  assert.equal(wrapper.get('.git-panel-toolbar [aria-label="Вид изменений"]').exists(), true);
  const treeButton = toggle.get('button[data-view="tree"]');
  const listButton = toggle.get('button[data-view="list"]');
  assert.equal(treeButton.attributes('aria-pressed'), 'true');
  assert.equal(listButton.attributes('aria-pressed'), 'false');
  assert.equal(treeButton.get('svg').attributes('aria-hidden'), 'true');
  assert.equal(wrapper.get('button.git-dir[data-path="src"]').attributes('aria-expanded'), 'true');
  assert.equal(wrapper.get('button.git-dir[data-path="foo"]').attributes('aria-expanded'), 'true');
  assert.equal(wrapper.findAll('[data-path="foo"]').length, 2);

  const nested = wrapper.get('button.git-file[data-path="src/deep/b.js"]');
  assert.equal(monacoState.diffEditors[0].options.renderSideBySide, true);
  await wrapper.get('button.git-file[data-path="src/a.js"]').trigger('click');
  await settle(flushPromises);
  assert.match(wrapper.get('.ehead').text(), /src\/\s*a\.js/s);
  assert.match(wrapper.get('.diffhead').text(), /Вид сравнения.*Одна колонка/s);
  assert.equal(monacoState.diffEditors[0].options.renderSideBySide, false,
    'новый файл не оставляет пустую половину side-by-side diff');

  assert.equal(wrapper.get('.file-navigation .file-position').text(), 'Файл 2 / 5');
  await wrapper.get('.file-navigation button[aria-label="Следующий файл"]').trigger('click');
  await settle(flushPromises);
  assert.match(wrapper.get('.ehead').text(), /root\.md/);

  await nested.trigger('click');
  await settle(flushPromises);
  assert.match(wrapper.get('.ehead').text(), /src\/deep\/\s*b\.js/);
  assert.equal(monacoState.diffEditors[0].options.renderSideBySide, true);
  assert.match(nested.text(), /\+2.*−1/s);
  const diffSetCalls = monacoState.diffEditors[0].setCalls.length;

  await listButton.trigger('click');
  await settle(flushPromises);
  assert.equal(treeButton.attributes('aria-pressed'), 'false');
  assert.equal(listButton.attributes('aria-pressed'), 'true');
  assert.equal(wrapper.get('button.git-file[data-path="src/deep/b.js"]').classes().includes('sel'), true);
  // Плоский список показывает имя файла и каталог отдельно: целый путь обрезался
  // с конца, то есть съедал именно имя.
  assert.equal(wrapper.get('button.git-file[data-path="src/deep/b.js"] .nm-base').text(), 'b.js');
  assert.equal(wrapper.get('button.git-file[data-path="src/deep/b.js"] .nm-dir').text(), 'src/deep');
  assert.equal(wrapper.get('button.git-file[data-path="root.md"] .nm-base').text(), 'root.md');
  assert.equal(wrapper.find('button.git-file[data-path="root.md"] .nm-dir').exists(), false);
  assert.equal(monacoState.diffEditors[0].setCalls.length, diffSetCalls);

  await treeButton.trigger('click');
  await settle(flushPromises);
  assert.equal(wrapper.get('button.git-file[data-path="src/deep/b.js"]').classes().includes('sel'), true);
  assert.match(wrapper.get('.ehead').text(), /src\/deep\/\s*b\.js/);
  assert.equal(monacoState.diffEditors[0].setCalls.length, diffSetCalls);

  await wrapper.get('button.git-dir[data-path="src"]').trigger('click');
  await settle(flushPromises);
  assert.equal(wrapper.get('button.git-dir[data-path="src"]').attributes('aria-expanded'), 'false');
  assert.equal(wrapper.find('button.git-file[data-path="src/deep/b.js"]').exists(), false);
  assert.equal(wrapper.find('button.git-file[data-path="root.md"]').exists(), true);
});

test('настройки diff восстанавливаются, меняют Monaco и сохраняются на устройстве', async (t) => {
  const git = {
    branch: 'main',
    stat: '',
    files: [{ path: 'app.js', status: 'M', add: 1, del: 1, binary: false }],
    staged: [],
    tracking: { detached: false, upstream: '', ahead: 0, behind: 0 },
    log: [],
    headMessage: '',
  };
  const api = {
    async get(url) {
      if (url === '/api/projects') return { projects: [projectFixture('demo', ['/demo'])] };
      if (url === '/api/code/demo/repos') {
        return { repos: [{ key: 'demo', dir: '/demo', trees: [mainTree('/demo')] }] };
      }
      if (url.includes('/ls?')) return { entries: [] };
      if (url.includes('/git?')) return git;
      if (url.includes('/file-diff?')) {
        return {
          path: 'app.js', status: 'M', binary: false, tooBig: false,
          oldContent: 'const value = 1;', newContent: 'const value = 2;',
        };
      }
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const { browser, wrapper, flushPromises, monacoState } = await mountCodeView(t, {
    api,
    storage: { 'grigdesk-diff-wrap': '1', 'grigdesk-diff-ws': '1' },
  });

  await selectCodeTab(wrapper, 'changes');
  await settle(flushPromises);

  const editor = monacoState.diffEditors[0];
  assert.equal(editor.options.diffWordWrap, 'on');
  assert.equal(editor.options.ignoreTrimWhitespace, true);
  await wrapper.get('button[data-action="diff-view"]').trigger('click');
  await settle(flushPromises);

  const wrap = browser.document.querySelector('input[data-action="diff-wrap"]');
  const whitespace = browser.document.querySelector('input[data-action="diff-whitespace"]');

  assert.ok(wrap);
  assert.ok(whitespace);
  assert.equal(wrap.checked, true);
  assert.equal(whitespace.checked, true);
  wrap.click();
  whitespace.click();
  await settle(flushPromises);

  assert.equal(editor.options.diffWordWrap, 'off');
  assert.equal(editor.options.ignoreTrimWhitespace, false);
  assert.equal(browser.localStorage.getItem('grigdesk-diff-wrap'), '0');
  assert.equal(browser.localStorage.getItem('grigdesk-diff-ws'), '0');
  assert.ok(editor.optionCalls.some((options) => options.diffWordWrap === 'off'));
  assert.ok(editor.optionCalls.some((options) => options.ignoreTrimWhitespace === false));
});

test('узкий CodePanel показывает одну область, сохраняет Monaco и временно складывает diff', async (t) => {
  const resize = installResizeObserver(t);
  const git = {
    branch: 'main',
    stat: '',
    files: [{ path: 'app.js', status: 'M', add: 1, del: 1, binary: false }],
    staged: [],
    tracking: { detached: false, upstream: '', ahead: 0, behind: 0 },
    log: [],
    headMessage: '',
  };
  const api = {
    async get(url) {
      if (url === '/api/projects') return { projects: [projectFixture('demo', ['/demo'])] };
      if (url === '/api/code/demo/repos') {
        return { repos: [{ key: 'demo', dir: '/demo', trees: [mainTree('/demo')] }] };
      }
      if (url.includes('/ls?')) return { entries: [{ name: 'app.js', dir: false }] };
      if (url.includes('/git?')) return git;
      if (url.includes('/file-diff?')) {
        return {
          path: 'app.js', status: 'M', binary: false, tooBig: false,
          oldContent: 'const value = 1;', newContent: 'const value = 2;',
        };
      }
      if (url.includes('/file?')) {
        return { content: 'const value = 2;', binary: false, tooBig: false, size: 16 };
      }
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const { browser, wrapper, flushPromises, monacoState } = await mountCodeView(t, {
    api,
    storage: { 'grigdesk-diff-side': '1' },
  });
  const lay = wrapper.get('.lay').element;

  for (const width of [360, 480, 720]) {
    resize.resize(lay, width);
    await settle(flushPromises);
    assert.equal(wrapper.get('.lay').classes().includes('code-narrow'), true);
  }
  assert.equal(wrapper.get('.lay').classes().includes('narrow-navigator'), true);
  assert.equal(wrapper.find('.navigator-toggle').exists(), false);

  await wrapper.get('button[data-file-path="app.js"]').trigger('click');
  await settle(flushPromises);
  assert.equal(wrapper.get('.lay').classes().includes('narrow-editor'), true);
  assert.equal(
    wrapper.get('button[data-action="back-to-navigator"]').attributes('aria-label'),
    'К файлам',
  );
  assert.deepEqual(monacoState.fileEditors[0].options.padding, { top: 8, bottom: 8 });
  assert.equal(monacoState.fileEditors[0].options.fontSize, 13);
  assert.equal(monacoState.fileEditors[0].options.lineHeight, 20);
  resize.resize(wrapper.get('.editorwrap').element, 360);
  await settle(flushPromises);
  assert.equal(wrapper.find('.file-head-row button[data-action="file-history"]').exists(), false);
  assert.equal(wrapper.find('.file-head-row button[data-action="ask-agent"]').exists(), false);
  const fileMenu = await openFileActions(wrapper, browser, flushPromises);

  assert.ok(fileMenu.querySelector('button[data-action="file-history"]'));
  assert.ok(fileMenu.querySelector('button[data-action="ask-agent"]'));
  fileMenu.closest('.ui-popover').dispatchEvent(
    new browser.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );
  await settle(flushPromises);
  monacoState.fileEditors[0].setPosition({ lineNumber: 1, column: 7 });
  monacoState.fileEditors[0].setSelection({
    startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 7,
  });

  await wrapper.get('button[data-action="back-to-navigator"]').trigger('click');
  await settle(flushPromises);
  assert.equal(wrapper.get('.lay').classes().includes('narrow-navigator'), true);

  await selectCodeTab(wrapper, 'changes');
  await settle(flushPromises);
  assert.equal(wrapper.get('.lay').classes().includes('narrow-navigator'), true);
  await wrapper.get('button.git-file[data-path="app.js"]').trigger('click');
  await settle(flushPromises);
  const editorHost = wrapper.get('.editorwrap').element;

  resize.resize(editorHost, 700);
  await settle(flushPromises);
  assert.equal(wrapper.get('.lay').classes().includes('narrow-editor'), true);
  assert.equal(
    wrapper.get('button[data-action="back-to-navigator"]').attributes('aria-label'),
    'К изменениям',
  );
  assert.equal(monacoState.diffEditors[0].options.renderSideBySide, false);
  assert.equal(monacoState.diffEditors[0].options.fontSize, 13);
  assert.deepEqual(monacoState.diffEditors[0].options.padding, { top: 8, bottom: 8 });
  const narrowModels = monacoState.diffEditors[0].model;

  await wrapper.get('button[data-action="diff-view"]').trigger('click');
  await settle(flushPromises);
  const sideBySide = browser.document.querySelector(
    '.diff-layout-options button:first-child',
  );

  assert.ok(sideBySide);
  assert.equal(sideBySide.disabled, true);
  assert.match(browser.document.querySelector('.diff-view-panel').textContent, /этой ширине/);

  resize.resize(lay, 1200);
  resize.resize(editorHost, 872);
  await settle(flushPromises);
  assert.equal(wrapper.get('.lay').classes().includes('code-narrow'), false);
  assert.equal(wrapper.find('button[data-action="back-to-navigator"]').exists(), false);
  assert.equal(monacoState.diffEditors.length, 1);
  assert.equal(monacoState.diffEditors[0].model, narrowModels);
  assert.equal(monacoState.diffEditors[0].options.renderSideBySide, true);
  assert.equal(browser.localStorage.getItem('grigdesk-diff-side'), '1');
  assert.deepEqual(monacoState.fileEditors[0].position, { lineNumber: 1, column: 7 });
  assert.deepEqual(monacoState.fileEditors[0].selection, {
    startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 7,
  });
});

test('«Ссылка» копирует текущий файл и строку, а без Clipboard открывает общий prompt', async (t) => {
  const copied = [];
  const prompts = [];
  const api = {
    async get(url) {
      if (url === '/api/projects') return { projects: [projectFixture('demo', ['/demo'])] };
      if (url === '/api/code/demo/repos') {
        return { repos: [{ key: 'demo', dir: '/demo', trees: [mainTree('/demo')] }] };
      }
      if (url.includes('/ls?')) return { entries: [{ name: 'новый файл.ts', dir: false }] };
      if (url.includes('/file?')) {
        return { content: 'one\ntwo\nthree', binary: false, tooBig: false, size: 13 };
      }
      if (url.includes('/git?')) {
        return {
          branch: 'main', stat: '', files: [], staged: [], log: [], headMessage: '',
          tracking: { detached: false, upstream: '', ahead: 0, behind: 0 },
        };
      }
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const { browser, wrapper, flushPromises, monacoState } = await mountCodeView(t, {
    api,
    prompt: async (options) => { prompts.push(options); return null; },
  });

  Object.defineProperty(browser.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (value) => { copied.push(value); } },
  });
  await wrapper.get('button[data-file-path="новый файл.ts"]').trigger('click');
  await settle(flushPromises);
  monacoState.fileEditors[0].setPosition({ lineNumber: 2, column: 1 });

  await wrapper.get('button[data-action="file-actions"]').trigger('click');
  await settle(flushPromises);
  browser.document.querySelector('button[data-action="copy-code-link"]').click();
  await settle(flushPromises);

  const { parseCodeRouteHref } = await import('../../web/src/features/code/links.ts');

  assert.equal(copied.length, 1);
  assert.deepEqual(parseCodeRouteHref(copied[0]), {
    project: 'demo', repo: 'demo', root: '/demo', path: 'новый файл.ts', line: 2,
  });
  assert.match(copied[0], /^http:\/\/grigdesk\.test\/#\/code\?/);

  await wrapper.get('button[data-action="file-actions"]').trigger('click');
  await settle(flushPromises);
  assert.match(
    browser.document.querySelector('button[data-action="copy-code-link"]').textContent,
    /Ссылка скопирована/,
  );

  Object.defineProperty(browser.navigator, 'clipboard', {
    configurable: true,
    value: undefined,
  });
  browser.document.querySelector('button[data-action="copy-code-link"]').click();
  await settle(flushPromises);

  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].value, copied[0]);
});

test('откат и удаление требуют подтверждения, а staged-файл отката не имеет', async (t) => {
  const posts = [];
  const confirmations = [];
  const decisions = [false, true];
  const snapshot = {
    branch: 'main', stat: '', log: [], headMessage: '',
    staged: [{ path: 'staged.js', status: 'M', add: 1, del: 0, binary: false }],
    files: [
      { path: 'tracked.js', status: 'M', add: 1, del: 1, binary: false },
      { path: 'new.js', status: 'A', add: 1, del: 0, binary: false },
    ],
    tracking: { detached: false, upstream: '', ahead: 0, behind: 0 },
  };
  const api = {
    async get(url) {
      if (url === '/api/projects') return { projects: [projectFixture('demo', ['/demo'])] };
      if (url === '/api/code/demo/repos') {
        return { repos: [{ key: 'demo', dir: '/demo', trees: [mainTree('/demo')] }] };
      }
      if (url.includes('/ls?')) return { entries: [] };
      if (url.includes('/git?')) return snapshot;
      if (url.includes('/file-diff?')) {
        const path = query(url).get('path');
        const file = [...snapshot.staged, ...snapshot.files].find((item) => item.path === path);
        return {
          ...file, tooBig: false,
          oldContent: file.status === 'A' ? '' : 'old', newContent: 'new',
        };
      }
      throw new Error(`unexpected GET ${url}`);
    },
    async post(url, payload) {
      posts.push({ url, payload });
      return { ok: true, changed: 1 };
    },
  };
  const { wrapper, flushPromises, browser } = await mountCodeView(t, {
    api,
    confirm: async (text) => {
      confirmations.push(text);
      return decisions.shift() ?? true;
    },
  });

  await selectCodeTab(wrapper, 'changes');
  await settle(flushPromises);

  assert.equal(wrapper.find('[data-group="staged"] [data-action="discard"]').exists(), false);
  assert.equal(wrapper.find('button[data-action="discard-all"]').exists(), false);
  assert.equal(wrapper.find('button[data-action="clean"][data-file="new.js"]').exists(), false);
  assert.equal(wrapper.findAll('button[data-action="row-more"]').length, 2);

  await wrapper.get('button[data-action="group-more"]').trigger('click');
  await settle(flushPromises);
  assert.ok(browser.document.querySelector('button[data-action="discard-all"]'));
  browser.document.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await settle(flushPromises);

  await wrapper.get('button[data-action="row-more"][data-file="tracked.js"]').trigger('click');
  await settle(flushPromises);
  browser.document.querySelector('button[data-action="discard"][data-file="tracked.js"]').click();
  await settle(flushPromises);
  assert.equal(posts.length, 0, 'отказ в диалоге не запускает мутацию');

  await wrapper.get('button[data-action="row-more"][data-file="tracked.js"]').trigger('click');
  await settle(flushPromises);
  browser.document.querySelector('button[data-action="discard"][data-file="tracked.js"]').click();
  await settle(flushPromises);
  assert.equal(posts.length, 1);
  assert.match(posts[0].url, /\/discard\?/);
  assert.deepEqual(posts[0].payload, { paths: ['tracked.js'] });
  assert.match(confirmations[0], /tracked\.js.*без возможности отмены/s);
});

test('конфликт помечен в Git, разрешается через stage и не предлагает откат', async (t) => {
  const posts = [];
  const conflict = {
    path: 'conflict.txt', status: 'U', add: 0, del: 0, binary: false,
  };
  const snapshot = {
    branch: 'main', stat: '', log: [], headMessage: '', staged: [], files: [conflict],
    tracking: { detached: false, upstream: '', ahead: 0, behind: 0 },
  };
  const api = {
    async get(url) {
      if (url === '/api/projects') {
        return { projects: [projectFixture('demo', ['/demo'])] };
      }
      if (url === '/api/code/demo/repos') {
        return { repos: [{ key: 'demo', dir: '/demo', trees: [mainTree('/demo')] }] };
      }
      if (url.includes('/ls?')) {
        return { entries: [] };
      }
      if (url.includes('/git?')) {
        return snapshot;
      }
      if (url.includes('/file-diff?')) {
        return {
          ...conflict,
          tooBig: false,
          oldContent: 'ours\n',
          newContent: '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> other\n',
        };
      }
      throw new Error(`unexpected GET ${url}`);
    },
    async post(url, payload) {
      posts.push({ url, payload });

      return { ok: true, changed: 1 };
    },
  };
  const { wrapper, flushPromises } = await mountCodeView(t, { api });

  await selectCodeTab(wrapper, 'changes');
  await settle(flushPromises);

  const row = wrapper.get('button.git-file[data-path="conflict.txt"]');
  const resolve = wrapper.get('button[data-action="stage"][data-file="conflict.txt"]');

  assert.equal(row.get('.st').text(), '!');
  assert.equal(row.attributes('data-ui-tooltip'), 'конфликт: разреши в файле, затем добавь в индекс');
  assert.equal(wrapper.get('.diffhead .comparison-sides').text(), 'наша версия → рабочая копия');
  assert.match(
    wrapper.get('.diffhead .comparison-sides').attributes('data-ui-tooltip'),
    /файл с маркерами конфликта/,
  );
  assert.match(resolve.attributes('data-ui-tooltip'), /Пометить разрешённым/);
  assert.equal(wrapper.find('button[data-action="discard"][data-file="conflict.txt"]').exists(), false);
  assert.equal(wrapper.find('button[data-action="row-more"][data-file="conflict.txt"]').exists(), false);
  assert.equal(wrapper.find('button[data-action="group-more"]').exists(), false);

  await resolve.trigger('click');
  await settle(flushPromises);

  assert.match(posts[0].url, /\/stage\?/);
  assert.deepEqual(posts[0].payload, { paths: ['conflict.txt'] });
});

test('«Проверить remote» обновляет tracking, а без remote недоступна', async (t) => {
  const posts = [];
  const snapshot = {
    branch: 'main', stat: '', files: [], staged: [], log: [], headMessage: '',
    tracking: {
      detached: false, upstream: 'origin/main', remote: 'origin', ahead: 0, behind: 0,
    },
  };
  const api = {
    async get(url) {
      if (url === '/api/projects') return { projects: [projectFixture('demo', ['/demo'])] };
      if (url === '/api/code/demo/repos') {
        return { repos: [{ key: 'demo', dir: '/demo', trees: [mainTree('/demo')] }] };
      }
      if (url.includes('/ls?')) return { entries: [] };
      if (url.includes('/git?')) return snapshot;
      throw new Error(`unexpected GET ${url}`);
    },
    async post(url, payload) {
      posts.push({ url, payload });
      return {
        ok: true,
        remote: 'origin',
        tracking: { ...snapshot.tracking, behind: 2 },
      };
    },
  };
  const { wrapper, flushPromises, browser } = await mountCodeView(t, { api });

  await selectCodeTab(wrapper, 'changes');
  await settle(flushPromises);
  await wrapper.get('button[data-action="fetch"]').trigger('click');
  await settle(flushPromises);

  assert.equal(posts.length, 1);
  assert.match(posts[0].url, /\/fetch\?/);
  assert.deepEqual(posts[0].payload, {});
  assert.match(wrapper.get('.git-notice').text(), /origin\/main · ↑0 ↓2/);

  snapshot.tracking = { detached: false, upstream: '', ahead: 0, behind: 0 };
  await refreshCurrentCode(wrapper, browser, flushPromises);
  assert.equal(wrapper.get('button[data-action="fetch"]').attributes('disabled'), '');
});

test('поздние ls/file не перезаписывают новый выбор, а смена контекста освобождает Monaco-модель', async (t) => {
  const lateBRoot = deferred();
  const currentARoot = deferred();
  const fileOne = deferred();
  const fileTwo = deferred();
  let aRootCalls = 0;
  let bRootCalls = 0;
  const api = {
    async get(url) {
      if (url === '/api/projects') return { projects: [projectFixture('race', ['/race'])] };
      if (url === '/api/code/race/repos') {
        return {
          repos: [{
            key: 'race',
            dir: '/race',
            trees: [mainTree('/race/a'), worktree('/race/b', 'b', 'feature/b')],
          }],
        };
      }
      if (url.includes('/ls?')) {
        const root = query(url).get('root');
        if (root === '/race/a') {
          aRootCalls += 1;
          if (aRootCalls === 1) return { entries: [{ name: 'initial.js', dir: false }] };
          if (aRootCalls === 2) return currentARoot.promise;
          return { entries: [{ name: 'one.js', dir: false }, { name: 'two.js', dir: false }] };
        }
        bRootCalls += 1;
        if (bRootCalls === 1) return lateBRoot.promise;
        return { entries: [{ name: 'b-current.js', dir: false }] };
      }
      if (url.includes('/file?')) {
        const path = query(url).get('path');
        if (path === 'one.js') return fileOne.promise;
        if (path === 'two.js') return fileTwo.promise;
      }
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const { wrapper, flushPromises, monacoState } = await mountCodeView(t, { api });
  const context = wrapper.get('#code-context');

  await context.setValue(JSON.stringify(['race', '/race/b']));
  await context.setValue(JSON.stringify(['race', '/race/a']));
  currentARoot.resolve({ entries: [{ name: 'one.js', dir: false }, { name: 'two.js', dir: false }] });
  await settle(flushPromises);
  lateBRoot.resolve({ entries: [{ name: 'b-late.js', dir: false }] });
  await settle(flushPromises);

  assert.equal(wrapper.find('button[data-file-path="one.js"]').exists(), true);
  assert.equal(wrapper.find('button[data-file-path="two.js"]').exists(), true);
  assert.equal(wrapper.find('button[data-file-path="b-late.js"]').exists(), false);

  await wrapper.get('button[data-file-path="one.js"]').trigger('click');
  await wrapper.get('button[data-file-path="two.js"]').trigger('click');
  fileTwo.resolve({ content: 'second file', binary: false, tooBig: false, size: 11 });
  await settle(flushPromises);
  const currentModel = monacoState.fileEditors[0].model;
  assert.equal(currentModel.content, 'second file');
  assert.match(wrapper.get('.ehead').text(), /two\.js/);

  fileOne.resolve({ content: 'late first file', binary: false, tooBig: false, size: 15 });
  await settle(flushPromises);
  assert.equal(monacoState.fileEditors[0].model, currentModel);
  assert.match(wrapper.get('.ehead').text(), /two\.js/);
  assert.doesNotMatch(wrapper.get('.ehead').text(), /читаю/);

  await wrapper.get('#code-context').setValue(JSON.stringify(['race', '/race/b']));
  await settle(flushPromises);
  assert.equal(monacoState.fileEditors[0].setCalls.at(-1), null);
  assert.equal(currentModel.disposed, true);
});

test('поздние repos и git не возвращают интерфейс к старому проекту или worktree', async (t) => {
  const lateBRepos = deferred();
  const currentARepos = deferred();
  const lateTaskGit = deferred();
  const currentMainGit = deferred();
  let aRepoCalls = 0;
  let mainGitCalls = 0;
  let taskGitCalls = 0;
  const aRepos = [{
    key: 'a',
    dir: '/a',
    trees: [mainTree('/a/main'), worktree('/a/task', 'task', 'task-7', 't7')],
  }];
  const gitPayload = (path) => ({
    stat: '',
    staged: [],
    tracking: { detached: false, upstream: '', ahead: 0, behind: 0 },
    branch: 'main',
    files: [{
      binary: false,
      tooBig: false,
      path,
      status: 'M',
      add: 1,
      del: 0,
      oldContent: '',
      newContent: path
    }],
    log: [],
  });
  const api = {
    async get(url) {
      if (url === '/api/projects') {
        return { projects: [projectFixture('a', ['/a']), projectFixture('b', ['/b'])] };
      }
      if (url === '/api/code/a/repos') {
        aRepoCalls += 1;
        if (aRepoCalls === 1) return { repos: aRepos };
        return currentARepos.promise;
      }
      if (url === '/api/code/b/repos') return lateBRepos.promise;
      if (url.includes('/ls?')) return { entries: [] };
      if (url.includes('/git?')) {
        const root = query(url).get('root');
        if (root === '/a/task') {
          taskGitCalls += 1;
          return lateTaskGit.promise;
        }
        mainGitCalls += 1;
        if (mainGitCalls <= 2) return gitPayload('main-initial.js');
        return currentMainGit.promise;
      }
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const { wrapper, flushPromises } = await mountCodeView(t, { api });

  await wrapper.get('#code-project').setValue('b');
  await wrapper.get('#code-project').setValue('a');
  currentARepos.resolve({ repos: aRepos });
  await settle(flushPromises);
  lateBRepos.reject(new Error('late project B error'));
  await settle(flushPromises);

  assert.equal(wrapper.get('#code-project').element.value, 'a');
  assert.equal(wrapper.get('#code-context').element.value, JSON.stringify(['a', '/a/main']));
  assert.equal(wrapper.find('.perr').exists(), false);
  assert.ok(wrapper.findAll('#code-context option').every((option) => option.text().startsWith('a ·')));

  await selectCodeTab(wrapper, 'changes');
  await settle(flushPromises);
  assert.equal(wrapper.find('button.git-file[data-path="main-initial.js"]').exists(), true);

  await wrapper.get('#code-context').setValue(JSON.stringify(['a', '/a/task']));
  await waitFor(() => taskGitCalls === 1, 'не стартовал Git-запрос старого task-контекста');
  await wrapper.get('#code-context').setValue(JSON.stringify(['a', '/a/main']));
  await waitFor(() => mainGitCalls === 3, 'не стартовал Git-запрос нового main-контекста');
  currentMainGit.resolve(gitPayload('main-current.js'));
  await settle(flushPromises);
  lateTaskGit.resolve(gitPayload('task-late.js'));
  await settle(flushPromises);

  assert.equal(wrapper.find('button.git-file[data-path="main-current.js"]').exists(), true);
  assert.equal(wrapper.find('button.git-file[data-path="task-late.js"]').exists(), false);
  assert.match(wrapper.get('.ehead').text(), /main-current\.js/);
});

test('повторное открытие обновляет Code без пустого кадра и разрыва Monaco-модели', async (t) => {
  const nextProjects = deferred();
  const nextRepos = deferred();
  const nextRoot = deferred();
  const nextFile = deferred();
  let projectsCalls = 0;
  let reposCalls = 0;
  let rootCalls = 0;
  let fileCalls = 0;
  const projectPayload = { projects: [projectFixture('demo', ['/demo'])] };
  const reposPayload = {
    repos: [{ key: 'demo', dir: '/demo', trees: [mainTree('/demo')] }],
  };
  const api = {
    async get(url) {
      if (url === '/api/projects') {
        projectsCalls += 1;
        return projectsCalls === 1 ? projectPayload : nextProjects.promise;
      }
      if (url === '/api/code/demo/repos') {
        reposCalls += 1;
        return reposCalls === 1 ? reposPayload : nextRepos.promise;
      }
      if (url.includes('/ls?')) {
        rootCalls += 1;
        return rootCalls === 1
          ? { entries: [{ name: 'keep.js', dir: false }] }
          : nextRoot.promise;
      }
      if (url.includes('/file?')) {
        fileCalls += 1;
        return fileCalls === 1
          ? { content: 'before', binary: false, tooBig: false, size: 6 }
          : nextFile.promise;
      }
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const { wrapper, flushPromises, monacoState } = await mountCodeView(t, {
    api,
    props: { active: true },
  });

  await wrapper.get('button[data-file-path="keep.js"]').trigger('click');
  await settle(flushPromises);
  const layout = wrapper.get('.lay').element;
  const editor = monacoState.fileEditors[0];
  const originalModel = editor.model;
  assert.equal(originalModel.content, 'before');

  const assertSnapshotVisible = (stage) => {
    assert.equal(wrapper.get('.lay').element === layout, true, `${stage}: layout заменён`);
    assert.equal(wrapper.get('button[data-file-path="keep.js"]').exists(), true,
      `${stage}: дерево очистилось`);
    assert.equal(editor.model, originalModel, `${stage}: Monaco потерял исходную модель`);
    assert.equal(editor.setCalls.includes(null), false, `${stage}: Monaco отвязали от модели`);
    assert.equal(originalModel.disposed, false, `${stage}: модель преждевременно освобождена`);
    assert.equal(wrapper.find('.context-loading').exists(), false,
      `${stage}: фоновое обновление сдвинуло дерево индикатором`);
    assert.doesNotMatch(wrapper.get('.ehead').text(), /читаю/,
      `${stage}: фоновое обновление изменило заголовок`);
  };

  await wrapper.setProps({ active: false });
  await wrapper.setProps({ active: true });
  await waitFor(() => projectsCalls === 2, 'не стартовала повторная загрузка проектов');
  assertSnapshotVisible('projects');

  nextProjects.resolve(projectPayload);
  await waitFor(() => reposCalls === 2, 'не стартовала повторная загрузка репозиториев');
  assertSnapshotVisible('repos');

  nextRepos.resolve(reposPayload);
  await waitFor(() => rootCalls === 2, 'не стартовало повторное чтение корня');
  assertSnapshotVisible('root');

  nextRoot.resolve({ entries: [{ name: 'keep.js', dir: false }] });
  await waitFor(() => fileCalls === 2, 'не стартовало повторное чтение файла');
  assertSnapshotVisible('file');

  nextFile.resolve({ content: 'after', binary: false, tooBig: false, size: 5 });
  await settle(flushPromises);
  assert.equal(wrapper.get('.lay').element === layout, true);
  assert.equal(editor.model.content, 'after');
  assert.notEqual(editor.model, originalModel);
  assert.equal(editor.setCalls.includes(null), false);
  assert.equal(originalModel.disposed, true);
});

test('интерактивное чтение того же файла побеждает тихую revalidation и снимает loading', async (t) => {
  const backgroundFile = deferred();
  const foregroundFile = deferred();
  let fileCalls = 0;
  const api = {
    async get(url) {
      if (url === '/api/projects') return { projects: [projectFixture('demo', ['/demo'])] };
      if (url === '/api/code/demo/repos') {
        return { repos: [{ key: 'demo', dir: '/demo', trees: [mainTree('/demo')] }] };
      }
      if (url.includes('/ls?')) return { entries: [{ name: 'keep.js', dir: false }] };
      if (url.includes('/file?')) {
        fileCalls += 1;
        if (fileCalls === 1) return { content: 'initial', binary: false, tooBig: false, size: 7 };
        if (fileCalls === 2) return backgroundFile.promise;
        if (fileCalls === 3) return foregroundFile.promise;
      }
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const { wrapper, flushPromises, monacoState, browser } = await mountCodeView(t, {
    api,
    props: { active: true },
  });
  await wrapper.get('button[data-file-path="keep.js"]').trigger('click');
  await settle(flushPromises);
  const editor = monacoState.fileEditors[0];
  const originalModel = editor.model;

  await wrapper.setProps({ active: false });
  await wrapper.setProps({ active: true });
  await waitFor(() => fileCalls === 2, 'не стартовало тихое перечитывание файла');
  await wrapper.get('button[data-file-path="keep.js"]').trigger('click');
  await waitFor(() => fileCalls === 3, 'не стартовало интерактивное чтение файла');

  backgroundFile.resolve({ content: 'background', binary: false, tooBig: false, size: 10 });
  await settle(flushPromises);
  assert.equal(editor.model, originalModel);
  assert.equal(editor.setCalls.includes(null), false);
  assert.match(wrapper.get('.ehead').text(), /читаю/);

  foregroundFile.resolve({ content: 'foreground', binary: false, tooBig: false, size: 10 });
  await settle(flushPromises);
  assert.equal(editor.model.content, 'foreground');
  assert.equal(originalModel.disposed, true);
  assert.doesNotMatch(wrapper.get('.ehead').text(), /читаю/);
  const actions = await openFileActions(wrapper, browser, flushPromises);
  assert.equal(actions.querySelector('button[data-action="refresh-file"]').disabled, false);
});

test('временная ошибка фонового чтения сохраняет прежний файл и Monaco-модель', async (t) => {
  const backgroundFile = deferred();
  let fileCalls = 0;
  const api = {
    async get(url) {
      if (url === '/api/projects') return { projects: [projectFixture('demo', ['/demo'])] };
      if (url === '/api/code/demo/repos') {
        return { repos: [{ key: 'demo', dir: '/demo', trees: [mainTree('/demo')] }] };
      }
      if (url.includes('/ls?')) return { entries: [{ name: 'keep.js', dir: false }] };
      if (url.includes('/file?')) {
        fileCalls += 1;
        return fileCalls === 1
          ? { content: 'valid snapshot', binary: false, tooBig: false, size: 14 }
          : backgroundFile.promise;
      }
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const { wrapper, flushPromises, monacoState } = await mountCodeView(t, {
    api,
    props: { active: true },
  });
  await wrapper.get('button[data-file-path="keep.js"]').trigger('click');
  await settle(flushPromises);
  const editor = monacoState.fileEditors[0];
  const originalModel = editor.model;

  await wrapper.setProps({ active: false });
  await wrapper.setProps({ active: true });
  await waitFor(() => fileCalls === 2, 'не стартовало фоновое чтение файла');
  const temporary = Object.assign(new Error('temporary failure'), { status: 500 });
  backgroundFile.reject(temporary);
  await settle(flushPromises);

  assert.equal(editor.model, originalModel);
  assert.equal(originalModel.disposed, false);
  assert.equal(editor.setCalls.includes(null), false);
  assert.equal(wrapper.get('button[data-file-path="keep.js"]').classes().includes('sel'), true);
  assert.match(wrapper.get('.perr').text(), /temporary failure/);
});

test('ответ revalidation не откатывает проект, выбранный человеком во время запроса', async (t) => {
  const nextProjects = deferred();
  let projectCalls = 0;
  const projects = [
    projectFixture('a', ['/a']),
    projectFixture('b', ['/b']),
  ];
  const api = {
    async get(url) {
      if (url === '/api/projects') {
        projectCalls += 1;
        return projectCalls === 1 ? { projects } : nextProjects.promise;
      }
      const match = url.match(/^\/api\/code\/([^/]+)\/repos$/);
      if (match) {
        const id = match[1];
        return { repos: [{ key: id, dir: `/${id}`, trees: [mainTree(`/${id}`)] }] };
      }
      if (url.includes('/ls?')) return { entries: [] };
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const { wrapper, flushPromises } = await mountCodeView(t, {
    api,
    props: { active: true },
  });

  await wrapper.setProps({ active: false });
  await wrapper.setProps({ active: true });
  await waitFor(() => projectCalls === 2, 'не стартовала revalidation проектов');
  await wrapper.get('#code-project').setValue('b');
  await settle(flushPromises);
  assert.equal(wrapper.get('#code-project').element.value, 'b');

  nextProjects.resolve({ projects });
  await settle(flushPromises);
  assert.equal(wrapper.get('#code-project').element.value, 'b');
  assert.equal(wrapper.get('#code-context').element.value, JSON.stringify(['b', '/b']));
});

test('фоновое обновление дерева не отменяет сворачивание каталога человеком', async (t) => {
  const nextRoot = deferred();
  let rootCalls = 0;
  let nestedCalls = 0;
  const api = {
    async get(url) {
      if (url === '/api/projects') return { projects: [projectFixture('demo', ['/demo'])] };
      if (url === '/api/code/demo/repos') {
        return { repos: [{ key: 'demo', dir: '/demo', trees: [mainTree('/demo')] }] };
      }
      if (url.includes('/ls?')) {
        if (query(url).get('dir') === 'src') {
          nestedCalls += 1;
          return { entries: [{ name: 'inside.js', dir: false }] };
        }
        rootCalls += 1;
        return rootCalls === 1
          ? { entries: [{ name: 'src', dir: true }] }
          : nextRoot.promise;
      }
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const { wrapper, flushPromises } = await mountCodeView(t, {
    api,
    props: { active: true },
  });
  await wrapper.get('button[data-dir-path="src"]').trigger('click');
  await settle(flushPromises);
  assert.equal(wrapper.get('button[data-dir-path="src"]').attributes('aria-expanded'), 'true');

  await wrapper.setProps({ active: false });
  await wrapper.setProps({ active: true });
  await waitFor(() => rootCalls === 2, 'не стартовало фоновое чтение корня');
  await wrapper.get('button[data-dir-path="src"]').trigger('click');
  assert.equal(wrapper.get('button[data-dir-path="src"]').attributes('aria-expanded'), 'false');

  nextRoot.resolve({ entries: [{ name: 'src', dir: true }] });
  await waitFor(() => nestedCalls === 2, 'не перечитан раскрытый на старте каталог');
  await settle(flushPromises);
  assert.equal(wrapper.get('button[data-dir-path="src"]').attributes('aria-expanded'), 'false');
  assert.equal(wrapper.find('button[data-file-path="src/inside.js"]').exists(), false);
});

test('Code оставляет навигатор слева и хранит разделитель в dock и route', async (t) => {
  const api = {
    async get(url) {
      if (url === '/api/projects') return { projects: [projectFixture('demo', ['/demo'])] };
      if (url === '/api/code/demo/repos') {
        return { repos: [{ key: 'demo', dir: '/demo', trees: [mainTree('/demo')] }] };
      }
      if (url.includes('/ls?')) return { entries: [] };
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const { browser, wrapper, flushPromises } = await mountCodeView(t, {
    api,
    props: { compact: true },
  });

  const separator = wrapper.get('.code-split');
  assert.equal(separator.attributes('aria-orientation'), 'vertical');
  assert.equal(separator.attributes('aria-valuenow'), '320');
  assert.equal(wrapper.get('.panel').element.nextElementSibling === separator.element, true);
  assert.equal(separator.element.nextElementSibling === wrapper.get('.editorwrap').element, true);

  await separator.trigger('keydown', { key: 'End' });
  await settle(flushPromises);
  assert.equal(separator.attributes('aria-valuenow'), '420');

  await separator.trigger('keydown', { key: 'ArrowLeft' });
  await settle(flushPromises);
  assert.equal(wrapper.get('.code-split').attributes('aria-valuenow'), '404');
  assert.equal(browser.localStorage.getItem('grigdesk-code-dock-nav-width'), '404');

  await wrapper.get('.navigator-toggle').trigger('click');
  assert.equal(wrapper.get('.lay').classes().includes('navigator-collapsed'), true);
  assert.equal(wrapper.find('.code-split').exists(), false);

  await wrapper.get('.navigator-toggle').trigger('click');
  await wrapper.setProps({ compact: false });
  await settle(flushPromises);
  assert.equal(wrapper.get('.lay').classes().includes('compact'), false);
  assert.equal(wrapper.get('.code-split').attributes('role'), 'separator');
});

test('картинка показывается предпросмотром, а не пустым редактором', async (t) => {
  // JSON-роут `file` считает картинку бинарной и отдаёт пустое содержимое: раньше
  // это давало пустой Monaco с пометкой «бинарный» — файл выглядел сломанным.
  const api = {
    url: (path) => `http://brain${path}`,
    async get(url) {
      if (url === '/api/projects') return { projects: [projectFixture('demo', ['/demo'])] };
      if (url === '/api/code/demo/repos') {
        return { repos: [{ key: 'demo', dir: '/demo', trees: [mainTree('/demo')] }] };
      }
      if (url.includes('/ls?')) {
        return { entries: [{ name: 'icon.png', dir: false }, { name: 'app.js', dir: false }] };
      }
      if (url.includes('path=icon.png')) return { size: 5177, binary: true, tooBig: false, content: '' };
      if (url.includes('path=app.js')) return { size: 12, binary: false, tooBig: false, content: 'const a = 1;' };
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const { wrapper, flushPromises, monacoState } = await mountCodeView(t, { api, props: { active: true } });

  await wrapper.get('button[data-file-path="icon.png"]').trigger('click');
  await settle(flushPromises);

  const img = wrapper.get('.imgwrap img');
  assert.equal(img.attributes('src'), 'http://brain/api/code/demo/raw?repo=demo&root=%2Fdemo&path=icon.png');
  assert.equal(img.attributes('alt'), 'icon.png');
  // Пометка «бинарный» у картинки — ложная тревога: показать её как раз есть чем.
  assert.equal(wrapper.get('.ehead .note').text(), 'изображение');
  assert.equal(monacoState.fileEditors.length, 0, 'под картинкой не должно быть редактора');

  // Сорванная загрузка объясняется словами, а не пустым местом.
  await img.trigger('error');
  assert.match(wrapper.get('.imgerr').text(), /Не удалось загрузить изображение/);

  // Обычный файл после картинки открывается редактором как раньше.
  await wrapper.get('button[data-file-path="app.js"]').trigger('click');
  await settle(flushPromises);
  assert.equal(wrapper.find('.imgwrap').exists(), false);
  assert.equal(monacoState.fileEditors.length, 1);
  assert.equal(monacoState.fileEditors[0].model.content, 'const a = 1;');
});

test('intent open-file открывает точную рабочую копию, раскрывает дерево и встаёт на строку', async (t) => {
  // Ссылка из чата адресует репозиторий и КОРЕНЬ дерева: файл задачи обязан открыться
  // в её worktree, а не одноимённым файлом основного дерева.
  const api = {
    url: (path) => path,
    async get(url) {
      if (url === '/api/projects') return { projects: [projectFixture('demo', ['/demo'])] };
      if (url === '/api/code/demo/repos') {
        return {
          repos: [{
            key: 'demo',
            dir: '/demo',
            trees: [mainTree('/demo'), worktree('/work/t1234', 't1234', 'task-1234', 't1234')],
          }],
        };
      }
      if (url.includes('/ls?')) {
        const dir = query(url).get('dir') || '';
        if (dir === '') return { entries: [{ name: 'web', dir: true }] };
        if (dir === 'web') return { entries: [{ name: 'src', dir: true }] };
        if (dir === 'web/src') return { entries: [{ name: 'chat.js', dir: false }] };
        return { entries: [] };
      }
      if (url.includes('path=web%2Fsrc%2Fchat.js')) {
        return { size: 20, binary: false, tooBig: false, content: 'export const chat = 1;' };
      }
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const { wrapper, flushPromises, monacoState } = await mountCodeView(t, { api, props: { active: true } });
  await wrapper.setProps({
    intents: [{
      id: 1, type: 'open-file', project: 'demo', repo: 'demo',
      root: '/work/t1234', path: 'web/src/chat.js', line: 12,
    }],
  });
  await settle(flushPromises, 10);

  assert.equal(wrapper.get('#code-context').element.value, JSON.stringify(['demo', '/work/t1234']));
  assert.equal(wrapper.get('.ehead .epath').text(), 'web/src/chat.js');
  // Каталоги пути раскрыты: иначе файл открылся бы, но потерялся бы в навигаторе.
  assert.equal(wrapper.get('button[data-dir-path="web"]').attributes('aria-expanded'), 'true');
  assert.equal(wrapper.get('button[data-dir-path="web/src"]').attributes('aria-expanded'), 'true');
  assert.equal(wrapper.get('button[data-file-path="web/src/chat.js"]').classes().includes('sel'), true);

  const editor = monacoState.fileEditors[0];
  assert.equal(editor.model.content, 'export const chat = 1;');
  assert.deepEqual(editor.revealed, [12]);
  assert.deepEqual(editor.position, { lineNumber: 12, column: 1 });
  assert.deepEqual(wrapper.emitted('consume-intent'), [[1]]);
});

test('Git показывает индекс и рабочее дерево разными группами с независимыми дифами', async (t) => {
  const git = {
    stat: '',
    tracking: { detached: false, upstream: '', ahead: 0, behind: 0 },
    branch: 'main',
    staged: [
      {
        binary: false,
        tooBig: false,
        path: 'src/a.js',
        status: 'M',
        add: 1,
        del: 0,
        group: 'staged',
        oldContent: 'head a',
        newContent: 'index a'
      },
      {
        binary: false,
        tooBig: false,
        path: 'only-staged.js',
        status: 'M',
        add: 2,
        del: 2,
        group: 'staged',
        oldContent: 'head',
        newContent: 'index'
      },
    ],
    files: [
      {
        binary: false,
        tooBig: false,
        path: 'src/a.js',
        status: 'M',
        add: 3,
        del: 0,
        group: 'work',
        oldContent: 'index a',
        newContent: 'work a'
      },
    ],
    log: [],
  };
  const api = {
    async get(url) {
      if (url === '/api/projects') return { projects: [projectFixture('demo', ['/demo'])] };
      if (url === '/api/code/demo/repos') {
        return { repos: [{ key: 'demo', dir: '/demo', trees: [mainTree('/demo')] }] };
      }
      if (url.includes('/ls?')) return { entries: [] };
      if (url.includes('/git?')) return git;
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const { wrapper, flushPromises, monacoState } = await mountCodeView(t, { api });

  await selectCodeTab(wrapper, 'changes');
  await settle(flushPromises);

  // Две группы с собственными заголовками; переключатель вида один на панель.
  assert.deepEqual(groupHeads(wrapper), [
    { group: 'staged', title: 'В индексе', count: '2' },
    { group: 'work', title: 'В рабочем дереве', count: '1' },
  ]);
  assert.equal(wrapper.findAll('[role="group"][aria-label="Вид изменений"]').length, 1);

  // Один и тот же путь есть в обеих группах и выбирается независимо: у файла в индексе
  // и в рабочем дереве разные стороны дифа, и подменять их друг другом нельзя.
  const staged = wrapper.get('button.git-file[data-group="staged"][data-path="src/a.js"]');
  const work = wrapper.get('button.git-file[data-group="work"][data-path="src/a.js"]');
  await staged.trigger('click');
  await settle(flushPromises);
  assert.equal(staged.classes().includes('sel'), true);
  assert.equal(work.classes().includes('sel'), false);
  assert.equal(monacoState.diffEditors[0].model.original.content, 'head a');
  assert.equal(monacoState.diffEditors[0].model.modified.content, 'index a');
  assert.match(wrapper.get('.ehead').text(), /src\/\s*a\.js/s);
  assert.match(wrapper.get('.diffhead').text(), /HEAD → индекс/s);

  await work.trigger('click');
  await settle(flushPromises);
  assert.equal(work.classes().includes('sel'), true);
  assert.equal(staged.classes().includes('sel'), false);
  assert.equal(monacoState.diffEditors[0].model.original.content, 'index a');
  assert.equal(monacoState.diffEditors[0].model.modified.content, 'work a');
  assert.match(wrapper.get('.ehead').text(), /src\/\s*a\.js/s);
  assert.match(wrapper.get('.diffhead').text(), /индекс → рабочая копия/s);

  // Оверлей «изменений нет» относится к обеим группам сразу: при чистом рабочем
  // дереве и непустом индексе диф выбранного файла существует и закрывать его нечем.
  assert.equal(wrapper.find('.ebody .overlay').exists(), false);

  // Каталоги групп раскрываются порознь.
  await wrapper.get('button.git-dir[data-group="staged"][data-path="src"]').trigger('click');
  await settle(flushPromises);
  assert.equal(wrapper.find('button.git-file[data-group="staged"][data-path="src/a.js"]').exists(), false);
  assert.equal(wrapper.find('button.git-file[data-group="work"][data-path="src/a.js"]').exists(), true);
});

test('Git-кнопки индексируют, генерируют сообщение, коммитят и пушат точный контекст', async (t) => {
  const file = {
    binary: false,
    tooBig: false,
    path: 'src/a.js',
    status: 'M',
    add: 1,
    del: 0,
    oldContent: 'old',
    newContent: 'new',
  };
  let git = {
    stat: '',
    branch: 'main',
    tracking: {
      detached: false,
      upstream: '',
      ahead: 0,
      behind: 0,
    },
    staged: [],
    files: [{ ...file, group: 'work' }],
    log: [],
  };
  const posts = [];
  const api = {
    async get(url) {
      if (url === '/api/projects') {
        return { projects: [projectFixture('demo', ['/demo'])] };
      }
      if (url === '/api/code/demo/repos') {
        return {
          repos: [{ key: 'demo', dir: '/demo', trees: [mainTree('/demo')] }],
        };
      }
      if (url.includes('/ls?')) {
        return { entries: [] };
      }
      if (url.includes('/git?')) {
        return git;
      }

      throw new Error(`unexpected GET ${url}`);
    },
    async post(url, body) {
      posts.push({ url, body });
      if (url.includes('/unstage?')) {
        git = {
          ...git,
          staged: [],
          files: [{ ...file, group: 'work' }],
        };
        return { ok: true, changed: 1 };
      }
      if (url.includes('/stage?')) {
        git = {
          ...git,
          staged: [{ ...file, group: 'staged' }],
          files: [],
        };
        return { ok: true, changed: 1 };
      }
      if (url.includes('/commit-message?')) {
        return {
          ok: true,
          title: 'GrigDesk: добавить Git-действия',
          model: 'claude/claude-test',
          effort: null,
          truncated: false,
        };
      }
      if (url.includes('/commit?')) {
        git = {
          ...git,
          staged: [],
          files: [],
          tracking: {
            ...git.tracking,
            ahead: 1,
          },
          log: [{ hash: 'abc1234', subject: body.message, when: 'сейчас' }],
        };
        return {
          ok: true,
          hash: 'abc1234',
          subject: body.message,
        };
      }
      if (url.includes('/push?')) {
        git = {
          ...git,
          tracking: {
            detached: false,
            upstream: 'origin/main',
            ahead: 0,
            behind: 0,
          },
        };
        return {
          ok: true,
          branch: 'main',
          published: true,
          remote: 'origin',
          tracking: git.tracking,
        };
      }

      throw new Error(`unexpected POST ${url}`);
    },
  };
  const { wrapper, flushPromises } = await mountCodeView(t, { api });

  await selectCodeTab(wrapper, 'changes');
  await settle(flushPromises);
  assert.equal(wrapper.find('input.commit-message').exists(), false);
  await wrapper.get('button[data-action="commit-disclosure"]').trigger('click');
  await settle(flushPromises);
  assert.equal(
    wrapper.get('textarea.commit-message').attributes('placeholder'),
    'Сообщение коммита',
  );

  await wrapper.get('button.git-file-action[data-action="stage"][data-file="src/a.js"]')
    .trigger('click');
  await settle(flushPromises);
  assert.deepEqual(posts[0].body, { paths: ['src/a.js'] });
  assert.match(posts[0].url, /\/api\/code\/demo\/stage\?repo=demo&root=%2Fdemo/);
  assert.equal(wrapper.find('button.git-file[data-group="staged"]').exists(), true);

  await wrapper.get('button.git-group-action[data-action="unstage-all"]').trigger('click');
  await settle(flushPromises);
  assert.deepEqual(posts[1].body, { all: true });
  assert.equal(wrapper.find('button.git-file[data-group="work"]').exists(), true);

  await wrapper.get('button.git-group-action[data-action="stage-all"]').trigger('click');
  await settle(flushPromises);
  assert.deepEqual(posts[2].body, { all: true });

  await wrapper.get('button.generate-commit').trigger('click');
  await settle(flushPromises);
  assert.equal(wrapper.get('textarea.commit-message').element.value,
    'GrigDesk: добавить Git-действия');
  assert.match(wrapper.get('.git-notice').text(), /claude\/claude-test/);

  await wrapper.get('button.commit-action').trigger('click');
  await settle(flushPromises);
  assert.deepEqual(posts[4].body, { message: 'GrigDesk: добавить Git-действия' });
  assert.equal(wrapper.get('textarea.commit-message').element.value, '');
  assert.match(wrapper.get('.git-notice').text(), /abc1234/);
  assert.equal(wrapper.get('button.push-action').attributes('aria-label'), 'Опубликовать');

  await wrapper.get('button.push-action').trigger('click');
  await settle(flushPromises);
  assert.match(wrapper.get('.git-notice').text(), /опубликована/);
  assert.equal(wrapper.get('button.push-action').attributes('aria-label'), 'Пуш');
});

test('пустой индекс оставляет прежний одиночный список «Не в коммите»', async (t) => {
  const api = {
    async get(url) {
      if (url === '/api/projects') return { projects: [projectFixture('demo', ['/demo'])] };
      if (url === '/api/code/demo/repos') {
        return { repos: [{ key: 'demo', dir: '/demo', trees: [mainTree('/demo')] }] };
      }
      if (url.includes('/ls?')) return { entries: [] };
      if (url.includes('/git?')) {
        return {
          stat: '',
          tracking: { detached: false, upstream: '', ahead: 0, behind: 0 },
          branch: 'main',
          staged: [],
          files: [{
            binary: false,
            tooBig: false,
            path: 'a.js',
            status: 'M',
            add: 1,
            del: 1,
            oldContent: 'x',
            newContent: 'y'
          }],
          log: [],
        };
      }
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const { wrapper, flushPromises } = await mountCodeView(t, { api });
  await selectCodeTab(wrapper, 'changes');
  await settle(flushPromises);

  assert.deepEqual(groupHeads(wrapper), [{ group: 'work', title: 'Не в коммите', count: '1' }]);
  // Даже одна группа явно называет стороны: иначе diff индекса и файла не различить.
  assert.equal(wrapper.get('.diffhead .comparison-sides').text(), 'индекс → рабочая копия');
});

test('заголовок группы несёт итог строк, как сводка pull request на GitHub', async (t) => {
  const git = {
    stat: '',
    tracking: { detached: false, upstream: '', ahead: 0, behind: 0 },
    branch: 'main',
    staged: [
      {
        binary: false,
        tooBig: false,
        path: 'src/a.js',
        status: 'M',
        add: 23,
        del: 6,
        group: 'staged',
        oldContent: 'head',
        newContent: 'index'
      },
      {
        binary: false,
        tooBig: false,
        path: 'src/b.js',
        status: 'A',
        add: 2,
        del: 0,
        group: 'staged',
        oldContent: '',
        newContent: 'b'
      },
    ],
    // Бинарный файл строк не несёт: итога у такой группы нет, чтобы не рисовать «+0».
    files: [{
      oldContent: '',
      newContent: '',
      tooBig: false,
      path: 'logo.png',
      status: 'A',
      add: 0,
      del: 0,
      binary: true,
      group: 'work'
    }],
    log: [],
  };
  const api = {
    async get(url) {
      if (url === '/api/projects') return { projects: [projectFixture('demo', ['/demo'])] };
      if (url === '/api/code/demo/repos') {
        return { repos: [{ key: 'demo', dir: '/demo', trees: [mainTree('/demo')] }] };
      }
      if (url.includes('/ls?')) return { entries: [] };
      if (url.includes('/git?')) return git;
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const { wrapper, flushPromises } = await mountCodeView(t, { api });
  await selectCodeTab(wrapper, 'changes');
  await settle(flushPromises);

  const heads = wrapper.findAll('.subhead[data-group]').map((node) => ({
    group: node.attributes('data-group'),
    stat: node.find('.diffstat').exists() ? node.get('.diffstat').text().replace(/\s+/g, '') : '',
    blocks: node.findAll('.diffstat .bar i').map((block) => block.classes()[0]),
  }));
  // 25 добавленных строк против 6 удалённых: четыре зелёных квадратика и один красный.
  assert.deepEqual(heads, [
    { group: 'staged', stat: '+25−6', blocks: ['add', 'add', 'add', 'add', 'del'] },
    { group: 'work', stat: '', blocks: [] },
  ]);
  assert.equal(
    wrapper.get('.diffstat').attributes('data-ui-tooltip'),
    'добавлено строк: 25, удалено строк: 6',
  );
  // Счётчик файлов рядом с заголовком итогом строк не подменяется.
  assert.deepEqual(groupHeads(wrapper).map((head) => head.count), ['2', '1']);
});

test('чистое рабочее дерево при непустом индексе показывает диф, а не «изменений нет»', async (t) => {
  // Всё лежит в индексе (обычное состояние перед коммитом): `files` пуст, и оверлей,
  // завязанный на одну эту группу, закрывал бы существующий диф собой.
  const api = {
    async get(url) {
      if (url === '/api/projects') return { projects: [projectFixture('demo', ['/demo'])] };
      if (url === '/api/code/demo/repos') {
        return { repos: [{ key: 'demo', dir: '/demo', trees: [mainTree('/demo')] }] };
      }
      if (url.includes('/ls?')) return { entries: [] };
      if (url.includes('/git?')) {
        return {
          stat: '',
          tracking: { detached: false, upstream: '', ahead: 0, behind: 0 },
          branch: 'master',
          staged: [{
            binary: false,
            tooBig: false,
            path: 'src/jobResult.ts',
            status: 'M',
            add: 23,
            del: 6,
            oldContent: 'head',
            newContent: 'index'
          }],
          files: [],
          log: [],
        };
      }
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const { wrapper, flushPromises, monacoState } = await mountCodeView(t, { api });
  await selectCodeTab(wrapper, 'changes');
  await settle(flushPromises);

  assert.deepEqual(groupHeads(wrapper), [{ group: 'staged', title: 'В индексе', count: '1' }]);
  assert.equal(wrapper.find('.ebody .overlay').exists(), false);
  assert.equal(monacoState.diffEditors[0].model.original.content, 'head');
  assert.equal(monacoState.diffEditors[0].model.modified.content, 'index');
});

test('лесенка дерева: у файла зарезервировано место под шеврон, глубина едет в CSS', async (t) => {
  const entries = {
    '': [{ name: 'src', dir: true }, { name: 'README.md', dir: false }],
    src: [{ name: 'deep', dir: true }, { name: 'a.js', dir: false }],
    'src/deep': [{ name: 'b.js', dir: false }],
  };
  const api = {
    async get(url) {
      if (url === '/api/projects') return { projects: [projectFixture('demo', ['/demo'])] };
      if (url === '/api/code/demo/repos') {
        return { repos: [{ key: 'demo', dir: '/demo', trees: [mainTree('/demo')] }] };
      }
      if (url.includes('/ls?')) {
        return { entries: entries[query(url).get('dir') || ''] || [] };
      }
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const { wrapper, flushPromises } = await mountCodeView(t, { api });
  await wrapper.get('button[data-dir-path="src"]').trigger('click');
  await settle(flushPromises);
  await wrapper.get('button[data-dir-path="src/deep"]').trigger('click');
  await settle(flushPromises);

  // Глубина уезжает в CSS переменной, а не готовыми пикселями: шаг лесенки обязан
  // сходиться с положением направляющей, и держать его в двух местах нельзя.
  assert.equal(wrapper.get('button[data-dir-path="src/deep"]').attributes('style'), '--depth: 1;');
  assert.equal(wrapper.get('button[data-file-path="src/deep/b.js"]').attributes('style'), '--depth: 2;');

  // У файла место под шеврон занято пустым спейсером: без него имя уезжало влево на
  // ширину стрелки и вставало вровень с каталогом уровнем выше.
  const fileChevron = wrapper.get('button[data-file-path="src/deep/b.js"] .chev');
  assert.equal(fileChevron.text(), '');
  assert.equal(fileChevron.attributes('aria-hidden'), 'true');
  assert.equal(wrapper.get('button[data-dir-path="src/deep"] .chev').text(), '▾');
});

/**
 * Строит панель на одном ответе `/git`, чтобы проверить строку под композером.
 * Каждый вызов — свой браузер и свой стор, поэтому состояния тестов не смешиваются.
 */
async function mountGitPanel(t, gitPayload, {
  branch = 'main',
  post = null,
  patch = null,
  openComposer = true,
} = {}) {
  const api = {
    post,
    async get(url) {
      if (url === '/api/projects') return { projects: [projectFixture('demo', ['/demo'])] };
      if (url === '/api/code/demo/repos') {
        return { repos: [{ key: 'demo', dir: '/demo', trees: [mainTree('/demo', branch)] }] };
      }
      if (url.includes('/ls?')) return { entries: [] };
      if (url.includes('/patch?') && patch) return patch(url);
      if (url.includes('/git?')) return {
        stat: '',
        branch: 'main',
        tracking: { detached: false, upstream: '', ahead: 0, behind: 0 },
        staged: [],
        files: [],
        log: [],
        ...gitPayload
      };
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const mounted = await mountCodeView(t, { api });

  await selectCodeTab(mounted.wrapper, 'changes');
  await settle(mounted.flushPromises);
  const disclosure = mounted.wrapper.find('button[data-action="commit-disclosure"]');

  if (openComposer && disclosure.exists() && disclosure.attributes('aria-expanded') === 'false') {
    await disclosure.trigger('click');
    await settle(mounted.flushPromises);
  }

  return mounted;
}

test('оба переключателя живут в шапке и не дублируются внутри панели', async (t) => {
  const api = {
    async get(url) {
      if (url === '/api/projects') return { projects: [projectFixture('demo', ['/demo'])] };
      if (url === '/api/code/demo/repos') {
        return { repos: [{ key: 'demo', dir: '/demo', trees: [mainTree('/demo')] }] };
      }
      if (url.includes('/ls?')) return { entries: [] };
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const { wrapper } = await mountCodeView(t, { api });

  // Раньше те же два уровня стояли внутри панели и вдобавок дублировались текстом
  // шапки: «demo · demo · Основная · main» плюс плашка «Рабочая копия».
  assert.equal(wrapper.findAll('.code-head select').length, 2);
  assert.equal(wrapper.findAll('.panel select').length, 0);
  assert.equal(wrapper.find('.panel .tlabel').exists(), false);
  assert.equal(wrapper.get('#code-context').element.value, JSON.stringify(['demo', '/demo']));
});

test('композер стоит в нижнем footer и отдаёт полю ввода целую строку', async (t) => {
  const { wrapper } = await mountGitPanel(t, {
    branch: 'main',
    tracking: { detached: false, upstream: 'origin/main', ahead: 0, behind: 0 },
  });

  // Поле — прямой потомок композера: деля строку с кнопками, в доке оно
  // схлопывалось до двух букв, и набрать название коммита было негде.
  assert.equal(wrapper.get('.git-compose-body > textarea.commit-message').exists(), true);
  // Одна строка — только стартовый рост: `rows="1"` держит пустое поле в ритме кнопок.
  assert.equal(wrapper.get('textarea.commit-message').attributes('rows'), '1');
  assert.deepEqual(
    wrapper.findAll('.git-compose-actions > button').map((node) => node.classes()[0]),
    ['generate-commit', 'commit-action'],
  );
  assert.deepEqual(
    wrapper.findAll('.git-remote-actions > button').map((node) => node.classes()[0]),
    ['fetch-action', 'push-action'],
  );
  assert.equal(wrapper.get('.git-footer > .git-sync-row').exists(), true);
  assert.equal(wrapper.find('.git-compose-actions input').exists(), false);
  assert.equal(wrapper.find('.git-compose-actions textarea').exists(), false);
});

test('пустой индекс сворачивает нижний композер, а черновик переживает вкладки', async (t) => {
  const { wrapper, flushPromises } = await mountGitPanel(t, {
    branch: 'main',
    tracking: { detached: false, upstream: '', ahead: 0, behind: 0 },
  }, { openComposer: false });
  const disclosure = wrapper.get('button[data-action="commit-disclosure"]');

  assert.equal(disclosure.attributes('aria-expanded'), 'false');
  assert.match(disclosure.text(), /Коммит.*Индекс пуст/s);
  assert.equal(wrapper.get('.commit-empty-hint').text(), 'Подготовьте файлы кнопкой +');
  assert.equal(wrapper.find('textarea.commit-message').exists(), false);

  await disclosure.trigger('click');
  await wrapper.get('textarea.commit-message').setValue('Черновик до индекса');
  await disclosure.trigger('click');
  await selectCodeTab(wrapper, 'commits');
  await settle(flushPromises);
  await selectCodeTab(wrapper, 'changes');
  await settle(flushPromises);
  await wrapper.get('button[data-action="commit-disclosure"]').trigger('click');
  assert.equal(wrapper.get('textarea.commit-message').element.value, 'Черновик до индекса');

  const source = await readFile(VIEW_PATH, 'utf8');
  const styles = source.slice(source.indexOf('<style'));
  assert.match(styles, /\.git-panel \{ order:\s*10/);
  assert.match(styles, /\.git-footer \{ order:\s*20/);
});

test('появление staged-файлов один раз автоматически раскрывает композер', async (t) => {
  const staged = {
    path: 'a.js', status: 'M', add: 1, del: 0, binary: false,
  };
  const { wrapper } = await mountGitPanel(t, {
    staged: [staged],
    files: [],
  }, { openComposer: false });

  assert.equal(wrapper.get('button[data-action="commit-disclosure"]').attributes('aria-expanded'), 'true');
  assert.match(wrapper.get('.git-index-state').text(), /1 файл в индексе/);
});

test('«Обзор» кеширует patch, рисует строки и возвращает Monaco по шапке файла', async (t) => {
  const patchUrls = [];
  const changed = {
    path: 'src/a.ts', status: 'M', add: 2, del: 1, binary: false,
    oldContent: 'old\n', newContent: 'new\nCOLORIZE_REJECT\n',
  };
  const { wrapper, flushPromises, monacoState } = await mountGitPanel(t, {
    files: [changed],
  }, {
    patch: (url) => {
      patchUrls.push(url);
      return {
        truncated: true,
        patch: `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1,2 @@
-old
+new
+COLORIZE_REJECT
`,
      };
    },
  });
  const review = wrapper.get('button[data-action="patch-review"][data-group="work"]');

  await review.trigger('click');
  await settle(flushPromises, 8);
  assert.equal(patchUrls.length, 1);
  assert.match(patchUrls[0], /\/patch\?.*group=work/);
  assert.equal(wrapper.findAll('.patch-file').length, 1);
  assert.equal(wrapper.findAll('.patch-line.add').length, 2);
  assert.equal(wrapper.findAll('.patch-line.del').length, 1);
  assert.match(wrapper.get('.patch-limit').text(), /первые 2 МБ/);
  assert.ok(monacoState.colorizeCalls.includes('COLORIZE_REJECT'));
  assert.equal(wrapper.get('.patch-file-head').attributes('data-ui-tooltip'), 'src/a.ts');
  assert.match(wrapper.get('.patch-file-head').attributes('aria-label'), /изменён.*добавлено 2.*удалено 1/);

  const patchLines = wrapper.findAll('.patch-line');

  assert.equal(patchLines[0].attributes('tabindex'), '0');
  assert.ok(patchLines.slice(1).every((line) => line.attributes('tabindex') === '-1'));
  await patchLines[1].trigger('focus');
  await settle(flushPromises);
  assert.equal(wrapper.findAll('.patch-line')[1].attributes('tabindex'), '0');
  assert.equal(wrapper.findAll('.patch-line')[0].attributes('tabindex'), '-1');

  await wrapper.get('button.patch-file-head[data-path="src/a.ts"]').trigger('click');
  await settle(flushPromises);
  assert.equal(wrapper.find('[data-view="patch-review"]').exists(), false);

  await review.trigger('click');
  await settle(flushPromises);
  assert.equal(patchUrls.length, 1, 'тот же снимок использует кеш патча');
});

test('бинарный первый файл не лишает строки patch клавиатурного входа', async (t) => {
  const files = [
    { path: 'assets/logo.png', status: 'M', add: 0, del: 0, binary: true },
    { path: 'src/a.ts', status: 'M', add: 1, del: 1, binary: false },
  ];
  const { wrapper, flushPromises } = await mountGitPanel(t, { files }, {
    patch: () => ({
      truncated: false,
      patch: `diff --git a/assets/logo.png b/assets/logo.png
Binary files a/assets/logo.png and b/assets/logo.png differ
diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-old
+new
`,
    }),
  });

  await wrapper.get('button[data-action="patch-review"][data-group="work"]').trigger('click');
  await settle(flushPromises, 8);

  const lines = wrapper.findAll('.patch-line');

  assert.equal(wrapper.findAll('.patch-file').length, 2);
  assert.equal(wrapper.get('[data-file="assets/logo.png"] .patch-special').text(),
    'Бинарные файлы различаются.');
  assert.ok(lines.length > 0);
  assert.equal(lines[0].attributes('tabindex'), '0');
  assert.ok(lines.slice(1).every((line) => line.attributes('tabindex') === '-1'));
});

test('«Спросить агента» создаёт обычный чат с абсолютным файлом и строкой', async (t) => {
  const sessions = [];
  const routes = [];
  const api = {
    async get(url) {
      if (url === '/api/projects') return { projects: [projectFixture('demo', ['/demo'])] };
      if (url === '/api/code/demo/repos') {
        return { repos: [{ key: 'demo', dir: '/demo', trees: [mainTree('/demo')] }] };
      }
      if (url.includes('/ls?')) return { entries: [{ name: 'a.ts', dir: false }] };
      if (url.includes('/file?')) {
        return { size: 12, binary: false, tooBig: false, content: 'one\ntwo\nthree\nfour\n' };
      }
      if (url.includes('/git?')) {
        return {
          branch: 'main', stat: '', files: [], staged: [], log: [], headMessage: '',
          tracking: { detached: false, upstream: '', ahead: 0, behind: 0 },
        };
      }
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const { wrapper, flushPromises, monacoState } = await mountCodeView(t, {
    api,
    chat: { newSession: (options) => { sessions.push(options); return 'chat-1'; } },
    router: { push: async (route) => { routes.push(route); } },
  });

  await wrapper.get('button[data-file-path="a.ts"]').trigger('click');
  await settle(flushPromises);
  monacoState.fileEditors[0].position = { lineNumber: 4, column: 1 };
  await wrapper.get('button[data-action="ask-agent"]').trigger('click');
  await settle(flushPromises);

  assert.equal(sessions.length, 1);
  assert.equal('taskId' in sessions[0], false);
  assert.match(sessions[0].draft, /Рабочая копия Основная, ветка main/);
  assert.match(sessions[0].draft, /Посмотри \/demo\/a\.ts:4/);
  assert.deepEqual(routes, ['/chats']);
});

test('в diff «Спросить агента» берёт patch файла и привязывает чат к задаче', async (t) => {
  const sessions = [];
  const routes = [];
  const calls = [];
  const api = {
    async get(url) {
      calls.push(url);
      if (url === '/api/projects') return { projects: [projectFixture('demo', ['/demo'])] };
      if (url === '/api/code/demo/repos') {
        return {
          repos: [{
            key: 'demo', dir: '/demo',
            trees: [mainTree('/demo'), worktree('/work/t46', 't46', 'task-46', 't46')],
          }],
        };
      }
      if (url.includes('/ls?')) return { entries: [] };
      if (url.includes('/git?')) {
        return {
          branch: 'task-46', stat: '', files: [], staged: [], headMessage: 'change',
          tracking: { detached: false, upstream: '', ahead: 0, behind: 0 },
          log: [{ hash: 'ccccccc', subject: 'change', when: 'сейчас' }],
        };
      }
      if (url.includes('/commits-diff?')) {
        return {
          branch: 'task-46', stat: 'one.js | 1 +',
          files: [{ path: 'one.js', status: 'M', add: 1, del: 0, binary: false }],
          range: {
            from: 'c'.repeat(40), to: 'c'.repeat(40), base: 'b'.repeat(40), commits: 1,
            work: query(url).get('work') === '1',
            work: query(url).get('work') === '1',
          },
        };
      }
      if (url.includes('/file-diff?')) {
        return {
          path: 'one.js', status: 'M', binary: false, tooBig: false,
          oldContent: 'old\n', newContent: 'new\n',
        };
      }
      if (url.includes('/patch?')) {
        return {
          truncated: false,
          patch: 'diff --git a/one.js b/one.js\n--- a/one.js\n+++ b/one.js\n@@ -1 +1 @@\n-old\n+new\n',
        };
      }
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const { wrapper, flushPromises } = await mountCodeView(t, {
    api,
    storage: { 'grigdesk-code-context:demo': JSON.stringify({
      v: 1, repoKey: 'demo', treePath: '/work/t46',
    }) },
    chat: { newSession: (options) => { sessions.push(options); return 'chat-2'; } },
    router: { push: async (route) => { routes.push(route); } },
  });

  await selectCodeTab(wrapper, 'changes');
  await settle(flushPromises);
  await selectCodeTab(wrapper, 'commits');
  await settle(flushPromises);
  await wrapper.get('button.commit[data-hash="ccccccc"]').trigger('click');
  await settle(flushPromises);
  await wrapper.get('button[data-action="ask-agent"]').trigger('click');
  await settle(flushPromises);

  assert.equal(sessions[0].taskId, '46');
  assert.match(sessions[0].draft, /Посмотри \/work\/t46\/one\.js/);
  assert.match(sessions[0].draft, /```diff[\s\S]*-old[\s\S]*\+new/);
  assert.ok(calls.some((url) => /\/patch\?.*group=commits.*path=one\.js/.test(url)));
  assert.deepEqual(routes, ['/chats']);
});

test('Git-навигация не протекает в обычный файл и его историю, а после возврата восстанавливается', async (t) => {
  const calls = [];
  const latest = 'c'.repeat(40);
  const oldest = 'a'.repeat(40);
  const empty = 'e'.repeat(40);
  const api = {
    async get(url) {
      calls.push(url);
      if (url === '/api/projects') return { projects: [projectFixture('demo', ['/demo'])] };
      if (url === '/api/code/demo/repos') {
        return {
          repos: [{
            key: 'demo', dir: '/demo',
            trees: [mainTree('/demo'), worktree('/other', 'other', 'other')],
          }],
        };
      }
      if (url.includes('/ls?')) return { entries: [{ name: 'renamed.ts', dir: false }] };
      if (url.includes('/file?')) {
        return { size: 8, binary: false, tooBig: false, content: 'current\n' };
      }
      if (url.includes('/git?')) {
        return {
          branch: 'main', stat: '', staged: [], log: [], headMessage: '',
          files: [
            { path: 'src/a.ts', status: 'M', add: 1, del: 0, binary: false },
            { path: 'src/b.ts', status: 'M', add: 0, del: 1, binary: false },
          ],
          tracking: { detached: false, upstream: '', ahead: 0, behind: 0 },
        };
      }
      if (url.includes('/file-log?')) {
        return { entries: [
          { hash: latest, base: oldest, subject: 'rename', when: 'сейчас', path: 'renamed.ts' },
          { hash: oldest, base: empty, subject: 'create', when: 'раньше', path: 'old.ts' },
        ] };
      }
      if (url.includes('/file-diff?')) {
        return {
          path: query(url).get('path'), status: 'A', binary: false, tooBig: false,
          oldContent: '', newContent: 'historic\n',
        };
      }
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const { wrapper, flushPromises, monacoState } = await mountCodeView(t, { api });

  await selectCodeTab(wrapper, 'changes');
  await settle(flushPromises);
  assert.equal(wrapper.get('.file-navigation .file-position').text(), 'Файл 1 / 2');
  assert.equal(wrapper.get('button.git-file[data-path="src/a.ts"]').classes().includes('sel'), true);

  await selectCodeTab(wrapper, 'files');
  await settle(flushPromises);
  await wrapper.get('button[data-file-path="renamed.ts"]').trigger('click');
  await settle(flushPromises);
  assert.equal(wrapper.find('.file-navigation').exists(), false);

  await wrapper.get('button[data-action="file-history"]').trigger('click');
  await settle(flushPromises);
  assert.equal(wrapper.findAll('button.file-history-entry').length, 2);
  assert.equal(wrapper.find('.file-tree').exists(), false);
  assert.equal(wrapper.find('.file-navigation').exists(), false);

  await wrapper.get(`button.file-history-entry[data-hash="${oldest}"]`).trigger('click');
  await settle(flushPromises);
  const diffCall = calls.findLast((url) => url.includes('/file-diff?'));
  assert.equal(query(diffCall).get('path'), 'old.ts');
  assert.equal(query(diffCall).get('base'), empty);
  assert.equal(query(diffCall).get('to'), oldest);
  assert.equal(monacoState.diffEditors[0].model.modified.content, 'historic\n');

  await wrapper.get('button[data-action="close-file-history"]').trigger('click');
  await settle(flushPromises);
  assert.equal(wrapper.get('button[data-file-path="renamed.ts"]').classes().includes('sel'), true);
  assert.equal(monacoState.fileEditors[0].model.content, 'current\n');
  assert.equal(wrapper.find('.file-navigation').exists(), false);

  await selectCodeTab(wrapper, 'changes');
  await settle(flushPromises);
  assert.equal(wrapper.get('.file-navigation .file-position').text(), 'Файл 1 / 2');
  assert.equal(wrapper.get('button.git-file[data-path="src/a.ts"]').classes().includes('sel'), true);

  await selectCodeTab(wrapper, 'files');
  await settle(flushPromises);

  await wrapper.get('button[data-action="file-history"]').trigger('click');
  await settle(flushPromises);
  await wrapper.get('#code-context').setValue(JSON.stringify(['demo', '/other']));
  await settle(flushPromises);
  assert.equal(wrapper.find('.file-history').exists(), false);
});

test('blame рисует строки, отбрасывает поздний файл и открывает commit-diff', async (t) => {
  const calls = [];
  const lateA = deferred();
  const nextB = deferred();
  const aHash = 'a'.repeat(40);
  const bHash = 'b'.repeat(40);
  const aBase = '0'.repeat(40);
  const bBase = 'a'.repeat(40);
  let aBlames = 0;
  const api = {
    async get(url) {
      calls.push(url);
      if (url === '/api/projects') {
        return { projects: [projectFixture('demo', ['/demo'])] };
      }
      if (url === '/api/code/demo/repos') {
        return { repos: [{ key: 'demo', dir: '/demo', trees: [mainTree('/demo')] }] };
      }
      if (url.includes('/ls?')) {
        return { entries: [
          { name: 'a.ts', dir: false },
          { name: 'b.ts', dir: false },
        ] };
      }
      if (url.includes('/file?')) {
        return { size: 8, binary: false, tooBig: false, content: 'one\ntwo\n' };
      }
      if (url.includes('/git?')) {
        return {
          branch: 'main', stat: '', files: [], staged: [], log: [], headMessage: '',
          tracking: { detached: false, upstream: '', ahead: 0, behind: 0 },
        };
      }
      if (url.includes('/blame?')) {
        const relPath = query(url).get('path');

        if (relPath === 'a.ts') {
          aBlames += 1;

          if (aBlames > 1) {
            return lateA.promise;
          }

          return { lines: [
            {
              line: 1, hash: aHash, base: aBase, author: 'Анна',
              when: 'сейчас', subject: 'первый',
            },
            {
              line: 2, hash: '', base: '', author: 'Not Committed Yet',
              when: '', subject: 'рабочая копия',
            },
          ] };
        }

        return nextB.promise;
      }
      if (url.includes('/file-diff?')) {
        return {
          path: query(url).get('path'), status: 'M', binary: false, tooBig: false,
          oldContent: 'old\n', newContent: 'new\n',
        };
      }
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const { wrapper, flushPromises, monacoState, browser } = await mountCodeView(t, { api });

  await wrapper.get('button[data-file-path="a.ts"]').trigger('click');
  await settle(flushPromises);
  await wrapper.get('button[data-action="file-actions"]').trigger('click');
  browser.document.querySelector('button[data-action="blame"]').click();
  await settle(flushPromises);

  const decorations = monacoState.decorationCollections[0];

  assert.equal(decorations.decorations.length, 2);
  assert.match(decorations.decorations[0].options.after.content, /aaaaaaa · Анна · сейчас/);
  assert.match(decorations.decorations[1].options.after.content, /не в коммите/);
  assert.equal(browser.localStorage.getItem('grigdesk-code-blame'), '1');

  browser.document.querySelector('button[data-action="blame"]').click();
  assert.equal(decorations.decorations.length, 0);
  assert.equal(browser.localStorage.getItem('grigdesk-code-blame'), '0');

  browser.document.querySelector('button[data-action="blame"]').click();
  await settle(flushPromises);
  await wrapper.get('button[data-file-path="b.ts"]').trigger('click');
  await settle(flushPromises);
  nextB.resolve({ lines: [{
    line: 1, hash: bHash, base: bBase, author: 'Борис',
    when: 'вчера', subject: 'второй',
  }] });
  await settle(flushPromises);
  lateA.resolve({ lines: [{
    line: 1, hash: aHash, base: aBase, author: 'Поздний ответ',
    when: 'давно', subject: 'старый',
  }] });
  await settle(flushPromises);

  assert.equal(decorations.decorations.length, 1);
  assert.match(decorations.decorations[0].options.after.content, /bbbbbbb · Борис · вчера/);

  monacoState.fileEditors[0].mouseDown({
    target: {
      element: { closest: () => ({}) },
      position: { lineNumber: 1, column: 1 },
    },
  });
  await settle(flushPromises);

  const diffCall = calls.findLast((url) => url.includes('/file-diff?'));

  assert.equal(query(diffCall).get('path'), 'b.ts');
  assert.equal(query(diffCall).get('base'), bBase);
  assert.equal(query(diffCall).get('to'), bHash);
});

test('поиск ждёт debounce, открывает строку и отбрасывает поздний ответ', async (t) => {
  const calls = [];
  const slow = deferred();
  const api = {
    async get(url) {
      calls.push(url);
      if (url === '/api/projects') {
        return { projects: [projectFixture('demo', ['/demo'])] };
      }
      if (url === '/api/code/demo/repos') {
        return { repos: [{ key: 'demo', dir: '/demo', trees: [mainTree('/demo')] }] };
      }
      if (url.includes('/ls?')) {
        return { entries: [{ name: 'src', dir: true }] };
      }
      if (url.includes('/git?')) {
        return {
          branch: 'main', stat: '', files: [], staged: [], log: [], headMessage: '',
          tracking: { detached: false, upstream: '', ahead: 0, behind: 0 },
        };
      }
      if (url.includes('/search?')) {
        const value = query(url).get('q');

        if (value === 'needle') {
          return {
            files: [{ path: 'needle-file.ts' }],
            matches: [{ path: 'src/app.ts', line: 7, text: 'const needle = true;' }],
            truncated: false,
          };
        }
        if (value === 'slow') {
          return slow.promise;
        }
        if (value === 'fast') {
          return {
            files: [],
            matches: [{ path: 'src/fast.ts', line: 3, text: 'fast result' }],
            truncated: false,
          };
        }

        return { files: [], matches: [], truncated: false };
      }
      if (url.includes('/file?')) {
        return { size: 12, binary: false, tooBig: false, content: 'line\n'.repeat(10) };
      }
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const { wrapper, flushPromises, monacoState } = await mountCodeView(t, { api });
  const input = wrapper.get('input[data-action="code-search"]');
  const searchCalls = () => calls.filter((url) => url.includes('/search?'));
  const waitDebounce = async () => {
    await new Promise((resolve) => { setTimeout(resolve, 340); });
    await settle(flushPromises);
  };

  await input.setValue('n');
  await waitDebounce();
  assert.equal(searchCalls().length, 0);

  await input.setValue('ne');
  await input.setValue('needle');
  await waitDebounce();

  assert.equal(searchCalls().length, 1);
  assert.equal(query(searchCalls()[0]).get('q'), 'needle');
  assert.equal(wrapper.findAll('[data-search-kind="file"]').length, 1);
  assert.equal(wrapper.findAll('[data-search-kind="match"]').length, 1);

  await input.trigger('keydown', { key: 'Enter' });
  await settle(flushPromises);
  assert.equal(monacoState.fileEditors[0].revealed.at(-1), 1);

  await wrapper.get('[data-search-kind="match"]').trigger('click');
  await settle(flushPromises);
  assert.equal(monacoState.fileEditors[0].revealed.at(-1), 7);

  await input.setValue('slow');
  await waitDebounce();
  await input.setValue('fast');
  await waitDebounce();
  assert.match(wrapper.get('.code-search-results').text(), /fast result/);

  slow.resolve({
    files: [],
    matches: [{ path: 'src/slow.ts', line: 1, text: 'slow result' }],
    truncated: false,
  });
  await settle(flushPromises);
  assert.doesNotMatch(wrapper.get('.code-search-results').text(), /slow result/);

  await input.setValue('zz');
  await waitDebounce();
  assert.match(wrapper.get('.code-search-results').text(), /Ничего не найдено/);
});

test('amend подставляет сообщение HEAD и отправляется без staged-изменений', async (t) => {
  const posts = [];
  const { wrapper, flushPromises, browser } = await mountGitPanel(t, {
    headMessage: 'Старый заголовок\n\nСтарое тело',
    log: [{ hash: 'abc1234', subject: 'Старый заголовок', when: 'сейчас' }],
    tracking: { detached: false, upstream: '', ahead: 0, behind: 0 },
  }, {
    post: async (url, body) => {
      posts.push({ url, body });
      return { ok: true, hash: 'def5678', subject: 'Старый заголовок' };
    },
  });
  const panel = await openCommitMore(wrapper, browser, flushPromises);
  const amend = panel.querySelector('input[data-action="amend"]');

  assert.equal(amend.disabled, false);
  amend.checked = true;
  amend.dispatchEvent(new browser.Event('change', { bubbles: true }));
  await settle(flushPromises);
  assert.equal(wrapper.get('textarea.commit-message').element.value,
    'Старый заголовок\n\nСтарое тело');
  assert.equal(wrapper.get('.git-compose-title').text(), 'Изменение последнего коммита');
  assert.equal(wrapper.get('button.commit-action').text(), 'Дополнить коммит');
  assert.equal(wrapper.find('button[data-action="leave-amend"]').exists(), true);
  assert.equal(wrapper.get('button.commit-action').attributes('disabled'), undefined);

  await wrapper.get('button.commit-action').trigger('click');
  await settle(flushPromises);
  assert.match(posts[0].url, /\/commit\?/);
  assert.deepEqual(posts[0].body, {
    message: 'Старый заголовок\n\nСтарое тело',
    amend: true,
  });
});

test('amend опубликованного HEAD недоступен и объясняет запрет force-push', async (t) => {
  const { wrapper, browser, flushPromises } = await mountGitPanel(t, {
    headMessage: 'Опубликован',
    log: [{ hash: 'abc1234', subject: 'Опубликован', when: 'сейчас' }],
    tracking: { detached: false, upstream: 'origin/main', ahead: 0, behind: 0 },
  });
  const panel = await openCommitMore(wrapper, browser, flushPromises);
  const amend = panel.querySelector('input[data-action="amend"]');

  assert.equal(amend.disabled, true);
  assert.match(
    amend.closest('.ui-switch').getAttribute('data-ui-tooltip'),
    /коммит уже отправлен.*push без force невозможен/i,
  );
});

test('отмена локального HEAD требует подтверждения и возвращает сообщение в композер', async (t) => {
  const posts = [];
  const decisions = [false, true];
  const { wrapper, flushPromises, browser } = await mountGitPanel(t, {
    headMessage: 'Второй коммит',
    log: [
      { hash: 'def5678', subject: 'Второй коммит', when: 'сейчас' },
      { hash: 'abc1234', subject: 'Первый коммит', when: 'минуту назад' },
    ],
    tracking: { detached: false, upstream: '', ahead: 0, behind: 0 },
  }, {
    post: async (url, body) => {
      posts.push({ url, body });
      return { ok: true, message: 'Второй коммит\n\nВозвращённое тело' };
    },
  });
  globalThis.__codeViewConfirm = async () => decisions.shift() ?? false;
  let panel = await openCommitMore(wrapper, browser, flushPromises);
  let undo = panel.querySelector('button[data-action="undo-commit"]');

  undo.click();
  await settle(flushPromises);
  assert.equal(posts.length, 0);

  panel = await openCommitMore(wrapper, browser, flushPromises);
  undo = panel.querySelector('button[data-action="undo-commit"]');
  undo.click();
  await settle(flushPromises);
  assert.equal(posts.length, 1);
  assert.match(posts[0].url, /\/undo-commit\?/);
  assert.deepEqual(posts[0].body, {});
  assert.equal(wrapper.get('textarea.commit-message').element.value,
    'Второй коммит\n\nВозвращённое тело');
});

test('отмена опубликованного HEAD недоступна с подсказкой', async (t) => {
  const { wrapper, browser, flushPromises } = await mountGitPanel(t, {
    headMessage: 'Опубликован',
    log: [
      { hash: 'def5678', subject: 'Опубликован', when: 'сейчас' },
      { hash: 'abc1234', subject: 'Первый', when: 'раньше' },
    ],
    tracking: { detached: false, upstream: 'origin/main', ahead: 0, behind: 0 },
  });
  const panel = await openCommitMore(wrapper, browser, flushPromises);
  const undo = panel.querySelector('button[data-action="undo-commit"]');

  assert.equal(undo.disabled, true);
  assert.match(undo.getAttribute('data-ui-tooltip'), /коммит уже отправлен.*push без force невозможен/i);
});

test('Enter набирает тело сообщения, а коммит уходит по Ctrl+Enter', async (t) => {
  const posts = [];
  const staged = {
    oldContent: '',
    newContent: '',
    binary: false,
    tooBig: false,
    path: 'src/a.js',
    status: 'M',
    add: 1,
    del: 0
  };
  const { wrapper, flushPromises } = await mountGitPanel(
    t,
    { staged: [{ ...staged, group: 'staged' }], files: [] },
    {
      post: async (url, body) => {
        posts.push({ url, body });

        return { ok: true, hash: 'abc1234', subject: body.message };
      },
    },
  );
  const field = wrapper.get('textarea.commit-message');
  await field.setValue('GrigDesk: правка');

  // Голый Enter принадлежит тексту: иначе тело сообщения набрать нечем.
  await field.trigger('keydown', { key: 'Enter' });
  await settle(flushPromises);
  assert.deepEqual(posts, []);

  await field.trigger('keydown', { key: 'Enter', ctrlKey: true });
  await settle(flushPromises);
  assert.equal(posts.length, 1);
  assert.match(posts[0].url, /\/api\/code\/demo\/commit\?/);
  assert.deepEqual(posts[0].body, { message: 'GrigDesk: правка' });
});

test('пустое поле сообщения остаётся в ритме композера, а не в общих 92px', async () => {
  const skin = await readFile(webFile('src/styles/components/fields.css'), 'utf8');
  const block = skin.match(/\.ui-textarea\[data-context='code-commit'\]\s*\{[^}]*\}/);

  // happy-dom раскладку не считает, поэтому компактность стережём статически: живой
  // замер в Chrome дал 30.1px у пустого поля и 84px у полного (потолок в четыре строки).
  assert.ok(block, 'компактный скин поля сообщения не найден в общей библиотеке');
  assert.match(block[0], /min-height:\s*30px/);
  assert.match(block[0], /max-height:\s*84px/);

  // Рост по мере набора — прогрессивное улучшение: без поддержки остаётся строка
  // с прокруткой и ручным разделителем, поэтому правило стоит под @supports.
  assert.match(
    skin,
    /@supports \(field-sizing: content\) \{\s*\.ui-textarea\[data-context='code-commit'\]/,
  );
});

test('строка под композером говорит только то, чего нет в шапке раздела', async (t) => {
  const quiet = await mountGitPanel(t, {
    branch: 'main',
    tracking: { detached: false, upstream: 'origin/main', ahead: 0, behind: 0 },
  });
  // Совпавшая с remote ветка новостью не является: имя ветки шапка уже назвала.
  assert.equal(quiet.wrapper.find('.git-notice').exists(), false);

  const drifted = await mountGitPanel(t, {
    branch: 'main',
    tracking: { detached: false, upstream: 'origin/main', ahead: 2, behind: 1 },
  });
  assert.equal(drifted.wrapper.get('.git-notice').text(), 'origin/main · ↑2 ↓1');

  const fresh = await mountGitPanel(t, {
    branch: 'main',
    tracking: { detached: false, upstream: '', ahead: 0, behind: 0 },
  });
  assert.match(fresh.wrapper.get('.git-notice').text(), /не опубликована/);

  const detached = await mountGitPanel(t, {
    branch: '(detached)',
    tracking: { detached: true, upstream: '', ahead: 0, behind: 0 },
  });
  assert.match(detached.wrapper.get('.git-notice').text(), /detached HEAD/);

  // `refresh` перечитывает гит, но не список рабочих копий: после смены ветки мимо
  // GrigDesk шапка устаревает, и промолчать здесь значило бы соврать.
  const switched = await mountGitPanel(t, {
    branch: 'task-77',
    tracking: { detached: false, upstream: 'origin/main', ahead: 0, behind: 0 },
  }, { branch: 'main' });
  assert.match(switched.wrapper.get('.git-notice').text(), /ветка сменилась на task-77/);
});

test('шаг лесенки и направляющие живут в стилях панели', async () => {
  const source = await readFile(VIEW_PATH, 'utf8');
  const styles = source.slice(source.indexOf('<style'));

  // happy-dom раскладку не считает, поэтому правило стережём статически: живой замер
  // ширины остаётся ручным шагом в браузере.
  assert.match(styles, /--tree-step:\s*\d+px/);
  assert.match(
    styles,
    /padding-left:\s*calc\(var\(--tree-lead\)\s*\+\s*var\(--depth,\s*0\)\s*\*\s*var\(--tree-step\)\)/,
  );
  assert.match(styles, /background-image:\s*repeating-linear-gradient\(to right, var\(--tree-guide\)/);
});

test('шапка разделяет файл и сравнение, а редкие действия доступны через popover', async (t) => {
  const git = {
    stat: '',
    tracking: { detached: false, upstream: '', ahead: 0, behind: 0 },
    branch: 'main',
    staged: [],
    files: [{
      binary: false,
      tooBig: false,
      path: 'src/a.js',
      status: 'M',
      add: 1,
      del: 0,
      group: 'work',
      oldContent: 'old',
      newContent: 'new',
    }],
    log: [],
  };
  const api = {
    async get(url) {
      if (url === '/api/projects') return { projects: [projectFixture('demo', ['/demo'])] };
      if (url === '/api/code/demo/repos') {
        return { repos: [{ key: 'demo', dir: '/demo', trees: [mainTree('/demo')] }] };
      }
      if (url.includes('/ls?')) return { entries: [] };
      if (url.includes('/git?')) return git;
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const { browser, wrapper, flushPromises } = await mountCodeView(t, { api });

  await selectCodeTab(wrapper, 'changes');
  await settle(flushPromises);

  assert.match(wrapper.get('.file-head-row').text(), /a\.js.*История.*Спросить агента/s);
  assert.match(wrapper.get('.diffhead').text(), /индекс → рабочая копия.*Вид сравнения/s);
  assert.equal(wrapper.find('.file-head-row .file-navigation').exists(), false);
  assert.equal(wrapper.find('.diffhead .file-navigation').exists(), false,
    'для единственного файла навигация не рисуется');

  const trigger = wrapper.get('button[data-action="file-actions"]');

  assert.equal(trigger.attributes('aria-label'), 'Действия файла');
  await trigger.trigger('click');
  await settle(flushPromises);

  const popover = browser.document.querySelector('.ui-popover');

  assert.ok(popover);
  assert.equal(popover.getAttribute('role'), 'dialog');
  assert.ok(popover.querySelector('button[data-action="copy-code-link"]'));
  assert.ok(popover.querySelector('button[data-action="refresh-file"]'));
  assert.equal(popover.querySelector('button[data-action="blame"]') === null, true,
    'авторство строк относится только к обычному файлу');

  popover.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await settle(flushPromises);
  assert.equal(browser.document.querySelector('.ui-popover') === null, true);
  assert.equal(browser.document.activeElement === trigger.element, true);

  const source = await readFile(VIEW_PATH, 'utf8');
  const styles = source.slice(source.indexOf('<style'));

  assert.match(styles, /\.epath \{[^}]*min-width:\s*0/);
  assert.match(styles, /\.editorwrap \{[^}]*container:\s*code-editor \/ inline-size/);
  assert.match(styles, /\.ehead \{[^}]*min-height:\s*44px/);
  assert.match(styles, /\.diffhead \{[^}]*min-height:\s*36px/);
  assert.doesNotMatch(styles, /data-action="diff-(?:wrap|whitespace)"[^}]*display:\s*none/);
});

test('обзор изменений занимает тело редактора и прокручивается внутри него', async () => {
  const source = await readFile(webFile('src/views/code/PatchReview.vue'), 'utf8');
  const styles = source.slice(source.indexOf('<style'));

  // Живой случай: обзор на 24 файла обрезался снизу дока без прокрутки. Корень лежал в
  // теле редактора обычным потоком с min-height: 100% — рос по содержимому, и overflow
  // включать было нечему. Monaco там же живёт через position: absolute; inset: 0 —
  // обзору положено то же, тогда overflow: auto прокручивает его внутри тела.
  assert.match(styles, /\.patch-review \{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*overflow:\s*auto/);
  assert.doesNotMatch(styles, /\.patch-review \{[^}]*min-height:\s*100%/);

  // Второй живой случай: строка обзора — кнопка, а кнопка сжимается по содержимому даже как
  // display: grid. Фон «+/−» обрывался на ширине самой длинной строки, правая половина
  // экрана оставалась пустой. Строке нужна явная ширина хунка; хунк остаётся не уже
  // самой длинной строки, чтобы длинный код прокручивался по горизонтали целиком.
  assert.match(styles, /\.patch-line \{[^}]*width:\s*100%/);
  assert.match(styles, /\.patch-hunk \{[^}]*min-width:\s*max-content/);
  // Кнопка центрирует текст: на строке во всю ширину код уезжал в середину экрана.
  assert.match(styles, /\.patch-line \{[^}]*text-align:\s*left/);
});

test('Monaco подключает шрифт значков, а фон изменённых строк различим на тёмной теме', async () => {
  const source = await readFile(webFile('src/shared/monaco.ts'), 'utf8');

  // Живой случай: знаки «+»/«−» и стрелки свёрнутых участков дифа рисовались квадратиками
  // «▯» — это глифы шрифта codicon, а обвязка тянула Monaco без него (@font-face живёт в
  // фиче codicon, не в editor.api). Фон строк на 8% прозрачности человек не различал.
  assert.match(source, /import 'monaco-editor\/features\/codicon\/register';/);

  const alpha = (key) => {
    const match = source.match(new RegExp(`'${key}':\\s*'#[0-9a-f]{6}([0-9a-f]{2})'`, 'i'));

    assert.ok(match, `в теме нет цвета ${key}`);

    return parseInt(match[1], 16) / 255;
  };

  assert.ok(alpha('diffEditor.insertedLineBackground') >= 0.14, 'фон добавленных строк бледнее 14%');
  assert.ok(alpha('diffEditor.removedLineBackground') >= 0.14, 'фон удалённых строк бледнее 14%');
  assert.ok(alpha('diffEditorGutter.insertedLineBackground') >= 0.2, 'поле добавленных строк бледнее 20%');
  assert.ok(alpha('diffEditorGutter.removedLineBackground') >= 0.2, 'поле удалённых строк бледнее 20%');
});

test('кнопки строки изменений лежат в одной обойме и не накладываются друг на друга', async (t) => {
  const git = {
    stat: '',
    tracking: { detached: false, upstream: '', ahead: 0, behind: 0 },
    branch: 'main',
    staged: [],
    files: [{
      binary: false,
      tooBig: false,
      path: 'src/a.js',
      status: 'M',
      add: 16,
      del: 9,
      group: 'work',
      oldContent: 'old',
      newContent: 'new',
    }],
    log: [],
  };
  const api = {
    async get(url) {
      if (url === '/api/projects') return { projects: [projectFixture('demo', ['/demo'])] };
      if (url === '/api/code/demo/repos') {
        return { repos: [{ key: 'demo', dir: '/demo', trees: [mainTree('/demo')] }] };
      }
      if (url.includes('/ls?')) return { entries: [] };
      if (url.includes('/git?')) return git;
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const { wrapper } = await mountCodeView(t, { api });

  await selectCodeTab(wrapper, 'changes');
  await settle(async () => {});

  // Живой случай: «Откатить» и «+» у одной строки рисовались в одной точке — общий скин
  // прижимал КАЖДУЮ кнопку строки к правому краю абсолютно, в расчёте на одну кнопку.
  // Теперь кнопки лежат в обойме .git-row-actions, а к краю прижата она одна.
  const line = wrapper.get('.git-file-line[data-ui-row="code-change"]:not(.git-dir-line)');
  const holders = line.findAll('.git-row-actions');

  assert.equal(holders.length, 1);
  assert.equal(holders[0].findAll('button.git-file-action').length, 2);
  assert.equal(holders[0].get('button[data-action="row-more"]').attributes('aria-haspopup'), 'menu');
  assert.equal(holders[0].find('button[data-action="discard"]').exists(), false);

  const skin = await readFile(webFile('src/styles/components/actions.css'), 'utf8');
  const source = await readFile(VIEW_PATH, 'utf8');
  const styles = source.slice(source.indexOf('<style'));

  assert.doesNotMatch(skin, /code-row-action'\]\s*\{[^}]*position:\s*absolute/);
  assert.match(skin, /code-row-action'\]\s*\{[^}]*color:\s*var\(--ui-action-tone\)/);
  assert.match(skin, /code-group-action'\]\s*\{[^}]*color:\s*var\(--ui-action-tone\)/);
  assert.match(skin, /code-group-action'\]:hover:not\(:disabled\)\s*\{[^}]*var\(--ui-action-soft\)/);
  assert.match(styles, /\.git-row-actions \{[^}]*display:\s*flex/);
  assert.match(styles, /\.git-row-actions \{[^}]*position:\s*absolute/);
  // Колонка действий зарезервирована всегда: hover не двигает имя и не прячет статистику.
  assert.match(skin, /\[data-ui-row='code-change'\] > \.ui-pressable\s*\{[^}]*padding-right/);
  assert.doesNotMatch(styles, /\.git-file-line:hover \.cnt[^}]*visibility:\s*hidden/);
});

test('режим «с текущими» включается подписанной кнопкой, а не значком', async (t) => {
  const git = {
    stat: '',
    tracking: { detached: false, upstream: '', ahead: 0, behind: 0 },
    branch: 'main',
    staged: [],
    files: [],
    log: [{ hash: 'ccccccc', subject: 'c', when: 'сейчас' }],
    headMessage: '',
  };
  const api = {
    async get(url) {
      if (url === '/api/projects') return { projects: [projectFixture('demo', ['/demo'])] };
      if (url === '/api/code/demo/repos') {
        return { repos: [{ key: 'demo', dir: '/demo', trees: [mainTree('/demo')] }] };
      }
      if (url.includes('/ls?')) return { entries: [] };
      if (url.includes('/git?')) return git;
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const { wrapper } = await mountCodeView(t, { api });

  await selectCodeTab(wrapper, 'changes');
  await settle(async () => {});
  await selectCodeTab(wrapper, 'commits');
  await settle(async () => {});

  // «±» никто не расшифровал; режим должен быть виден словами ещё до выбора коммитов,
  // и теми же, что хвост заголовка отрезка «… + текущие».
  const toggle = wrapper.get('[data-action="commits-with-work"]');

  assert.equal(toggle.element.tagName, 'BUTTON');
  assert.match(toggle.text(), /\+ текущие/);
  assert.equal(toggle.attributes('aria-pressed'), 'true');
  assert.ok(toggle.attributes('data-ui-tooltip'));
});

test('фон строки дерева задаёт общий скин и только background-color', async () => {
  const skin = await readFile(webFile('src/styles/components/actions.css'), 'utf8');
  const row = /\.ui-pressable\[data-context='code-tree-row'\][^{]*\{[^}]*\}/g;
  const blocks = skin.match(row) || [];

  // Вид строки живёт в общей библиотеке, а не в плагине: локальную копию этих свойств
  // ловит shrinking-baseline `check:ui-styles`.
  assert.ok(blocks.length >= 4, 'скин строки дерева не найден в общей библиотеке');

  // Фон наведения и выделения — только background-color: shorthand `background`
  // стёр бы background-image с направляющими предков.
  assert.match(skin, /\.ui-pressable\[data-context='code-tree-row'\]:hover\s*\{\s*background-color:/);
  assert.match(
    skin,
    /\.ui-pressable\[data-context='code-tree-row'\]\[aria-pressed='true'\]\s*\{\s*background-color:/,
  );
});

test('повреждённый ответ файла сохраняет модель и не раскрывает отклонённое значение', async (t) => {
  let reads = 0;
  const api = {
    async get(url) {
      if (url === '/api/projects') {
        return { projects: [projectFixture('demo', ['/demo'])] };
      }
      if (url === '/api/code/demo/repos') {
        return { repos: [{ key: 'demo', dir: '/demo', trees: [mainTree('/demo')] }] };
      }
      if (url.includes('/ls?')) {
        return { entries: [{ name: 'keep.js', dir: false }] };
      }
      if (url.includes('/file?')) {
        reads += 1;
        return reads === 1
          ? { content: 'valid snapshot', size: 14, binary: false, tooBig: false }
          : { content: { privateValue: 'НЕ_ПОКАЗЫВАТЬ' }, size: 14, binary: false, tooBig: false };
      }
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const { wrapper, flushPromises, monacoState, browser } = await mountCodeView(t, { api });
  await wrapper.get('[data-file-path="keep.js"]').trigger('click');
  await settle(flushPromises);
  const model = monacoState.fileEditors[0].model;

  await refreshCurrentCode(wrapper, browser, flushPromises);

  assert.equal(monacoState.fileEditors[0].model, model);
  assert.equal(model.disposed, false);
  assert.equal(model.content, 'valid snapshot');
  assert.match(wrapper.get('.perr').text(), /file\.content/);
  assert.doesNotMatch(wrapper.text(), /НЕ_ПОКАЗЫВАТЬ/);
  assert.equal(wrapper.findAll('.note').some((note) => note.text() === 'читаю…'), false);
});

test('повреждённые Git и ответ генератора не заменяют диф и текст сообщения', async (t) => {
  let reads = 0;
  const snapshot = {
    branch: 'main',
    stat: '',
    files: [],
    staged: [{
      path: 'keep.js',
      status: 'M',
      add: 1,
      del: 1,
      binary: false,
      tooBig: false,
      oldContent: 'before',
      newContent: 'after',
    }],
    tracking: { detached: false, upstream: '', ahead: 0, behind: 0 },
    log: [],
  };
  const api = {
    async get(url) {
      if (url === '/api/projects') {
        return { projects: [projectFixture('demo', ['/demo'])] };
      }
      if (url === '/api/code/demo/repos') {
        return { repos: [{ key: 'demo', dir: '/demo', trees: [mainTree('/demo')] }] };
      }
      if (url.includes('/ls?')) {
        return { entries: [] };
      }
      if (url.includes('/git?')) {
        reads += 1;
        return reads === 1 ? snapshot : { ...snapshot, staged: [null] };
      }
      throw new Error(`unexpected GET ${url}`);
    },
    async post(url) {
      assert.match(url, /\/commit-message\?/);
      return { ok: true, title: { invalid: true }, model: 'test', effort: null, truncated: false };
    },
  };
  const { wrapper, flushPromises, monacoState, browser } = await mountCodeView(t, { api });
  await selectCodeTab(wrapper, 'changes');
  await settle(flushPromises);
  const models = monacoState.diffEditors[0].model;
  await wrapper.get('textarea').setValue('Моё сообщение');

  await refreshCurrentCode(wrapper, browser, flushPromises);
  assert.equal(monacoState.diffEditors[0].model, models);
  assert.equal(models.original.disposed, false);
  assert.equal(models.modified.disposed, false);
  assert.match(wrapper.get('.perr').text(), /git\.staged\[0\]/);

  await wrapper.get('button[data-ui-tooltip="Составить сообщение по staged diff"]').trigger('click');
  await settle(flushPromises);
  assert.equal(wrapper.get('textarea').element.value, 'Моё сообщение');
  assert.match(wrapper.get('.git-notice[role="alert"]').text(), /commitTitle\.title/);
  assert.equal(
    wrapper.get('button[data-ui-tooltip="Составить сообщение по staged diff"]').element.disabled,
    false,
  );
  assert.equal(reads, 2);
});

test('неизвестные intents не читают файлы и не блокируют следующую корректную команду', async (t) => {
  const files = [];
  const api = {
    async get(url) {
      if (url === '/api/projects') {
        return { projects: [projectFixture('demo', ['/demo'])] };
      }
      if (url === '/api/code/demo/repos') {
        return { repos: [{ key: 'demo', dir: '/demo', trees: [mainTree('/demo')] }] };
      }
      if (url.includes('/ls?')) {
        return { entries: [{ name: 'keep.js', dir: false }] };
      }
      if (url.includes('/file?')) {
        files.push(query(url).get('path'));
        return { content: 'keep', size: 4, binary: false, tooBig: false };
      }
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const target = { type: 'open-file', project: 'demo', repo: 'demo', root: '/demo', path: 'keep.js' };
  const intents = [
    null,
    { id: 1, ...target, repo: { invalid: true } },
    { id: 2, ...target, line: '3' },
    { id: 3, type: 'unsupported' },
    { id: 4, ...target, line: 0 },
  ];
  const { wrapper, flushPromises, monacoState } = await mountCodeView(t, { api, props: { intents } });
  await settle(flushPromises);

  assert.deepEqual(files, ['keep.js']);
  assert.deepEqual(wrapper.emitted('consume-intent'), [[1], [2], [3], [4]]);
  assert.deepEqual(monacoState.fileEditors[0].revealed, []);

  await wrapper.setProps({ intents: [...intents, { id: 5, ...target, line: 8 }] });
  await settle(flushPromises);
  assert.deepEqual(files, ['keep.js', 'keep.js']);
  assert.deepEqual(wrapper.emitted('consume-intent'), [[1], [2], [3], [4], [5]]);
  assert.deepEqual(monacoState.fileEditors[0].revealed, [8]);

  // Launcher передаёт optional-поля явно: undefined означает отсутствие.
  // null и поля другого типа по-прежнему не становятся командами чтения.
  await wrapper.setProps({
    intents: [
      { id: 6, ...target, project: null },
      { id: 7, ...target, line: null },
      { id: 8, ...target, project: undefined, line: undefined },
    ],
  });
  await settle(flushPromises);
  assert.deepEqual(files, ['keep.js', 'keep.js', 'keep.js']);
  assert.deepEqual(wrapper.emitted('consume-intent'), [[1], [2], [3], [4], [5], [6], [7], [8]]);
  assert.deepEqual(monacoState.fileEditors[0].revealed, [8]);
});

for (const failure of ['malformed', 'network']) {
  test(`смена файла снимает прежнюю модель до ответа ${failure}`, async (t) => {
    const nextFile = deferred();
    const api = {
      async get(url) {
        if (url === '/api/projects') {
          return { projects: [projectFixture('demo', ['/demo'])] };
        }
        if (url === '/api/code/demo/repos') {
          return { repos: [{ key: 'demo', dir: '/demo', trees: [mainTree('/demo')] }] };
        }
        if (url.includes('/ls?')) {
          return { entries: [{ name: 'a.js', dir: false }, { name: 'b.js', dir: false }] };
        }
        if (url.includes('/file?')) {
          return query(url).get('path') === 'a.js'
            ? { content: 'file A', size: 6, binary: false, tooBig: false }
            : nextFile.promise;
        }
        throw new Error(`unexpected GET ${url}`);
      },
    };
    const { wrapper, flushPromises, monacoState } = await mountCodeView(t, { api });
    await wrapper.get('[data-file-path="a.js"]').trigger('click');
    await settle(flushPromises);
    const editor = monacoState.fileEditors[0];
    const model = editor.model;
    assert.equal(model.content, 'file A');

    await wrapper.get('[data-file-path="b.js"]').trigger('click');
    assert.equal(wrapper.get('.ehead .epath').text(), 'b.js');
    assert.equal(editor.model, null);
    assert.equal(model.disposed, true);

    if (failure === 'malformed') {
      nextFile.resolve({ content: null, size: 6, binary: false, tooBig: false });
    } else {
      nextFile.reject(new Error('Сеть недоступна'));
    }
    await settle(flushPromises);

    assert.equal(wrapper.get('.ehead .epath').text(), 'b.js');
    assert.equal(editor.model, null);
    assert.match(wrapper.get('.perr').text(), failure === 'malformed' ? /file\.content/ : /Сеть недоступна/);
    assert.equal(wrapper.findAll('.note').some((note) => note.text() === 'читаю…'), false);
  });
}

test('ленивый Git-диф рисует список сразу, кеширует файл и перечитывает после обновления', async (t) => {
  const firstDiff = deferred();
  const calls = [];
  const snapshot = {
    branch: 'main',
    stat: '',
    files: [{ path: 'app.js', status: 'M', add: 1, del: 1, binary: false, group: 'work' }],
    staged: [],
    tracking: { detached: false, upstream: '', ahead: 0, behind: 0 },
    log: [],
    headMessage: '',
  };
  let diffReads = 0;
  const api = {
    async get(url) {
      calls.push(url);
      if (url === '/api/projects') return { projects: [projectFixture('demo', ['/demo'])] };
      if (url === '/api/code/demo/repos') {
        return { repos: [{ key: 'demo', dir: '/demo', trees: [mainTree('/demo')] }] };
      }
      if (url.includes('/ls?')) return { entries: [] };
      if (url.includes('/git?')) return snapshot;
      if (url.includes('/file-diff?')) {
        diffReads += 1;
        if (diffReads === 1) return firstDiff.promise;
        return {
          path: 'app.js', status: 'M', binary: false, tooBig: false,
          oldContent: 'before refresh', newContent: 'after refresh',
        };
      }
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const { wrapper, flushPromises, monacoState, browser } = await mountCodeView(t, { api });

  await selectCodeTab(wrapper, 'changes');
  await settle(flushPromises);
  assert.equal(wrapper.get('button.git-file[data-path="app.js"]').exists(), true);
  assert.equal(wrapper.get('.diffhead').text().includes('читаю…'), true);
  assert.equal(monacoState.diffEditors.length, 0);

  firstDiff.resolve({
    path: 'app.js', status: 'M', binary: false, tooBig: false,
    oldContent: 'before', newContent: 'after',
  });
  await settle(flushPromises);
  assert.equal(monacoState.diffEditors[0].model.original.content, 'before');
  assert.equal(diffReads, 1);

  await wrapper.get('button.git-file[data-path="app.js"]').trigger('click');
  await settle(flushPromises);
  assert.equal(diffReads, 1, 'повторный выбор использует кеш снимка');

  await refreshCurrentCode(wrapper, browser, flushPromises);
  assert.equal(diffReads, 2);
  assert.equal(monacoState.diffEditors[0].model.modified.content, 'after refresh');
  assert.ok(calls.some((url) => url.includes('group=work') && url.includes('path=app.js')));
});

test('«с текущими» включён по умолчанию: отрезок до HEAD и стороны файла читаются с диска', async (t) => {
  const calls = [];
  const snapshot = {
    branch: 'main',
    stat: '',
    files: [{ path: 'work.js', status: 'M', add: 1, del: 0, binary: false }],
    staged: [],
    tracking: { detached: false, upstream: '', ahead: 0, behind: 0 },
    log: ['ccccccc', 'bbbbbbb', 'aaaaaaa'].map((hash) => ({ hash, subject: hash, when: 'сейчас' })),
    headMessage: '',
  };
  const api = {
    async get(url) {
      calls.push(url);
      if (url === '/api/projects') return { projects: [projectFixture('demo', ['/demo'])] };
      if (url === '/api/code/demo/repos') {
        return { repos: [{ key: 'demo', dir: '/demo', trees: [mainTree('/demo')] }] };
      }
      if (url.includes('/ls?')) return { entries: [] };
      if (url.includes('/git?')) return snapshot;
      if (url.includes('/commits-diff?')) {
        const params = query(url);
        return {
          branch: 'main',
          stat: 'commit.js | 1 +',
          files: [{ path: 'commit.js', status: 'M', add: 1, del: 0, binary: false }],
          range: {
            from: params.get('from').padEnd(40, '1'),
            to: params.get('to').padEnd(40, '2'),
            base: '0'.repeat(40),
            commits: 1,
            work: params.get('work') === '1',
          },
        };
      }
      if (url.includes('/file-diff?')) {
        const params = query(url);
        return {
          path: params.get('path'),
          status: 'M',
          binary: false,
          tooBig: false,
          oldContent: 'old',
          newContent: params.get('work') === '1' ? 'disk' : 'commit',
        };
      }
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const { wrapper, flushPromises, monacoState } = await mountCodeView(t, { api });

  await selectCodeTab(wrapper, 'changes');
  await settle(flushPromises);
  await selectCodeTab(wrapper, 'commits');
  await settle(flushPromises);

  // Боль владельца: диф нескольких коммитов «как обычный диф» — вместе с несохранёнными
  // правками. Поэтому по умолчанию правая сторона отрезка до HEAD — рабочее дерево.
  await wrapper.get('button.commit[data-hash="ccccccc"]').trigger('click');
  await settle(flushPromises);
  const rangeCall = calls.find((url) => url.includes('/commits-diff?'));
  assert.equal(query(rangeCall).get('work'), '1');
  assert.match(wrapper.get('.subhead[data-group="commits"] .subtitle').text(), /Коммит ccccccc \+ текущие/);
  const fileCall = calls.find((url) => url.includes('/file-diff?') && url.includes('group=commits'));
  assert.equal(query(fileCall).get('work'), '1');
  assert.equal(query(fileCall).has('to'), false);
  assert.equal(query(fileCall).get('base'), '0'.repeat(40));
  assert.equal(monacoState.diffEditors[0].model.modified.content, 'disk');

  const toggle = wrapper.get('[data-action="commits-with-work"]');
  assert.equal(toggle.attributes('aria-pressed'), 'true');

  // Выключение — обычный отрезок до коммита; настройка запоминается на устройстве.
  await toggle.trigger('click');
  await settle(flushPromises);
  const committedCall = calls.filter((url) => url.includes('/commits-diff?')).at(-1);
  assert.equal(query(committedCall).has('work'), false);
  assert.equal(wrapper.get('.subhead[data-group="commits"] .subtitle').text().includes('текущие'), false);
  assert.equal(localStorage.getItem('grigdesk-code-commits-work'), '0');
  const committedFile = calls.filter((url) => url.includes('/file-diff?') && url.includes('group=commits')).at(-1);
  assert.equal(query(committedFile).has('work'), false);
  assert.equal(query(committedFile).get('to'), 'ccccccc'.padEnd(40, '2'));

  // Для отрезка, не доходящего до HEAD, режим недоступен и молча не применяется.
  await toggle.trigger('click');
  await settle(flushPromises);
  await wrapper.get('button[data-action="clear-commits"]').trigger('click');
  await settle(flushPromises);
  await wrapper.get('button.commit[data-hash="bbbbbbb"]').trigger('click');
  await settle(flushPromises);
  const olderCall = calls.filter((url) => url.includes('/commits-diff?')).at(-1);
  assert.equal(query(olderCall).get('to'), 'bbbbbbb');
  assert.equal(query(olderCall).has('work'), false);
  const olderToggle = wrapper.get('[data-action="commits-with-work"]');
  assert.equal(olderToggle.attributes('aria-disabled'), 'true');
  assert.match(olderToggle.attributes('data-ui-tooltip'), /последнего коммита/);
});

test('при «+ текущие» слитый диф открывается по клику на файл в любой группе', async (t) => {
  const calls = [];
  const snapshot = {
    branch: 'main',
    stat: '',
    files: [
      { path: 'shared.js', status: 'M', add: 4, del: 0, binary: false },
      { path: 'fresh.js', status: 'A', add: 2, del: 0, binary: false },
    ],
    staged: [],
    tracking: { detached: false, upstream: '', ahead: 0, behind: 0 },
    log: ['ccccccc', 'bbbbbbb'].map((hash) => ({ hash, subject: hash, when: 'сейчас' })),
    headMessage: '',
  };
  const api = {
    async get(url) {
      calls.push(url);
      if (url === '/api/projects') return { projects: [projectFixture('demo', ['/demo'])] };
      if (url === '/api/code/demo/repos') {
        return { repos: [{ key: 'demo', dir: '/demo', trees: [mainTree('/demo')] }] };
      }
      if (url.includes('/ls?')) return { entries: [] };
      if (url.includes('/git?')) return snapshot;
      if (url.includes('/commits-diff?')) {
        const params = query(url);
        const work = params.get('work') === '1';
        return {
          branch: 'main',
          stat: '',
          // С диском отрезок содержит и правку коммита в shared.js, и новый fresh.js.
          files: work
            ? [
              { path: 'shared.js', status: 'M', add: 9, del: 1, binary: false },
              { path: 'fresh.js', status: 'A', add: 2, del: 0, binary: false },
            ]
            : [{ path: 'shared.js', status: 'M', add: 5, del: 1, binary: false }],
          range: {
            from: params.get('from').padEnd(40, '1'),
            to: params.get('to').padEnd(40, '2'),
            base: '0'.repeat(40),
            commits: 1,
            work,
          },
        };
      }
      if (url.includes('/file-diff?')) {
        const params = query(url);
        return {
          path: params.get('path'),
          status: 'M',
          binary: false,
          tooBig: false,
          oldContent: `old ${params.get('group')}`,
          newContent: `new ${params.get('group')}${params.get('work') === '1' ? ' merged' : ''}`,
        };
      }
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const { wrapper, flushPromises, monacoState } = await mountCodeView(t, { api });

  await selectCodeTab(wrapper, 'changes');
  await settle(flushPromises);
  await selectCodeTab(wrapper, 'commits');
  await settle(flushPromises);
  await wrapper.get('button.commit[data-hash="ccccccc"]').trigger('click');
  await settle(flushPromises);
  await selectCodeTab(wrapper, 'changes');
  await settle(flushPromises);

  // Замечание владельца: чтобы увидеть слитые изменения, приходилось искать файл именно в
  // группе коммитов. Теперь при включённом режиме клик по тому же файлу в «Не в коммите»
  // показывает слитый диф отрезка, а строка рабочего дерева остаётся выбранной.
  const fileCalls = () => calls.filter((url) => url.includes('/file-diff?'));
  const workRow = wrapper.get('button.git-file[data-group="work"][data-path="shared.js"]');

  await workRow.trigger('click');
  await settle(flushPromises);
  // Слитый диф shared.js уже был прочитан для группы коммитов — берётся из кеша, без
  // второго запроса; строка рабочего дерева при этом остаётся выбранной.
  assert.equal(workRow.classes().includes('sel'), true);
  assert.equal(monacoState.diffEditors[0].model.modified.content, 'new commits merged');
  assert.match(wrapper.get('.ehead').text(), /shared\.js/s);
  assert.match(wrapper.get('.diffhead').text(), /→ рабочая копия/s);
  assert.equal(
    fileCalls().filter((url) => url.includes('path=shared.js') && url.includes('group=work')).length,
    1,
  );

  // Новый файл только с диска в отрезке тоже есть — слитый диф равен его собственному.
  await wrapper.get('button.git-file[data-group="work"][data-path="fresh.js"]').trigger('click');
  await settle(flushPromises);
  const freshCall = fileCalls().find((url) => url.includes('path=fresh.js'));
  assert.equal(query(freshCall).get('group'), 'commits');

  // Режим выключен — строка рабочего дерева показывает свой обычный диф.
  await selectCodeTab(wrapper, 'commits');
  await settle(flushPromises);
  await wrapper.get('[data-action="commits-with-work"]').trigger('click');
  await settle(flushPromises);
  await selectCodeTab(wrapper, 'changes');
  await settle(flushPromises);
  await wrapper.get('button.git-file[data-group="work"][data-path="shared.js"]').trigger('click');
  await settle(flushPromises);
  assert.equal(monacoState.diffEditors[0].model.modified.content, 'new work');
  assert.match(wrapper.get('.ehead').text(), /shared\.js/s);
  assert.match(wrapper.get('.diffhead').text(), /индекс → рабочая копия/s);
});

test('каталог в группе индексируется и возвращается целиком, порциями по потолку сервера', async (t) => {
  const entry = (path, group) => ({ path, status: 'M', add: 1, del: 0, binary: false, group });
  const posts = [];
  let git = {
    stat: '',
    tracking: { detached: false, upstream: '', ahead: 0, behind: 0 },
    branch: 'main',
    staged: [entry('lib/x.js', 'staged')],
    files: [entry('src/a.js', 'work'), entry('src/deep/b.js', 'work'), entry('src-other/c.js', 'work'), entry('top.js', 'work')],
    log: [],
    headMessage: '',
  };
  const api = {
    async get(url) {
      if (url === '/api/projects') return { projects: [projectFixture('demo', ['/demo'])] };
      if (url === '/api/code/demo/repos') {
        return { repos: [{ key: 'demo', dir: '/demo', trees: [mainTree('/demo')] }] };
      }
      if (url.includes('/ls?')) return { entries: [] };
      if (url.includes('/git?')) return git;
      throw new Error(`unexpected GET ${url}`);
    },
    async post(url, body) {
      posts.push({ url, body });
      return { ok: true, changed: body.paths?.length || 0 };
    },
  };
  const { wrapper, flushPromises, browser } = await mountCodeView(t, { api });

  await selectCodeTab(wrapper, 'changes');
  await settle(flushPromises);

  // Замечание владельца: «+»/«−» были только у файлов, а каталог целиком — только терминалом.
  // У строки каталога та же обойма: в индекс уходят все файлы группы под этим каталогом,
  // граница — по «/», чтобы src не захватил src-other.
  const dirLine = wrapper.get('.git-dir-line[data-ui-row="code-change"][data-dir="src"][data-group="work"]');
  const stageDir = dirLine.get('[data-action="stage-dir"]');

  assert.match(stageDir.attributes('data-ui-tooltip'), /src.*2 файла/);
  await stageDir.trigger('click');
  await settle(flushPromises);
  assert.equal(posts.length, 1);
  assert.match(posts[0].url, /\/api\/code\/demo\/stage\?/);
  assert.deepEqual(posts[0].body, { paths: ['src/a.js', 'src/deep/b.js'] });

  const unstageDir = wrapper.get('.git-dir-line[data-dir="lib"][data-group="staged"] [data-action="unstage-dir"]');

  await unstageDir.trigger('click');
  await settle(flushPromises);
  assert.match(posts[1].url, /\/api\/code\/demo\/unstage\?/);
  assert.deepEqual(posts[1].body, { paths: ['lib/x.js'] });

  // Каталог больше серверного потолка в 500 путей уходит порциями, а не отказом.
  git = {
    ...git,
    files: Array.from({ length: 501 }, (_, index) => entry(`big/f${String(index).padStart(3, '0')}.js`, 'work')),
  };
  await refreshCurrentCode(wrapper, browser, flushPromises);
  posts.length = 0;
  await wrapper.get('.git-dir-line[data-dir="big"][data-group="work"] [data-action="stage-dir"]').trigger('click');
  await settle(flushPromises, 10);
  assert.deepEqual(posts.map((post) => post.body.paths.length), [500, 1]);
});

test('дерево несохранённых изменений сворачивается по заголовку группы и помнит состояние', async (t) => {
  const git = {
    stat: '',
    tracking: { detached: false, upstream: '', ahead: 0, behind: 0 },
    branch: 'main',
    staged: [],
    files: [{ path: 'src/a.js', status: 'M', add: 1, del: 0, binary: false, group: 'work' }],
    log: [{ hash: 'ccccccc', subject: 'c', when: 'сейчас' }],
    headMessage: '',
  };
  const api = {
    async get(url) {
      if (url === '/api/projects') return { projects: [projectFixture('demo', ['/demo'])] };
      if (url === '/api/code/demo/repos') {
        return { repos: [{ key: 'demo', dir: '/demo', trees: [mainTree('/demo')] }] };
      }
      if (url.includes('/ls?')) return { entries: [] };
      if (url.includes('/git?')) return git;
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const { wrapper, flushPromises } = await mountCodeView(t, { api });

  await selectCodeTab(wrapper, 'changes');
  await settle(flushPromises);

  // Журнал больше не зависит от длины дерева: рабочие группы и коммиты разделены вкладками.
  const toggle = wrapper.get('.subhead[data-group="work"] [data-action="toggle-group"]');

  assert.equal(toggle.attributes('aria-expanded'), 'true');
  assert.equal(wrapper.findAll('button.git-file[data-group="work"]').length, 1);
  await toggle.trigger('click');
  await settle(flushPromises);
  assert.equal(toggle.attributes('aria-expanded'), 'false');
  assert.equal(wrapper.findAll('button.git-file[data-group="work"]').length, 0);
  // Счётчик и итог группы остаются в заголовке: свёрнуто — не значит пусто.
  assert.equal(wrapper.get('.subhead[data-group="work"] .cnt').text(), '1');
  assert.equal(wrapper.findAll('button.commit').length, 0);
  assert.deepEqual(JSON.parse(localStorage.getItem('grigdesk-code-collapsed-groups')), ['work']);

  await selectCodeTab(wrapper, 'commits');
  await settle(flushPromises);
  assert.equal(wrapper.findAll('button.commit').length, 1);
  assert.equal(wrapper.findAll('button.git-file[data-group="work"]').length, 0);
  await selectCodeTab(wrapper, 'changes');
  await settle(flushPromises);

  await wrapper.get('.subhead[data-group="work"] [data-action="toggle-group"]').trigger('click');
  await settle(flushPromises);
  assert.equal(wrapper.findAll('button.git-file[data-group="work"]').length, 1);
  assert.deepEqual(JSON.parse(localStorage.getItem('grigdesk-code-collapsed-groups')), []);
});

test('клики по коммитам строят общий отрезок, Shift заполняет промежуток и ✕ снимает выбор', async (t) => {
  const calls = [];
  const snapshot = {
    branch: 'main',
    stat: '',
    files: [{ path: 'work.js', status: 'M', add: 1, del: 0, binary: false }],
    staged: [],
    tracking: { detached: false, upstream: '', ahead: 0, behind: 0 },
    log: ['ccccccc', 'bbbbbbb', 'aaaaaaa'].map((hash) => ({ hash, subject: hash, when: 'сейчас' })),
    headMessage: '',
  };
  const api = {
    async get(url) {
      calls.push(url);
      if (url === '/api/projects') return { projects: [projectFixture('demo', ['/demo'])] };
      if (url === '/api/code/demo/repos') {
        return { repos: [{ key: 'demo', dir: '/demo', trees: [mainTree('/demo')] }] };
      }
      if (url.includes('/ls?')) return { entries: [] };
      if (url.includes('/git?')) return snapshot;
      if (url.includes('/commits-diff?')) {
        const params = query(url);
        const from = params.get('from');
        const to = params.get('to');
        return {
          branch: 'main',
          stat: 'commit.js | 1 +',
          files: [{ path: 'commit.js', status: 'M', add: 1, del: 0, binary: false }],
          range: {
            from: from.padEnd(40, '1'),
            to: to.padEnd(40, '2'),
            base: '0'.repeat(40),
            commits: from === to ? 1 : 3,
            work: params.get('work') === '1',
          },
        };
      }
      if (url.includes('/file-diff?')) {
        const params = query(url);
        const filePath = params.get('path');
        return {
          path: filePath,
          status: 'M',
          binary: false,
          tooBig: false,
          oldContent: `old ${filePath}`,
          newContent: `new ${filePath}`,
        };
      }
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const { wrapper, flushPromises } = await mountCodeView(t, { api });

  await selectCodeTab(wrapper, 'changes');
  await settle(flushPromises);
  await selectCodeTab(wrapper, 'commits');
  await settle(flushPromises);
  await wrapper.get('button.commit[data-hash="ccccccc"]').trigger('click');
  await settle(flushPromises);
  assert.match(wrapper.get('.subhead[data-group="commits"] .subtitle').text(), /Коммит ccccccc/);
  assert.equal(
    wrapper.get('.subhead[data-group="commits"] [data-action="clear-commits"]').exists(),
    true,
  );
  assert.match(wrapper.get('.ehead').text(), /commit\.js/s);
  assert.match(wrapper.get('.diffhead').text(), /→ рабочая копия/s);
  assert.equal(wrapper.get('.diffhead .range-summary').text(), '1 файл, +1 −0');
  assert.equal(wrapper.find(
    '.subhead[data-group="commits"] [data-action="stage-all"], '
    + '.subhead[data-group="commits"] [data-action="unstage-all"], '
    + '.subhead[data-group="commits"] [data-action="discard-all"]',
  ).exists(), false);

  await wrapper.get('button.commit[data-hash="aaaaaaa"]').trigger('click');
  await settle(flushPromises);
  assert.match(wrapper.get('.subhead[data-group="commits"]').text(), /в отрезке ещё 1 коммит/);
  assert.equal(wrapper.get('button.commit[data-hash="bbbbbbb"]').classes().includes('sel'), false);

  await wrapper.get('button[data-action="clear-commits"]').trigger('click');
  await settle(flushPromises);
  await wrapper.get('button.commit[data-hash="ccccccc"]').trigger('click');
  await wrapper.get('button.commit[data-hash="aaaaaaa"]').trigger('click', { shiftKey: true });
  await settle(flushPromises);
  assert.equal(wrapper.get('button.commit[data-hash="bbbbbbb"]').classes().includes('sel'), true);
  assert.equal(wrapper.find('.subhead[data-group="commits"] .group-note').exists(), false);

  await wrapper.get('button[data-action="clear-commits"]').trigger('click');
  await settle(flushPromises);
  assert.equal(wrapper.find('.subhead[data-group="commits"]').exists(), false);
  assert.equal(wrapper.findAll('button.commit').length, 3);
  await selectCodeTab(wrapper, 'changes');
  await settle(flushPromises);
  assert.equal(wrapper.get('button.git-file[data-path="work.js"]').classes().includes('sel'), true);
  assert.ok(calls.some((url) => query(url).get('from') === 'aaaaaaa'
    && query(url).get('to') === 'ccccccc'));
});

test('«Вся ветка» показывает diff worktree, а клик по коммиту возвращает выбор отрезка', async (t) => {
  const calls = [];
  const log = ['ccccccc', 'bbbbbbb'].map((hash) => ({ hash, subject: hash, when: 'сейчас' }));
  const snapshot = {
    branch: 'task-46',
    stat: '',
    files: [],
    staged: [],
    tracking: { detached: false, upstream: '', ahead: 0, behind: 0 },
    log,
    headMessage: '',
  };
  const api = {
    async get(url) {
      calls.push(url);
      if (url === '/api/projects') return { projects: [projectFixture('demo', ['/demo'])] };
      if (url === '/api/code/demo/repos') {
        return {
          repos: [{
            key: 'demo',
            dir: '/demo',
            trees: [mainTree('/demo'), worktree('/work/t46', 't46', 'task-46', 't46')],
          }],
        };
      }
      if (url.includes('/ls?')) return { entries: [] };
      if (url.includes('/git?')) return snapshot;
      if (url.includes('/branch-diff?')) {
        return {
          branch: 'task-46',
          stat: 'branch.js | 1 +',
          files: [{ path: 'branch.js', status: 'M', add: 1, del: 0, binary: false }],
          range: {
            from: 'b'.repeat(40), to: 'c'.repeat(40), base: 'a'.repeat(40), commits: 2,
            work: query(url).get('work') === '1',
          },
        };
      }
      if (url.includes('/commits-diff?')) {
        return {
          branch: 'task-46',
          stat: 'one.js | 1 +',
          files: [{ path: 'one.js', status: 'M', add: 1, del: 0, binary: false }],
          range: {
            from: 'c'.repeat(40), to: 'c'.repeat(40), base: 'b'.repeat(40), commits: 1,
            work: query(url).get('work') === '1',
          },
        };
      }
      if (url.includes('/file-diff?')) {
        const filePath = query(url).get('path');
        return {
          path: filePath,
          status: 'M',
          binary: false,
          tooBig: false,
          oldContent: 'old',
          newContent: 'new',
        };
      }
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const { wrapper, flushPromises } = await mountCodeView(t, {
    api,
    storage: { 'grigdesk-code-context:demo': JSON.stringify({
      v: 1,
      repoKey: 'demo',
      treePath: '/work/t46',
    }) },
  });

  await selectCodeTab(wrapper, 'changes');
  await settle(flushPromises);
  await selectCodeTab(wrapper, 'commits');
  await settle(flushPromises);
  await wrapper.get('button[data-action="branch-diff"]').trigger('click');
  await settle(flushPromises);

  assert.match(wrapper.get('.subhead[data-group="commits"] .subtitle').text(), /Вся ветка · 2 коммита/);
  assert.ok(calls.some((url) => url.includes('/branch-diff?')));

  await wrapper.get('button.commit[data-hash="ccccccc"]').trigger('click');
  await settle(flushPromises);

  assert.match(wrapper.get('.subhead[data-group="commits"] .subtitle').text(), /Коммит ccccccc/);
  assert.ok(calls.some((url) => url.includes('/commits-diff?')));
});

test('«Вся ветка» недоступна у основного дерева без upstream и объясняет причину', async (t) => {
  const api = {
    async get(url) {
      if (url === '/api/projects') return { projects: [projectFixture('demo', ['/demo'])] };
      if (url === '/api/code/demo/repos') {
        return { repos: [{ key: 'demo', dir: '/demo', trees: [mainTree('/demo')] }] };
      }
      if (url.includes('/ls?')) return { entries: [] };
      if (url.includes('/git?')) {
        return {
          branch: 'main', stat: '', files: [], staged: [], log: [], headMessage: '',
          tracking: { detached: false, upstream: '', ahead: 0, behind: 0 },
        };
      }
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const { wrapper, flushPromises } = await mountCodeView(t, { api });

  await selectCodeTab(wrapper, 'changes');
  await settle(flushPromises);
  await selectCodeTab(wrapper, 'commits');
  await settle(flushPromises);

  const branch = wrapper.get('button[data-action="branch-diff"]');

  assert.equal(branch.attributes('disabled'), '');
  assert.match(branch.attributes('data-ui-tooltip'), /нет upstream/);
});

test('chat-done и возврат вкладки тихо обновляют Git одним запросом в полёте', async (t) => {
  const pending = deferred();
  let gitReads = 0;
  const snapshot = (add) => ({
    branch: 'main',
    stat: '',
    files: [{ path: 'src/app.js', status: 'M', add, del: 0, binary: false }],
    staged: [],
    tracking: { detached: false, upstream: '', ahead: 0, behind: 0 },
    log: [],
    headMessage: '',
  });
  const api = {
    async get(url) {
      if (url === '/api/projects') return { projects: [projectFixture('demo', ['/demo'])] };
      if (url === '/api/code/demo/repos') {
        return { repos: [{ key: 'demo', dir: '/demo', trees: [mainTree('/demo')] }] };
      }
      if (url.includes('/ls?')) return { entries: [] };
      if (url.includes('/git?')) {
        gitReads += 1;
        if (gitReads === 2) return pending.promise;
        return snapshot(gitReads);
      }
      if (url.includes('/file-diff?')) {
        return {
          path: 'src/app.js', status: 'M', binary: false, tooBig: false,
          oldContent: 'old', newContent: `new ${gitReads}`,
        };
      }
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const { browser, wrapper, flushPromises } = await mountCodeView(t, { api });

  await selectCodeTab(wrapper, 'changes');
  await settle(flushPromises);
  await wrapper.get('button.git-dir[data-path="src"]').trigger('click');
  assert.equal(wrapper.get('button.git-dir[data-path="src"]').attributes('aria-expanded'), 'false');

  globalThis.__codeViewSse('chat-done', {});
  await waitFor(() => gitReads === 2, 'chat-done не запустил тихое обновление');
  globalThis.__codeViewSse('chat-done', {});
  globalThis.__codeViewSse('chat-done', {});
  await settle(flushPromises);
  assert.equal(gitReads, 2, 'поверх летящего чтения появился второй запрос');

  pending.resolve(snapshot(2));
  await waitFor(() => gitReads === 3, 'отложенное обновление не стартовало после ответа');
  await settle(flushPromises);
  assert.equal(wrapper.get('button.git-dir[data-path="src"]').attributes('aria-expanded'), 'false');

  Object.defineProperty(browser.document, 'visibilityState', {
    value: 'hidden', configurable: true,
  });
  browser.document.dispatchEvent(new browser.Event('visibilitychange'));
  await settle(flushPromises);
  assert.equal(gitReads, 3);

  Object.defineProperty(browser.document, 'visibilityState', {
    value: 'visible', configurable: true,
  });
  browser.document.dispatchEvent(new browser.Event('visibilitychange'));
  await waitFor(() => gitReads === 4, 'возврат видимой вкладки не обновил Git');

  await wrapper.setProps({ active: false });
  globalThis.__codeViewSse('chat-done', {});
  browser.document.dispatchEvent(new browser.Event('visibilitychange'));
  await settle(flushPromises);
  assert.equal(gitReads, 4, 'неактивная панель не должна обновляться');
});

test('вкладка «Код» обновляет файл и Git-метки, но не перечитывает каталоги', async (t) => {
  let listReads = 0;
  let fileReads = 0;
  let gitReads = 0;
  const api = {
    async get(url) {
      if (url === '/api/projects') return { projects: [projectFixture('demo', ['/demo'])] };
      if (url === '/api/code/demo/repos') {
        return { repos: [{ key: 'demo', dir: '/demo', trees: [mainTree('/demo')] }] };
      }
      if (url.includes('/ls?')) {
        listReads += 1;
        return query(url).get('dir') === 'src'
          ? { entries: [{ name: 'app.js', dir: false }] }
          : { entries: [{ name: 'src', dir: true }] };
      }
      if (url.includes('/file?')) {
        fileReads += 1;
        return { content: `version ${fileReads}`, binary: false, tooBig: false, size: 9 };
      }
      if (url.includes('/git?')) {
        gitReads += 1;
        return {
          branch: 'main', stat: '', staged: [], log: [], headMessage: '',
          files: [{
            path: 'src/app.js', status: gitReads === 1 ? 'M' : 'A',
            add: 1, del: 0, binary: false,
          }],
          tracking: { detached: false, upstream: '', ahead: 0, behind: 0 },
        };
      }
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const { wrapper, flushPromises, monacoState } = await mountCodeView(t, { api });

  assert.equal(gitReads, 1, 'вкладка файлов читает дешёвый Git-снимок при активации');
  assert.equal(wrapper.get('button[data-dir-path="src"] .git-dir-dot').exists(), true);

  await wrapper.get('button[data-dir-path="src"]').trigger('click');
  await settle(flushPromises);
  assert.equal(wrapper.get('button[data-file-path="src/app.js"]').attributes('data-status'), 'M');

  await wrapper.get('button[data-file-path="src/app.js"]').trigger('click');
  await settle(flushPromises);
  assert.equal(listReads, 2);
  assert.equal(fileReads, 1);

  globalThis.__codeViewSse('chat-done', {});
  await waitFor(() => fileReads === 2 && gitReads === 2,
    'chat-done не перечитал открытый файл и Git-метки');
  await settle(flushPromises);

  assert.equal(listReads, 2);
  assert.equal(wrapper.get('button[data-file-path="src/app.js"]').attributes('data-status'), 'A');
  assert.equal(monacoState.fileEditors[0].model.content, 'version 2');
});
