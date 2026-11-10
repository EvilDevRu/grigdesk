import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { DEFAULT_CODE_BRANCH_SETTINGS } from '../../shared/plugins/code/codeBranchContracts.ts';
import {
  activeCodeReviewWorkers,
  drainCodeReviewWorkers,
  holdCodeReviewWorkerResponses,
  installCodeReviewWorker,
} from './helpers/code-review-worker.js';

process.env.NODE_ENV = 'test';

// Маршрутный CodeView теперь только adapter. Состояние и Monaco живут в единственном
// CodePanel, поэтому компонентные контракты проверяем непосредственно на нём.
const VIEW_PATH = webFile('src/views/code/CodePanel.vue');
const codeViewSlots = [];
let sharedBrowser = null;
let CodeViewDomWrapper = null;

after(() => {
  sharedBrowser?.close();
  sharedBrowser = null;
});

/**
 * Снимок runtime меняется только ответами двойника HTTP.
 * Компонент проходит настоящие controls и подтверждение без сборки приложения.
 */
async function mountBranchPanel(t, approved) {
  const posts = [];
  const confirmations = [];
  const state = {
    branches: [
      {
        ref: 'refs/heads/dev',
        name: 'dev',
        kind: 'local',
        commit: 'a'.repeat(40),
        current: true,
        occupied: '/demo',
      },
      {
        ref: 'refs/heads/feature/demo',
        name: 'feature/demo',
        kind: 'local',
        commit: 'b'.repeat(40),
        current: false,
        occupied: '',
      },
    ],
    settings: { ...DEFAULT_CODE_BRANCH_SETTINGS },
    job: null,
    actualBranch: 'dev',
    actualCommit: 'a'.repeat(40),
    log: '',
  };
  const api = {
    /**
     * Чтения отдают только публичные данные панели и снимок временного runtime.
     * Отсутствующая ручка должна уронить сценарий вместо ложного пустого ответа.
     */
    async get(url) {
      if (url === '/api/projects') {
        return { projects: [projectFixture('demo', ['/demo'])] };
      }
      if (url === '/api/code/demo/repos') {
        return { repos: [{
          key: 'demo',
          dir: '/demo',
          trees: [mainTree('/demo', 'dev')],
        }] };
      }
      if (url.includes('/ls?')) {
        return { entries: [] };
      }
      if (url.includes('/branches?')) {
        return state;
      }

      throw new Error(`unexpected GET ${url}`);
    },
    async post(url, body) {
      posts.push({ url, body });

      if (url.includes('/branch-settings?')) {
        state.settings = { ...body };
      }

      return state;
    },
  };
  const mounted = await mountCodeView(t, {
    api,
    confirm: async (text) => {
      confirmations.push(text);

      return approved;
    },
  });

  await mounted.wrapper.get('[data-action="code-branches"]').trigger('click');
  await settle(mounted.flushPromises);

  const dialog = new CodeViewDomWrapper(mounted.browser.document.body);

  return {
    ...mounted,
    dialog,
    state,
    posts,
    confirmations,
  };
}

test('CODE-BRANCH-UI: выбор подтверждает папку и коммит, передаёт точные refs и HEAD', async (t) => {
  const h = await mountBranchPanel(t, true);

  assert.match(h.dialog.get('[data-action="branch-actual"]').text(), /dev.*aaaaaaaaaa/);
  await h.dialog.get('select[data-action="branch-choice"]').setValue('refs/heads/feature/demo');
  await h.dialog.get('[data-action="switch-branch"]').trigger('click');
  await settle(h.flushPromises);

  assert.equal(h.confirmations.length, 1);
  assert.match(h.confirmations[0], /feature\/demo.*bbbbbbbbbb/);
  assert.match(h.confirmations[0], /\/demo/);
  assert.equal(h.posts.length, 1);
  assert.match(h.posts[0].url, /\/switch-branch\?repo=demo&root=%2Fdemo/);
  assert.deepEqual(h.posts[0].body, {
    ref: 'refs/heads/feature/demo',
    expectedCommit: 'b'.repeat(40),
    expectedHead: 'a'.repeat(40),
    confirmed: true,
  });

  await h.dialog.get('[data-action="return-branch"]').trigger('click');
  await settle(h.flushPromises);
  assert.equal(h.posts[1].body.ref, 'refs/heads/dev');
});

test('CODE-BRANCH-CANCEL: отмена подтверждения не отправляет мутацию', async (t) => {
  const h = await mountBranchPanel(t, false);

  await h.dialog.get('[data-action="switch-branch"]').trigger('click');
  await settle(h.flushPromises);

  assert.equal(h.confirmations.length, 1);
  assert.equal(h.posts.length, 0);
});

test('CODE-BRANCH-SETTINGS: сохранение команды не запускает переключение', async (t) => {
  const h = await mountBranchPanel(t, true);

  await h.dialog.get('textarea[data-action="branch-setting-build"]').setValue('npm run build');
  await h.dialog.get('[data-action="save-branch-settings"]').trigger('click');
  await settle(h.flushPromises);

  assert.equal(h.posts.length, 1);
  assert.match(h.posts[0].url, /\/branch-settings\?/);
  assert.equal(h.posts[0].body.build, 'npm run build');
  assert.equal(h.confirmations.length, 0);
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

/**
 * Бандл удерживает только переиспользуемый слот, а не порты завершённого сценария.
 * Методы читаются и привязываются к порту текущего mount при каждом обращении.
 */
function codeViewPortStub(name, portName) {
  return `
    const slot = globalThis.__codeViewModuleSlot;
    export const ${name} = new Proxy({}, {
      get(_target, key) {
        const port = slot.ports.${portName};
        const value = port[key];

        return typeof value === 'function' ? value.bind(port) : value;
      },
    });
  `;
}

/**
 * Каждый занятый слот имеет собственный граф SFC и независимые внешние порты.
 * После after-хука слот можно использовать снова без нового вечного ESM-импорта.
 */
async function compileCodeView() {
  return compileVue(VIEW_PATH, {
    expose: ['tab', 'gitPane', 'git', 'gitLoading', 'commitsLoading', 'commitsError',
      'fileHistoryOrigin', 'fileHistoryLoading', 'fileHistoryError', 'fileHistoryEntries'],
    stubs: {
      './apiClient.ts': codeViewPortStub('api', 'api'),
      '../../shared/monaco': codeViewPortStub('monaco', 'monaco') + `
        export const langOf = (path) => path.split('.').pop() || 'plaintext';
        export const READONLY_OPTS = { readOnly: true };
      `,
      '../../composables/useSse': `
        export function useSse(listener) {
          globalThis.__codeViewSse = listener;
          return { connected: { value: true } };
        }
      `,
      '../../stores/chat.ts': `
        const slot = globalThis.__codeViewModuleSlot;
        export const useChatStore = () => slot.ports.chat;
      `,
      '../../router.ts': codeViewPortStub('router', 'router'),
      '../../ui': (`
        import { setUiLocale } from './src/services/locale.ts';
        import { listToasts, dismissToast, dismissAllToasts } from './src/ui.ts';
        globalThis.__codeViewModuleSlot.toasts = {
          list: listToasts,
          dismiss: dismissToast,
          clear: dismissAllToasts,
        };
        globalThis.__codeViewModuleSlot.setLocale = setUiLocale;
        export * from './src/ui.ts';
        export { default as UiLoadingState } from './src/components/feedback/UiLoadingState.vue';
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

/**
 * Двойник сохраняет публичные эффекты Monaco: модели, decorations, зоны и прокрутку.
 * Алгоритм сравнения здесь не вычисляется и ожидаемые диапазоны в него не зашиты.
 */
function makeMonaco() {
  const state = {
    models: [],
    fileEditors: [],
    diffEditors: [],
    colorizeCalls: [],
    decorationCollections: [],
    sideEditors: [],
  };
  /**
   * Каждый редактор владеет своим состоянием и подписками независимо от соседней стороны.
   * Записанные вызовы позволяют проверить синхронизацию без браузерной раскладки.
   */
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
      hiddenAreas: [],
      zones: new Map(),
      scrollTop: 0,
      scrollListeners: new Set(),
      cursorListeners: new Set(),
      layoutListeners: new Set(),
      contentSizeListeners: new Set(),
      getModel() {
        return this.model;
      },
      setHiddenAreas(ranges) {
        this.hiddenAreas = [...ranges];
      },
      changeViewZones(callback) {
        callback({
          addZone: (zone) => {
            const id = String(this.zones.size + 1);

            this.zones.set(id, zone);

            return id;
          },
          removeZone: (id) => this.zones.delete(id),
          layoutZone: () => {},
        });
      },
      getScrollTop() {
        return this.scrollTop;
      },
      /**
       * Прокрутка уведомляет только при изменении позиции, как публичный Monaco API.
       * Это позволяет поймать обратную связь синхронизации двух сторон.
       */
      setScrollTop(value) {
        if (this.scrollTop === value) {
          return;
        }

        this.scrollTop = value;

        for (const listener of this.scrollListeners) {
          listener({ scrollTop: value, scrollTopChanged: true });
        }
      },
      onDidScrollChange(listener) {
        this.scrollListeners.add(listener);

        return { dispose: () => this.scrollListeners.delete(listener) };
      },
      onDidChangeCursorPosition(listener) {
        this.cursorListeners.add(listener);

        return { dispose: () => this.cursorListeners.delete(listener) };
      },
      onDidLayoutChange(listener) {
        this.layoutListeners.add(listener);

        return { dispose: () => this.layoutListeners.delete(listener) };
      },
      onDidContentSizeChange(listener) {
        this.contentSizeListeners.add(listener);

        return { dispose: () => this.contentSizeListeners.delete(listener) };
      },
      revealRangeInCenter(range) {
        this.revealed.push(range.startLineNumber);
      },
      getTopForLineNumber(line) {
        return (line - 1) * 20;
      },
      getLayoutInfo() {
        return { width: 600, height: 720 };
      },
      layout() {},
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
          dispose() {
            this.decorations = [];
          },
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
      /**
       * Оба публичных способа установки decorations записываются одинаково.
       * Удаление старых ids исключает ложный успех на диапазоне предыдущего режима.
       */
      deltaDecorations(previous, decorations) {
        this.decorationMap ||= new Map();

        for (const id of previous) {
          this.decorationMap.delete(id);
        }

        const ids = decorations.map((decoration) => {
          const id = `decoration-${this.decorationSerial = (this.decorationSerial || 0) + 1}`;

          this.decorationMap.set(id, decoration);

          return id;
        });

        if (!this.decorationRecord) {
          this.decorationRecord = { decorations: [] };
          state.decorationCollections.push(this.decorationRecord);
        }

        this.decorationRecord.decorations = [...this.decorationMap.values()];

        return ids;
      },
      dispose() { this.disposed = true; },
    };
    const collection = kind === 'side' ? 'sideEditors' : kind === 'file' ? 'fileEditors' : 'diffEditors';

    state[collection].push(editor);
    return editor;
  };
  const monaco = {
    editor: {
      async colorize(content) {
        state.colorizeCalls.push(content);
        if (content.includes('COLORIZE_REJECT')) throw new Error('tokenizer failed');
        return `<span class="mtk1">${content}</span>`;
      },
      create: (host, options) => makeEditor(host.closest('.code-diff-view') ? 'side' : 'file', options),
      createDiffEditor: (_host, options) => makeEditor('diff', options),
      createModel(content, language) {
        const model = {
          content,
          language,
          disposed: false,
          getValue() {
            return this.content;
          },
          getLineCount() {
            return this.content.split('\n').length;
          },
          getLineContent(line) {
            return this.content.split('\n')[line - 1] || '';
          },
          getLineMaxColumn(line) {
            return this.getLineContent(line).length + 1;
          },
          dispose() { this.disposed = true; },
        };
        state.models.push(model);
        return model;
      },
    },
  };
  return { monaco, state };
}

/**
 * Наблюдает модели и расположение действующего просмотра, не создавая DiffEditor за продукт.
 * Прежний публичный API нужен только для проверки тех же барьеров на исходном commit.
 */
function diffView(state) {
  const legacy = state.diffEditors.find((editor) => !editor.disposed && editor.model);
  const editors = legacy
    ? [legacy]
    : state.sideEditors.filter((editor) => !editor.disposed && editor.model);
  const models = legacy
    ? [legacy.model.original, legacy.model.modified]
    : editors.map((editor) => editor.model);
  const paired = legacy ? legacy.options.renderSideBySide : editors.length === 2;

  return {
    editors,
    models,
    paired,
    legacy,
    original: legacy ? legacy.model.original : paired ? models[0] : null,
    modified: legacy ? legacy.model.modified : models.at(-1),
  };
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
  for (let i = 0; i < cycles; i += 1) {
    await flushPromises();
    await drainCodeReviewWorkers();
  }
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
  installCodeReviewWorker(t);

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

  const slot = codeViewSlots.find((entry) => !entry.busy) || { busy: false };

  if (!codeViewSlots.includes(slot)) {
    codeViewSlots.push(slot);
  }

  let wrapper = null;
  let released = false;
  let unmount = null;

  slot.busy = true;
  slot.ports = {
    api: globalThis.__codeViewApi,
    monaco,
    chat,
    router,
  };
  globalThis.__codeViewModuleSlot = slot;

  /**
   * Явное размонтирование при reload освобождает граф сразу, ещё внутри сценария.
   * Повторный after прежнего mount не очищает порты уже переиспользованного слота.
   */
  function release() {
    if (released) {
      return;
    }

    released = true;
    slot.toasts?.clear();
    slot.ports = null;
    slot.busy = false;
    wrapper = null;
    unmount = null;
  }

  t.after(() => {
    wrapper?.unmount();
    release();
    delete globalThis.__codeViewApi;
    delete globalThis.__codeViewMonaco;
    delete globalThis.__codeViewConfirm;
    delete globalThis.__codeViewPrompt;
    delete globalThis.__codeViewChat;
    delete globalThis.__codeViewRouter;
    delete globalThis.__codeViewSse;
    delete globalThis.__codeViewSetLocale;
    delete globalThis.__codeViewModuleSlot;
  });

  const [{ mount, flushPromises, DOMWrapper, VueWrapper }, CodeView] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    slot.component ||= compileCodeView(),
  ]);

  slot.toasts.clear();
  globalThis.__codeViewSetLocale = slot.setLocale;
  slot.setLocale('ru');
  CodeViewDomWrapper = DOMWrapper;

  wrapper = mount(CodeView, {
    attachTo: browser.document.querySelector('#mount'),
    props,
    global: {
      mixins: [{
        /**
         * Test Utils очищает историю emit только корневого wrapper, но дети тоже передают DOM.
         * После их unmount публичный reader позволяет освободить аргументы завершённых событий.
         */
        unmounted() {
          const history = VueWrapper.prototype.emitted.call({ vm: this });

          for (const key of Object.keys(history)) {
            delete history[key];
          }
        },
      }],
      stubs: { RouterLink: { template: '<a href="/projects"><slot /></a>' } },
    },
  });
  unmount = wrapper.unmount.bind(wrapper);

  wrapper.unmount = () => {
    if (!released) {
      unmount();
      release();
    }
  };
  await settle(flushPromises);

  return {
    browser,
    wrapper,
    flushPromises,
    monacoState,
    toasts: slot.toasts,
  };
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
  assert.equal(
    wrapper.get('#code-context-native').element.value,
    JSON.stringify(['web', '/work/web-preview']),
  );
  assert.deepEqual(
    wrapper.findAll('#code-context-native optgroup').map((group) => group.attributes('label')), [
    'engine', 'web',
  ]);

  const optionTexts = wrapper.findAll('#code-context-native option').map((option) => option.text());

  assert.ok(optionTexts.includes('Основная'));
  assert.ok(optionTexts.includes('Задача t46'));
  assert.ok(optionTexts.includes('web-preview'));
  assert.equal(wrapper.get('#code-context').text(), 'web · web-preview · detached HEAD');
  assert.match(wrapper.get('.context-warning').text(), /broken.*\/missing\/broken/s);
  assert.match(wrapper.get('.context-warning a').text(), /Проекты/);

  const restoredLs = calls.find((url) => url.includes('/api/code/grigdesk/ls?'));
  assert.equal(query(restoredLs).get('repo'), 'web');
  assert.equal(query(restoredLs).get('root'), '/work/web-preview');

  await wrapper.get('#code-context').trigger('click');
  await settle(flushPromises);

  const popup = browser.document.querySelector('.ui-select-popup[data-option-layout="inline"]');

  assert.ok(Boolean(popup));
  assert.deepEqual([...popup.querySelectorAll('.ui-select-group')].map((group) => group.textContent),
    ['engine', 'web']);
  assert.equal(popup.textContent.includes('/work/web-preview'), false);
  assert.match(popup.querySelector('[data-option-index="3"]').getAttribute('data-ui-tooltip'),
    /\/work\/web-preview/u);
  popup.querySelector('[data-option-index="0"]').click();
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
  await wrapper.get('#code-project-native').setValue('solo');
  await settle(flushPromises);
  assert.equal(wrapper.findAll('.code-head select').length, 2);
  assert.deepEqual(
    wrapper.findAll('#code-context-native option').map((option) => option.text()),
    ['Основная'],
  );
  assert.equal(wrapper.get('#code-context-native optgroup').attributes('label'), 'solo');
  assert.equal(wrapper.get('#code-context').text(), 'Основная · trunk');
  assert.equal(wrapper.find('.code-head .tlabel').exists(), false);

  await wrapper.get('#code-project-native').setValue('grigdesk');
  await settle(flushPromises);
  assert.equal(wrapper.get('#code-context-native').element.value, JSON.stringify(['engine', '/engine']));
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

  assert.equal(diffView(monacoState).paired, true);
  await wrapper.get('button.git-file[data-path="src/a.js"]').trigger('click');
  await settle(flushPromises);
  assert.match(wrapper.get('.ehead').text(), /src\/\s*a\.js/s);
  assert.equal(wrapper.get('[data-action="diff-layout-switch"]').text(), 'В одну колонку');
  assert.equal(diffView(monacoState).paired, false,
    'новый файл не оставляет пустую половину side-by-side diff');

  assert.equal(wrapper.get('.file-navigation .file-position').text(), 'Файл 2 / 5');
  await wrapper.get('.file-navigation button[aria-label="Следующий файл"]').trigger('click');
  await settle(flushPromises);
  assert.match(wrapper.get('.ehead').text(), /root\.md/);

  await nested.trigger('click');
  await settle(flushPromises);
  assert.match(wrapper.get('.ehead').text(), /src\/deep\/\s*b\.js/);
  assert.equal(diffView(monacoState).paired, true);
  assert.match(nested.text(), /\+2.*−1/s);

  const rendered = diffView(monacoState);
  const diffSetCalls = rendered.editors.map((editor) => editor.setCalls.length);

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
  assert.deepEqual(diffView(monacoState).editors, rendered.editors);
  assert.deepEqual(rendered.editors.map((editor) => editor.setCalls.length), diffSetCalls);

  await treeButton.trigger('click');
  await settle(flushPromises);
  assert.equal(wrapper.get('button.git-file[data-path="src/deep/b.js"]').classes().includes('sel'), true);
  assert.match(wrapper.get('.ehead').text(), /src\/deep\/\s*b\.js/);
  assert.deepEqual(diffView(monacoState).editors, rendered.editors);
  assert.deepEqual(rendered.editors.map((editor) => editor.setCalls.length), diffSetCalls);

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
          path: 'app.js',
          status: 'M',
          binary: false,
          tooBig: false,
          oldContent: 'const value = 1;\nkept',
          newContent: 'const value = 2;\n  kept  ',
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

  const view = diffView(monacoState);

  for (const editor of view.editors) {
    assert.equal(view.legacy ? editor.options.diffWordWrap : editor.options.wordWrap, 'on');
  }

  if (view.legacy) {
    assert.equal(view.legacy.options.ignoreTrimWhitespace, true);
  } else {
    const lines = reviewDecorations({ monacoState }).filter((decoration) => decoration.options.isWholeLine);

    assert.ok(lines.length > 0);
    assert.ok(lines.every((decoration) => decoration.range.endLineNumber === 1));
  }

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

  for (const editor of view.editors) {
    assert.equal(view.legacy ? editor.options.diffWordWrap : editor.options.wordWrap, 'off');
    assert.ok(editor.optionCalls.some((options) => (
      view.legacy ? options.diffWordWrap === 'off' : options.wordWrap === 'off'
    )));
  }

  if (view.legacy) {
    assert.equal(view.legacy.options.ignoreTrimWhitespace, false);
    assert.ok(view.legacy.optionCalls.some((options) => options.ignoreTrimWhitespace === false));
  } else {
    const lines = reviewDecorations({ monacoState }).filter((decoration) => decoration.options.isWholeLine);

    assert.ok(lines.some((decoration) => decoration.range.endLineNumber === 2),
      'отключение trim подсвечивает реальное различие пробелов второй строки');
  }

  assert.equal(browser.localStorage.getItem('grigdesk-diff-wrap'), '0');
  assert.equal(browser.localStorage.getItem('grigdesk-diff-ws'), '0');
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

  const narrowView = diffView(monacoState);

  assert.equal(narrowView.paired, false);
  assert.equal(narrowView.editors.length, 1);
  assert.equal(narrowView.editors[0].options.fontSize, 13);
  assert.deepEqual(narrowView.editors[0].options.padding, { top: 8, bottom: 8 });
  assert.match(narrowView.modified.content, /const value = 2;/);

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

  const wideView = diffView(monacoState);

  assert.equal(wideView.paired, true);
  assert.equal(wideView.original.content, 'const value = 1;');
  assert.equal(wideView.modified.content, 'const value = 2;');
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

  for (const file of ['tracked.js', 'new.js', 'staged.js']) {
    assert.equal(wrapper.find(`button[data-action="row-more"][data-file="${file}"]`).exists(), true);
  }

  await wrapper.get('button[data-action="group-more"]').trigger('click');
  await settle(flushPromises);
  assert.ok(browser.document.querySelector('button[data-action="discard-all"]'));
  browser.document.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await settle(flushPromises);

  await wrapper.get('button[data-action="row-more"][data-file="tracked.js"]').trigger('click');
  await settle(flushPromises);

  const trackedMenu = browser.document.querySelector('[role="menu"]');

  assert.ok(trackedMenu.querySelector('[data-action="discard-file"]'));
  assert.equal(trackedMenu.querySelector('[data-action="clean-file"]') === null, true);
  trackedMenu.querySelector('[data-action="discard-file"]').click();
  await settle(flushPromises);
  assert.equal(posts.length, 0, 'отказ в диалоге не запускает мутацию');

  await wrapper.get('button[data-action="row-more"][data-file="tracked.js"]').trigger('click');
  await settle(flushPromises);
  browser.document.querySelector('button[data-action="discard-file"][data-file="tracked.js"]').click();
  await settle(flushPromises);
  assert.equal(posts.length, 1);
  assert.match(posts[0].url, /\/discard\?/);
  assert.deepEqual(posts[0].payload, { paths: ['tracked.js'] });
  assert.match(confirmations[0], /tracked\.js.*без возможности отмены/s);

  await wrapper.get('button[data-action="row-more"][data-file="staged.js"]').trigger('click');
  await settle(flushPromises);

  const stagedMenu = browser.document.querySelector('[role="menu"]');

  assert.ok(stagedMenu.querySelector('[data-action="unstage-file"]'));
  assert.equal(stagedMenu.querySelector('[data-action="discard-file"]') === null, true);
  assert.equal(stagedMenu.querySelector('[data-action="clean-file"]') === null, true);
  browser.document.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await settle(flushPromises);
  await wrapper.get('button[data-action="row-more"][data-file="new.js"]').trigger('click');
  await settle(flushPromises);

  const newMenu = browser.document.querySelector('[role="menu"]');

  assert.ok(newMenu.querySelector('[data-action="clean-file"]'));
  assert.equal(newMenu.querySelector('[data-action="discard-file"]') === null, true);
  assert.equal(posts.length, 1, 'Просмотр меню не запускает действие');
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
  const { wrapper, flushPromises, browser } = await mountCodeView(t, { api });

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

  const more = wrapper.find('button[data-action="row-more"][data-file="conflict.txt"]');

  assert.equal(more.exists(), true, 'Конфликтная строка имеет общее меню');
  assert.equal(wrapper.find('button[data-action="group-more"]').exists(), false);

  await more.trigger('click');
  await settle(flushPromises);

  const menu = browser.document.querySelector('[role="menu"]');

  for (const action of ['view-file', 'ask-agent', 'mark-resolved']) {
    assert.ok(menu.querySelector(`[data-action="${action}"]`), action);
  }

  for (const action of ['discard-file', 'clean-file', 'partial-stage', 'ignore-shared', 'ignore-local']) {
    assert.equal(menu.querySelector(`[data-action="${action}"]`) === null, true, action);
  }

  assert.equal(posts.length, 0, 'Чтение меню конфликта не помечает файл разрешённым');
  browser.document.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await settle(flushPromises);

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
  const context = wrapper.get('#code-context-native');

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

  await wrapper.get('#code-context-native').setValue(JSON.stringify(['race', '/race/b']));
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

  await wrapper.get('#code-project-native').setValue('b');
  await wrapper.get('#code-project-native').setValue('a');
  currentARepos.resolve({ repos: aRepos });
  await settle(flushPromises);
  lateBRepos.reject(new Error('late project B error'));
  await settle(flushPromises);

  assert.equal(wrapper.get('#code-project-native').element.value, 'a');
  assert.equal(wrapper.get('#code-context-native').element.value, JSON.stringify(['a', '/a/main']));
  assert.equal(wrapper.find('.perr').exists(), false);
  assert.ok(wrapper.findAll('#code-context-native optgroup').every((group) => {
    return group.attributes('label') === 'a';
  }));

  await selectCodeTab(wrapper, 'changes');
  await settle(flushPromises);
  assert.equal(wrapper.find('button.git-file[data-path="main-initial.js"]').exists(), true);

  await wrapper.get('#code-context-native').setValue(JSON.stringify(['a', '/a/task']));
  await waitFor(() => taskGitCalls === 1, 'не стартовал Git-запрос старого task-контекста');
  await wrapper.get('#code-context-native').setValue(JSON.stringify(['a', '/a/main']));
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
  await wrapper.get('#code-project-native').setValue('b');
  await settle(flushPromises);
  assert.equal(wrapper.get('#code-project-native').element.value, 'b');

  nextProjects.resolve({ projects });
  await settle(flushPromises);
  assert.equal(wrapper.get('#code-project-native').element.value, 'b');
  assert.equal(wrapper.get('#code-context-native').element.value, JSON.stringify(['b', '/b']));
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

  assert.equal(wrapper.get('#code-context-native').element.value, JSON.stringify(['demo', '/work/t1234']));
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
  assert.equal(diffView(monacoState).original.content, 'head a');
  assert.equal(diffView(monacoState).modified.content, 'index a');
  assert.match(wrapper.get('.ehead').text(), /src\/\s*a\.js/s);
  assert.match(wrapper.get('.diffhead').text(), /HEAD → индекс/s);

  await work.trigger('click');
  await settle(flushPromises);
  assert.equal(work.classes().includes('sel'), true);
  assert.equal(staged.classes().includes('sel'), false);
  assert.equal(diffView(monacoState).original.content, 'index a');
  assert.equal(diffView(monacoState).modified.content, 'work a');
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
  const phases = [];
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
    /**
     * Одиночный stage сохраняет прежний endpoint, группы исполняются через preview/token.
     * Снимок меняется только после execute, чтобы тест видел фактический порядок фаз.
     */
    async post(url, body) {
      posts.push({ url, body });

      if (url.includes('/action-preview?')) {
        phases.push(`preview:${body.action}`);

        return {
          token: `group-${body.action}`,
          eligible: body.paths.map((path) => ({ path })),
          excluded: [],
        };
      }

      if (url.includes('/action-execute?')) {
        phases.push(`execute:${body.action}`);
        assert.equal(body.token, `group-${body.action}`);

        git = {
          ...git,
          staged: body.action === 'stage' ? [{ ...file, group: 'staged' }] : [],
          files: body.action === 'unstage' ? [{ ...file, group: 'work' }] : [],
        };

        return {
          ok: true,
          completed: body.paths.map((path) => ({ path })),
          failed: [],
          unattempted: [],
        };
      }
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
  const { wrapper, flushPromises, toasts } = await mountCodeView(t, {
    api,
    confirm: async (text) => {
      phases.push('confirm');
      assert.match(text, /src\/a\.js/);

      return true;
    },
  });

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
  assert.match(posts[1].url, /\/action-preview\?/);
  assert.deepEqual(posts[1].body, {
    action: 'unstage',
    group: 'staged',
    paths: ['src/a.js'],
  });
  assert.match(posts[2].url, /\/action-execute\?/);
  assert.deepEqual(posts[2].body, { ...posts[1].body, token: 'group-unstage' });
  assert.equal(wrapper.find('button.git-file[data-group="work"]').exists(), true);

  await wrapper.get('button.git-group-action[data-action="stage-all"]').trigger('click');
  await settle(flushPromises);
  assert.match(posts[3].url, /\/action-preview\?/);
  assert.deepEqual(posts[3].body, {
    action: 'stage',
    group: 'work',
    paths: ['src/a.js'],
  });
  assert.match(posts[4].url, /\/action-execute\?/);
  assert.deepEqual(posts[4].body, { ...posts[3].body, token: 'group-stage' });
  assert.deepEqual(phases, [
    'preview:unstage', 'confirm', 'execute:unstage',
    'preview:stage', 'confirm', 'execute:stage',
  ]);

  await wrapper.get('button.generate-commit').trigger('click');
  await settle(flushPromises);
  assert.equal(wrapper.get('textarea.commit-message').element.value,
    'GrigDesk: добавить Git-действия');
  assert.match(String(toasts.list().at(-1)?.body), /claude\/claude-test/);

  await wrapper.get('button.commit-action').trigger('click');
  await settle(flushPromises);

  const commit = posts.find((post) => post.url.includes('/commit?'));

  assert.deepEqual(commit.body, { message: 'GrigDesk: добавить Git-действия' });
  assert.equal(wrapper.get('textarea.commit-message').element.value, '');
  assert.match(String(toasts.list().at(-1)?.body), /abc1234/);
  assert.equal(wrapper.get('button.push-action').attributes('aria-label'), 'Опубликовать');

  await wrapper.get('button.push-action').trigger('click');
  await settle(flushPromises);
  assert.match(String(toasts.list().at(-1)?.body), /опубликована/);
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
  assert.equal(diffView(monacoState).original.content, 'head');
  assert.equal(diffView(monacoState).modified.content, 'index');
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

test('CODE-PULL-UI: стрелка получает изменения, блокирует повтор и обновляет историю', async (t) => {
  const pending = deferred();
  const posts = [];
  const payload = {
    tracking: {
      detached: false,
      upstream: 'origin/main',
      remote: 'origin',
      ahead: 0,
      behind: 3,
    },
    log: [],
  };
  const h = await mountGitPanel(t, payload, {
    post: (url, body) => {
      posts.push({ url, body });

      return pending.promise;
    },
  });

  assert.equal(h.wrapper.get('button.pull-action').attributes('aria-label'), 'Получить изменения');
  await h.wrapper.get('button.pull-action').trigger('click');
  assert.equal(h.wrapper.get('button.pull-action').element.disabled, true);
  assert.equal(h.wrapper.get('button.fetch-action').element.disabled, true);
  assert.equal(h.wrapper.get('button.push-action').element.disabled, true);
  await h.wrapper.get('button.pull-action').trigger('click');
  assert.equal(posts.length, 1);
  assert.match(posts[0].url, /\/pull\?/);
  assert.deepEqual(posts[0].body, {});

  payload.tracking = { ...payload.tracking, behind: 0 };
  payload.log = [{
    hash: 'a'.repeat(40),
    subject: 'Полученный коммит',
    when: '2026-01-01',
  }];
  pending.resolve({
    ok: true,
    branch: 'main',
    updated: true,
    tracking: payload.tracking,
  });
  await settle(h.flushPromises);

  assert.equal(h.wrapper.vm.git.tracking.behind, 0);
  assert.equal(h.wrapper.vm.git.log[0].subject, 'Полученный коммит');
  assert.equal(h.wrapper.get('button.pull-action').element.disabled, false);
  assert.match(String(h.toasts.list().at(-1)?.body), /Ветка main обновлена/);
});

test('CODE-PULL-ERROR: отказ fast-forward виден тостом и освобождает кнопку', async (t) => {
  const h = await mountGitPanel(t, {
    tracking: {
      detached: false,
      upstream: 'origin/main',
      ahead: 1,
      behind: 3,
    },
  }, {
    post: async () => {
      throw new Error('История веток разошлась. Fast-forward невозможен.');
    },
  });

  await h.wrapper.get('button.pull-action').trigger('click');
  await settle(h.flushPromises);
  assert.equal(h.toasts.list().at(-1)?.tone, 'danger');
  assert.match(String(h.toasts.list().at(-1)?.body), /Fast-forward невозможен/);
  assert.equal(h.wrapper.get('button.pull-action').element.disabled, false);
  assert.equal(h.wrapper.vm.git.tracking.behind, 3);
});

test('CODE-PULL-UNAVAILABLE: без upstream и при detached HEAD стрелка недоступна', async (t) => {
  const h = await mountGitPanel(t, {});

  assert.equal(h.wrapper.get('button.pull-action').element.disabled, true);
  h.wrapper.vm.git.tracking = {
    detached: true,
    upstream: 'origin/main',
    ahead: 0,
    behind: 1,
  };
  await settle(h.flushPromises);
  assert.equal(h.wrapper.get('button.pull-action').element.disabled, true);
});

/**
 * Задерживает только HTTP-ответ push, сохраняя настоящий компонент и общий центр тостов.
 * Метаданные меняются явно, чтобы повторное открытие читало подтверждённое состояние.
 */
async function mountPendingPush(t) {
  const request = deferred();
  const posts = [];
  const payload = {
    branch: 'main',
    tracking: {
      detached: false,
      upstream: 'origin/main',
      ahead: 1,
      behind: 0,
    },
  };
  const mounted = await mountGitPanel(t, payload, {
    post: async (url, body) => {
      posts.push({ url, body });
      assert.match(url, /\/push\?/);

      return request.promise;
    },
  });
  const complete = () => {
    payload.tracking = { ...payload.tracking, ahead: 0 };
    request.resolve({
      ok: true,
      branch: 'main',
      remote: 'origin',
      published: false,
      tracking: payload.tracking,
    });
  };

  return {
    ...mounted,
    request,
    posts,
    complete,
  };
}

test('CODE-PUSH-BACKGROUND: закрытие панели сохраняет результат и закрываемый общий тост', async (t) => {
  const h = await mountPendingPush(t);

  await h.wrapper.get('button.push-action').trigger('click');
  await h.wrapper.setProps({ active: false });
  h.complete();
  await settle(h.flushPromises);

  assert.equal(h.posts.length, 1);
  assert.equal(h.wrapper.vm.git.tracking.ahead, 0);
  assert.equal(h.wrapper.find('.git-notice').exists(), false);
  assert.match(String(h.toasts.list().at(-1)?.body), /main.*отправлена/);

  const toast = h.toasts.list().at(-1);

  assert.equal(h.toasts.dismiss(toast.id, 'user'), true);
  assert.equal(h.toasts.list().length, 0);
  await h.wrapper.setProps({ active: true });
  await settle(h.flushPromises);
  assert.equal(h.wrapper.find('.git-notice').exists(), false);
});

test('CODE-PUSH-BUSY: повторное открытие не разрешает второй push до ответа', async (t) => {
  const h = await mountPendingPush(t);

  await h.wrapper.get('button.push-action').trigger('click');
  await h.wrapper.setProps({ active: false });
  await h.wrapper.setProps({ active: true });
  await settle(h.flushPromises);
  assert.equal(h.wrapper.get('button.push-action').element.disabled, true);
  await h.wrapper.get('button.push-action').trigger('click');
  assert.equal(h.posts.length, 1);
  h.complete();
  await settle(h.flushPromises);
  assert.equal(h.wrapper.get('button.push-action').element.disabled, false);
  assert.equal(h.wrapper.vm.git.tracking.ahead, 0);
});

test('CODE-PUSH-ERROR: ошибка после закрытия показывается тостом и освобождает кнопку', async (t) => {
  const h = await mountPendingPush(t);

  await h.wrapper.get('button.push-action').trigger('click');
  await h.wrapper.setProps({ active: false });
  h.request.reject(new Error('Remote rejected push'));
  await settle(h.flushPromises);
  assert.equal(h.toasts.list().at(-1)?.tone, 'danger');
  assert.match(String(h.toasts.list().at(-1)?.body), /Remote rejected push/);
  assert.equal(h.wrapper.find('.git-notice[role="alert"]').exists(), false);
  await h.wrapper.setProps({ active: true });
  await settle(h.flushPromises);
  assert.equal(h.wrapper.get('button.push-action').element.disabled, false);
});

test('CODE-PUSH-UNMOUNT: ответ после уничтожения панели всё равно попадает в общий тост', async (t) => {
  const h = await mountPendingPush(t);

  await h.wrapper.get('button.push-action').trigger('click');
  h.wrapper.unmount();
  h.complete();
  await settle(h.flushPromises);
  assert.equal(h.posts.length, 1);
  assert.match(String(h.toasts.list().at(-1)?.body), /main.*отправлена/);
});

test('CODE-PUSH-FRESH: поздний GET открытия не возвращает старый ahead', async (t) => {
  const h = await mountPendingPush(t);
  const staleRead = deferred();
  const previous = JSON.parse(JSON.stringify(h.wrapper.vm.git));
  const originalGet = globalThis.__codeViewApi.get;

  await h.wrapper.get('button.push-action').trigger('click');
  globalThis.__codeViewApi.get = (url) => url.includes('/git?') ? staleRead.promise : originalGet(url);
  await h.wrapper.setProps({ active: false });
  await h.wrapper.setProps({ active: true });
  await settle(h.flushPromises);
  h.complete();
  await settle(h.flushPromises);
  assert.equal(h.wrapper.vm.git.tracking.ahead, 0);
  staleRead.resolve(previous);
  await settle(h.flushPromises);
  assert.equal(h.wrapper.vm.git.tracking.ahead, 0);
  assert.equal(h.toasts.list().length, 1);
});

test('CODE-PUSH-CONTEXT: результат прежней копии сообщает исход, не меняя новое дерево', async (t) => {
  const h = await mountPendingPush(t);
  const originalGet = globalThis.__codeViewApi.get;
  const nextGit = {
    ...JSON.parse(JSON.stringify(h.wrapper.vm.git)),
    branch: 'linked',
    tracking: {
      detached: false,
      upstream: 'origin/linked',
      ahead: 2,
      behind: 0,
    },
  };

  await h.wrapper.get('button.push-action').trigger('click');
  globalThis.__codeViewApi.get = async (url) => {
    if (url === '/api/code/demo/repos') {
      return {
        repos: [{
          key: 'demo',
          dir: '/demo',
          trees: [mainTree('/demo'), worktree('/linked', 'linked', 'linked')],
        }],
      };
    }
    if (url.includes('/git?') && query(url).get('root') === '/linked') {
      return nextGit;
    }

    return originalGet(url);
  };
  await h.wrapper.setProps({ active: false });
  await h.wrapper.setProps({ active: true });
  await settle(h.flushPromises);
  await h.wrapper.get('#code-context-native').setValue(JSON.stringify(['demo', '/linked']));
  await settle(h.flushPromises);
  assert.equal(h.wrapper.vm.git.tracking.ahead, 2);
  h.complete();
  await settle(h.flushPromises);
  assert.equal(h.wrapper.vm.git.tracking.upstream, 'origin/linked');
  assert.equal(h.wrapper.vm.git.tracking.ahead, 2);
  assert.match(String(h.toasts.list().at(-1)?.body), /main.*отправлена/);
});

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
  assert.equal(wrapper.get('#code-context-native').element.value, JSON.stringify(['demo', '/demo']));
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
    ['fetch-action', 'pull-action', 'push-action'],
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
  assert.equal(diffView(monacoState).modified.content, 'historic\n');

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
  await wrapper.get('#code-context-native').setValue(JSON.stringify(['demo', '/other']));
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
  assert.match(wrapper.get('.diffhead').text(), /индекс → рабочая копия/s);
  assert.equal(wrapper.get('[data-action="diff-view"]').attributes('aria-label'), 'Вид сравнения');
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
  assert.match(styles, /\.ehead \{[^}]*min-height:\s*var\(--code-toolbar-height\)/);
  assert.match(styles, /\.diffhead \{[^}]*min-height:\s*var\(--code-toolbar-height\)/);
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
  const { wrapper, flushPromises, monacoState, browser, toasts } = await mountCodeView(t, { api });
  await selectCodeTab(wrapper, 'changes');
  await settle(flushPromises);

  const models = diffView(monacoState);

  await wrapper.get('textarea').setValue('Моё сообщение');

  await refreshCurrentCode(wrapper, browser, flushPromises);
  assert.equal(diffView(monacoState).original, models.original);
  assert.equal(diffView(monacoState).modified, models.modified);
  assert.equal(models.original.disposed, false);
  assert.equal(models.modified.disposed, false);
  assert.match(wrapper.get('.perr').text(), /git\.staged\[0\]/);

  await wrapper.get('button[data-ui-tooltip="Составить сообщение по staged diff"]').trigger('click');
  await settle(flushPromises);
  assert.equal(wrapper.get('textarea').element.value, 'Моё сообщение');
  assert.match(String(toasts.list().at(-1)?.body), /commitTitle\.title/);
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
  assert.equal(diffView(monacoState).editors.length, 0);

  firstDiff.resolve({
    path: 'app.js', status: 'M', binary: false, tooBig: false,
    oldContent: 'before', newContent: 'after',
  });
  await settle(flushPromises);
  assert.equal(diffView(monacoState).original.content, 'before');
  assert.equal(diffReads, 1);

  await wrapper.get('button.git-file[data-path="app.js"]').trigger('click');
  await settle(flushPromises);
  assert.equal(diffReads, 1, 'повторный выбор использует кеш снимка');

  await refreshCurrentCode(wrapper, browser, flushPromises);
  assert.equal(diffReads, 2);
  assert.equal(diffView(monacoState).modified.content, 'after refresh');
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
  assert.equal(diffView(monacoState).modified.content, 'disk');

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
  assert.equal(diffView(monacoState).modified.content, 'new commits merged');
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
  assert.equal(diffView(monacoState).modified.content, 'new work');
  assert.match(wrapper.get('.ehead').text(), /shared\.js/s);
  assert.match(wrapper.get('.diffhead').text(), /индекс → рабочая копия/s);
});

test('каталог в группе индексируется и возвращается целиком, порциями по потолку сервера', async (t) => {
  const entry = (path, group) => ({ path, status: 'M', add: 1, del: 0, binary: false, group });
  const posts = [];
  const phases = [];
  let accepted = true;
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
    /**
     * Preview возвращает точные пути без мутации, execute принимает подтверждённый состав.
     * Журнал фаз различает сбор всех порций, решение человека и изменение индекса.
     */
    async post(url, body) {
      posts.push({ url, body });

      if (url.includes('/action-preview?')) {
        phases.push(`preview:${body.paths.length}`);

        return {
          token: `directory-${posts.length}`,
          eligible: body.paths.map((path) => ({ path })),
          excluded: [],
        };
      }

      if (url.includes('/stage?') || url.includes('/unstage?')) {
        return { ok: true, changed: body.paths?.length || 0 };
      }

      assert.match(url, /\/action-execute\?/);
      phases.push(`execute:${body.paths.length}`);

      return {
        ok: true,
        completed: body.paths.map((path) => ({ path })),
        failed: [],
        unattempted: [],
      };
    },
  };
  const { wrapper, flushPromises, browser } = await mountCodeView(t, {
    api,
    confirm: async (text) => {
      phases.push('confirm');
      assert.match(text, /\/demo/);

      // Состав подтверждается целиком: в диалоге есть пути из каждой порции,
      // и до решения человека серверу не отправлено ни одного execute.
      const previews = posts.filter((post) => post.url.includes('/action-preview?'));
      const executions = posts.filter((post) => post.url.includes('/action-execute?'));

      assert.equal(executions.length, 0);

      for (const preview of previews) {
        for (const path of preview.body.paths) {
          assert.ok(text.includes(path), `Нет пути ${path} в подтверждении`);
        }
      }

      return accepted;
    },
  });

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
  assert.equal(posts.length, 2);
  assert.match(posts[0].url, /\/action-preview\?/);
  assert.deepEqual(posts[0].body, {
    action: 'stage',
    group: 'work',
    paths: ['src/a.js', 'src/deep/b.js'],
  });
  assert.match(posts[1].url, /\/action-execute\?/);
  assert.deepEqual(posts[1].body, { ...posts[0].body, token: 'directory-1' });
  assert.deepEqual(phases, ['preview:2', 'confirm', 'execute:2']);
  posts.length = 0;
  phases.length = 0;

  const unstageDir = wrapper.get('.git-dir-line[data-dir="lib"][data-group="staged"] [data-action="unstage-dir"]');

  await unstageDir.trigger('click');
  await settle(flushPromises);
  assert.match(posts[0].url, /\/action-preview\?/);
  assert.deepEqual(posts[0].body, {
    action: 'unstage',
    group: 'staged',
    paths: ['lib/x.js'],
  });
  assert.match(posts[1].url, /\/action-execute\?/);
  assert.deepEqual(posts[1].body, { ...posts[0].body, token: 'directory-1' });
  assert.deepEqual(phases, ['preview:1', 'confirm', 'execute:1']);

  // Каталог больше серверного потолка в 500 путей уходит порциями, а не отказом.
  git = {
    ...git,
    files: Array.from({ length: 501 }, (_, index) => entry(`big/f${String(index).padStart(3, '0')}.js`, 'work')),
  };
  await refreshCurrentCode(wrapper, browser, flushPromises);
  posts.length = 0;
  phases.length = 0;
  await wrapper.get('.git-dir-line[data-dir="big"][data-group="work"] [data-action="stage-dir"]').trigger('click');
  await settle(flushPromises, 10);
  assert.deepEqual(phases, ['preview:500', 'preview:1', 'confirm', 'execute:500', 'execute:1']);

  const previews = posts.filter((post) => post.url.includes('/action-preview?'));
  const executions = posts.filter((post) => post.url.includes('/action-execute?'));

  assert.deepEqual(previews.map((post) => post.body.paths.length), [500, 1]);
  assert.deepEqual(previews.flatMap((post) => post.body.paths), git.files.map((file) => file.path));

  for (const [index, execution] of executions.entries()) {
    assert.deepEqual(execution.body, { ...previews[index].body, token: `directory-${index + 1}` });
  }

  // Отмена оставляет только запросы чтения preview: ни старого stage/unstage,
  // ни execute, ни скрытого повтора после закрытия диалога.
  accepted = false;
  posts.length = 0;
  phases.length = 0;
  await wrapper.get('.git-dir-line[data-dir="big"][data-group="work"] [data-action="stage-dir"]')
    .trigger('click');
  await settle(flushPromises, 10);
  assert.deepEqual(phases, ['preview:500', 'preview:1', 'confirm']);
  assert.equal(posts.length, 2);
  assert.ok(posts.every((post) => post.url.includes('/action-preview?')));
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

/**
 * Два дерева содержат одноимённый файл с разным текстом: случайный fallback заметен в Monaco.
 * API переносит только чтение; любой вызов мутации в ходе transfer считается ошибкой теста.
 */
function transferCodeApi({ missingTree = false, missingFile = false } = {}) {
  return {
    /**
     * Отдаёт выбор каталога и разные байты двух рабочих деревьев.
     * Исчезнувшие идентификаторы воспроизводятся ответами того же API.
     */
    async get(url) {
      if(url === '/api/projects') {
        return { projects: [projectFixture('demo', ['/demo']), projectFixture('other', ['/other'])] };
      }
      if(url === '/api/code/demo/repos') {
        return {
          repos: [{

            key: 'demo',

            dir: '/demo',

            trees: [mainTree('/demo'), ...(!missingTree ? [worktree('/work/task', 'task', 'task-1')] : [])],



          }]
        };
      }
      if(url.includes('/ls?')) {
        return { entries: missingFile ? [] : [{ name: 'a.ts', dir: false }] };
      }
      if(url.includes('/file?')) {
        if(missingFile) {
          throw new Error('Файл a.ts не найден');
        }

        return {

          size: 20,

          binary: false,

          tooBig: false,

          content: query(url).get('root') === '/work/task' ? 'WORKTREE\nsecond\nthird' : 'MAIN',



        };
      }
      if(url.includes('/git?')) {
        return {

          branch: 'task-1',

          stat: '',

          tracking: {
            detached: false,
            upstream: '',
            ahead: 0,
            behind: 0


          },

          staged: [{

            path: 'a.ts',
            status: 'M',
            group: 'staged',
            binary: false,
            tooBig: false,

            oldContent: 'HEAD',
            newContent: 'INDEX',
            add: 1,
            del: 1,



          }],

          files: [{

            path: 'a.ts',
            status: 'M',
            group: 'work',
            binary: false,
            tooBig: false,

            oldContent: 'INDEX',
            newContent: 'WORKTREE',
            add: 1,
            del: 1,



          }],

          log: [],



        };
      }

      throw new Error(`Неожиданное чтение transfer: ${url}`);
    },
    async post() {
      assert.fail('Перенос панели не должен выполнять мутацию');
    },
  };
}

test('TW-C01: новый экземпляр и возврат сохраняют project/repo/root/file/line и commit draft', async (t) => {
  const api = transferCodeApi();
  const first = await mountCodeView(t, { api, props: { active: true } });

  await first.wrapper.setProps({
    intents: [{

      id: 1,
      type: 'open-file',
      project: 'demo',
      repo: 'demo',
      root: '/work/task',
      path: 'a.ts',
      line: 3,



    }]
  });
  await settle(first.flushPromises, 10);
  assert.equal(first.monacoState.fileEditors.at(-1).model.content, 'WORKTREE\nsecond\nthird');
  assert.equal(
    typeof first.wrapper.vm.exportState,
    'function',
    'CodePanel ещё не экспортирует состояние окна'
  );
  await selectCodeTab(first.wrapper, 'changes');
  await settle(first.flushPromises);
  await first.wrapper.get('textarea.commit-message').setValue('Точный черновик коммита');
  await selectCodeTab(first.wrapper, 'files');
  await settle(first.flushPromises);

  const state = await first.wrapper.vm.exportState();

  first.wrapper.unmount();

  const second = await mountCodeView(t, { api });

  await second.wrapper.vm.importState(state);
  await settle(second.flushPromises, 10);
  assert.equal(second.wrapper.get('#code-project-native').element.value, 'demo');
  assert.equal(
    second.wrapper.get('#code-context-native').element.value,
    JSON.stringify(['demo', '/work/task']),
  );
  assert.equal(second.wrapper.get('.ehead .epath').text(), 'a.ts');
  assert.equal(second.monacoState.fileEditors.at(-1).model.content, 'WORKTREE\nsecond\nthird');
  assert.equal(second.monacoState.fileEditors.at(-1).position.lineNumber, 3);
  await selectCodeTab(second.wrapper, 'changes');
  await settle(second.flushPromises);
  assert.equal(second.wrapper.get('textarea.commit-message').element.value, 'Точный черновик коммита');

  const returning = await second.wrapper.vm.exportState();

  second.wrapper.unmount();

  const third = await mountCodeView(t, { api });

  await third.wrapper.vm.importState(returning);
  await settle(third.flushPromises, 10);
  assert.equal(
    third.wrapper.get('#code-context-native').element.value,
    JSON.stringify(['demo', '/work/task']),
  );
  assert.equal(third.wrapper.get('textarea.commit-message').element.value, 'Точный черновик коммита');
});

test('TW-C02: transfer сохраняет staged gitRef; пропавшие tree/file дают именованную ошибку', async (t) => {
  const first = await mountCodeView(t, { api: transferCodeApi() });

  await selectCodeTab(first.wrapper, 'changes');
  await settle(first.flushPromises);
  assert.equal(typeof first.wrapper.vm.exportState, 'function', 'Нет snapshot выбранной стороны git');

  const staged = first.wrapper.find('button.git-file[data-group="staged"][data-path="a.ts"]');

  assert.ok(staged.exists(), 'Фикстура показывает staged-сторону');
  await staged.trigger('click');
  await settle(first.flushPromises);

  const state = await first.wrapper.vm.exportState();

  first.wrapper.unmount();

  const second = await mountCodeView(t, { api: transferCodeApi() });

  await second.wrapper.vm.importState(state);
  await settle(second.flushPromises);
  assert.equal(diffView(second.monacoState).modified.content, 'INDEX');
  second.wrapper.unmount();

  for(const missing of ['missingTree', 'missingFile']) {
    const panel = await mountCodeView(t, { api: transferCodeApi({ [missing]: true }) });

    await panel.wrapper.vm.importState({
      ...state,
      root: '/work/task',
      tab: 'files',
      file: 'a.ts',
      line: 3


    });
    await settle(panel.flushPromises, 10);
    assert.match(panel.wrapper.text(), missing === 'missingTree' ? /\/work\/task/ : /a\.ts/);
    assert.ok(panel.wrapper.find('.perr').exists());
    assert.equal(panel.monacoState.fileEditors.some((editor) => editor.model?.content === 'MAIN'), false);
    panel.wrapper.unmount();
  }
});

for (const event of ['projects-changed', 'hello']) {
  test(`PD-code-catalog: ${event} сбрасывает удалённый контекст и отбрасывает поздний GET`, async (t) => {
    let removed = false;
    const slow = deferred();
    let repoCalls = 0;
    const { wrapper, flushPromises } = await mountCodeView(t, {
      api: {
        get: async (url) => {
          if (url === '/api/projects') {
            return {
              projects: removed ? [projectFixture('other', ['/other'])]
                : [projectFixture('demo', ['/demo']), projectFixture('other', ['/other'])]
            };
          }
          if (url.endsWith('/repos')) {
            repoCalls += 1;

            if (repoCalls === 2) {
              return slow.promise;
            }

            return {
              repos: [{
                key: 'demo',
                dir: '/demo',
                trees: [mainTree('/demo')]
              }]
            };
          }
          if (url.includes('/git?')) {
            return {
              branch: 'main',
              files: [],
              staged: [],
              hasStaged: false
            };
          }
          if (url.includes('/ls?')) {
            return { entries: [] };
          }

          throw new Error(`Неожиданный GET ${url}`);
        },
      },
      storage: { 'grigdesk-project': 'demo' },
    });

    assert.equal(wrapper.get('#code-context-native').element.value.includes('demo'), true);
    globalThis.__codeViewSse('hello', null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    removed = true;
    globalThis.__codeViewSse(event, {
      id: 'demo',
      revision: 4,
      kind: 'deleted'
    });
    await settle(flushPromises);
    slow.resolve({
      repos: [{
        key: 'demo',
        dir: '/demo',
        trees: [mainTree('/demo')]
      }]
    });
    await settle(flushPromises);

    const hasDeleted = wrapper.findAll('#code-context-native option')
      .some((item) => item.attributes('value').includes('demo'));

    assert.equal(hasDeleted,
      false);

    const context = wrapper.find('#code-context-native');

    assert.equal(context.exists() ? context.element.value : '', '');
  });
}

test('LOAD-KEEP-inline-code: рабочая копия и поиск сохраняют маленький spinner', async (t) => {
    const repos = deferred();
    const search = deferred();
    const calls = [];
    let listings = 0;
    const h = await mountCodeView(t, {
        api: {
            /**
             * Удерживает смену рабочей копии и последующий поиск независимо друг от друга.
             * Остальные адреса явно проверяются, неизвестный запрос отвергает фикстуру.
             */
            async get(url) {
                calls.push(url);

                if (url === '/api/projects') {
                    return {
                        projects: [projectFixture('demo', ['/demo'])]
                    };
                }
                if (url === '/api/code/demo/repos') {
                    return {
                        repos: [{
                                key: 'demo',
                          dir: '/demo',
                          trees: [
                                    mainTree('/demo'), worktree('/demo-other', 'Вторая копия', 'fixture'),
                                ]
                            }]
                    };
                }
                if (url.includes('/ls?')) {
                    listings += 1;

                    return listings === 1 ? {
                        entries: []
                    } : repos.promise;
                }
                if (url.includes('/search?')) {
                    return search.promise;
                }

                throw new Error(`Неожиданный API Кода: ${url}`);
            },
        }
    });
    const options = h.wrapper.get('#code-context-native').findAll('option');

    await h.wrapper.get('#code-context-native').setValue(options[1].attributes('value'));
    await settle(h.flushPromises);
    assert.equal(h.wrapper.find('[data-variant="inline"] .ui-spinner').exists(), true);
    assert.equal(h.wrapper.find('[data-ui-skeleton]').exists(), false);
    repos.resolve({
        entries: []
    });
    await settle(h.flushPromises);

    const panel = h.wrapper.get('#code-navigator').element;

    await h.wrapper.get('input[data-action="code-search"]').setValue('needle');
    await new Promise((resolve) => setTimeout(resolve, 340));
    assert.ok(calls.some((url) => url.includes('/search?')), 'поиск начался');
    await settle(h.flushPromises);
    assert.equal(h.wrapper.find('.code-search-results [data-variant="inline"] .ui-spinner').exists(), true);
    assert.equal(h.wrapper.find('[data-ui-skeleton]').exists(), false);
    assert.ok(h.wrapper.get('#code-navigator').element === panel);
    search.resolve({
        files: [],
      matches: [],
      truncated: false
    });
    await settle(h.flushPromises);
    assert.equal(h.wrapper.find('[data-ui-loading]').exists(), false);
});

for (const area of ['history', 'git', 'commits']) {
  test(`LOAD-SURFACE-code-${area}: настоящее вложенное ожидание объявлено и снимается`, async (t) => {
    const h = await mountCodeView(t, { api: {
      /**
       * Подтверждает контекст настоящей рабочей копии до вложенного ожидания.
       * Любой неописанный адрес отклоняется, чтобы ошибка порта не стала RED.
       */
      async get(url) {
        if (url === '/api/projects') {
          return { projects: [projectFixture('demo', ['/demo'])] };
        }

        if (url === '/api/code/demo/repos') {
          return { repos: [{
            key: 'demo',
            dir: '/demo',
            trees: [mainTree('/demo')]
          }] };
        }

        if (url.includes('/ls?')) {
          return { entries: [] };
        }

        if (url.includes('/git?')) {
          return {
            branch: 'main',
            files: [],
            staged: [],
            log: [],
            stat: '',
            headMessage: ''
          };
        }

        assert.fail(`Неожиданный API: ${url}`);
      },
    } });

    if (area === 'history') {
      h.wrapper.vm.fileHistoryOrigin = { path: 'fixture.txt' };
      h.wrapper.vm.fileHistoryLoading = true;
    } else {
      await selectCodeTab(h.wrapper, area === 'git' ? 'changes' : 'commits');
      await settle(h.flushPromises);

      if (area === 'git') {
        h.wrapper.vm.git = null;
        h.wrapper.vm.gitLoading = true;
      } else {
        h.wrapper.vm.git = {
          branch: 'main',
          files: [],
          staged: [],
          log: [],
          stat: '',
          tracking: {
            detached: false,
            upstream: '',
            ahead: 0,
            behind: 0
          }
        };
        await settle(h.flushPromises);
        h.wrapper.vm.gitPane = 'commits';
        h.wrapper.vm.commitsLoading = true;
      }
    }

    await h.wrapper.vm.$nextTick();

    const scope = h.wrapper.get(area === 'history' ? '.file-history' : '.git-tree');
    const bricks = scope.findAll('[data-ui-skeleton]').length;
    const announced = scope.find('[role="status"]').exists();

    h.wrapper.vm.fileHistoryLoading = false;
    h.wrapper.vm.gitLoading = false;
    h.wrapper.vm.commitsLoading = false;
    await h.wrapper.vm.$nextTick();
    assert.equal(scope.find('[data-ui-loading]').exists(), false);
    assert.ok(announced, 'вложенное ожидание объявлено');
    assert.ok(bricks > 0, `${area}: общий каркас списка вместо одинаковой заглушки`);
  });
}

test('PH-CODE: phone отдаёт контексту ряд и сохраняет подписи', async (t) => {
  const api = {
    /**
     * Фикстура отдаёт существующие DTO только для чтений шапки и рабочей копии.
     * Неожиданный запрос показывает отклонение сценария вместо скрытого пустого ответа.
     */
    async get(url) {
      if (url === '/api/projects') {
        return { projects: [projectFixture('пример', ['/work/repo'])] };
      }
      if (url.includes('/repos')) {
        return { repos: [{
          key: 'repo',
          dir: '/work/repo',
          trees: [mainTree('/work/repo')],
          error: '',
        }] };
      }
      if (url.includes('/ls')) {
        return { entries: [] };
      }
      if (url.includes('/git')) {
        return {
          branch: 'main',
          files: [],
          staged: [],
          unstaged: [],
        };
      }

      throw new Error(`unexpected GET ${url}`);
    },
  };
  const { wrapper, browser, flushPromises } = await mountCodeView(t, { api });

  await settle(flushPromises);

  const source = await readFile(VIEW_PATH, 'utf8');
  const style = browser.document.createElement('style');
  const cssText = source.match(/<style scoped>([\s\S]*?)<\/style>/u)[1];

  style.textContent = cssText;
  browser.document.head.append(style);
  t.after(() => style.remove());
  browser.happyDOM.setWindowSize({ width: 390, height: 844 });
  style.textContent = cssText;

  const context = wrapper.get('.head-ctx').element;
  const projectLabel = wrapper.get('label[for="code-project"]').element;

  assert.equal(browser.getComputedStyle(context).flexBasis, '100%');
  assert.equal(browser.getComputedStyle(context).flexDirection, 'column');
  assert.equal(browser.getComputedStyle(projectLabel).display, 'block');
  assert.equal(browser.getComputedStyle(wrapper.get('.head-pick').element).display, 'grid');
  assert.equal(browser.getComputedStyle(context).gap, '4px');
  assert.equal(wrapper.get('#code-project-native').element.value, 'пример');
  assert.match(wrapper.get('#code-context-native').element.value, /repo/u);

  browser.happyDOM.setWindowSize({ width: 1280, height: 900 });
  style.textContent = cssText;
  assert.notEqual(browser.getComputedStyle(context).flexBasis, '100%');
});
/**
 * Все review-сценарии читают стороны из одного HTTP-fixture, включая fingerprint.
 * Модель diff не подменяется: Monaco только записывает полученные диапазоны и геометрию.
 */
async function mountReviewPanel(t, { files, staged = [], storage = {}, props = {}, confirm,
  post, conflict, patch, repos = null } = {}) {
  const unchanged = Array.from({ length: 120 }, (_, index) => `line ${index + 1}`);
  const modified = [...unchanged];

  modified[4] = 'color';
  modified[109] = 'second change';

  const entries = files || ['a.txt', 'b.txt', 'c.txt'].map((file) => ({
    path: file,
    status: 'M',
    add: 2,
    del: 2,
    binary: false,
    oldContent: unchanged.join('\n'),
    newContent: modified.join('\n'),
  }));
  const snapshot = {
    branch: 'main',
    stat: '',
    files: entries,
    staged,
    log: [],
    headMessage: '',
    tracking: {
      detached: false,
      upstream: '',
      ahead: 0,
      behind: 0,
    },
  };
  const requests = [];
  const sessions = [];
  const fingerprint = (file) => createHash('sha256')
    .update(JSON.stringify([file.path, file.oldContent, file.newContent])).digest('hex');
  const api = {
    /**
     * Стороны и их fingerprints происходят из одного изменяемого Git-снимка fixture.
     * Исторический descriptor сохраняется в query; чтения не исполняют мутации.
     */
    async get(url) {
      requests.push({ method: 'GET', url });

      if (url === '/api/projects') {
        return { projects: [projectFixture('demo', ['/demo'])] };
      }

      if (url === '/api/code/demo/repos') {
        return { repos: repos || [{
          key: 'demo',
          dir: '/demo',
          trees: [mainTree('/demo')],
        }] };
      }

      if (url.includes('/ls?')) {
        return { entries: [] };
      }

      if (url.includes('/git?')) {
        return snapshot;
      }

      if (url.includes('/commits-diff?')) {
        const params = query(url);

        return {
          branch: 'main',
          stat: '',
          files: snapshot.files,
          range: {
            from: params.get('from') || 'c'.repeat(40),
            to: params.get('to') || 'c'.repeat(40),
            base: params.get('from') === 'a'.repeat(40) ? '9'.repeat(40) : 'b'.repeat(40),
            commits: 1,
            work: params.get('work') === '1',
          },
        };
      }

      if (url.includes('/file-diff?')) {
        const params = query(url);
        const group = params.get('group') === 'staged' ? snapshot.staged : snapshot.files;
        const file = group.find((entry) => entry.path === params.get('path'));

        assert.ok(file, `Неизвестный путь fixture: ${params.get('path')}`);

        return {
          ...file,
          tooBig: false,
          fingerprint: fingerprint(file),
        };
      }

      if (url.includes('/conflict?') && conflict) {
        return conflict(query(url).get('path'));
      }

      if (url.includes('/patch?') && patch) {
        return patch(url);
      }

      if (url.includes('/partial-diff?')) {
        const params = query(url);
        const group = params.get('group') === 'staged' ? snapshot.staged : snapshot.files;
        const file = group.find((entry) => entry.path === params.get('path'));

        assert.ok(file, 'Частичное сравнение относится к показанному файлу');

        return {
          group: params.get('group') || 'work',
          path: file.path,
          fingerprint: fingerprint(file),
          token: 'raw-token',
          patch: '@@ -3,2 +3,2 @@\n-c\n-d\n+C\n+D\n',
          hunks: [{
            id: 'hunk-1',
            oldStart: 3,
            newStart: 3,
            atoms: [
              {
                id: 'raw-C',
                oldLine: 3,
                newLine: 3,
                oldText: 'c\n',
                newText: 'C\n',
              },
              {
                id: 'raw-D',
                oldLine: 4,
                newLine: 4,
                oldText: 'd\n',
                newText: 'D\n',
              },
            ],
          }],
        };
      }

      throw new Error(`Неожиданный GET ${url}`);
    },
    /**
     * Перепроверка viewed возвращает только hash и descriptor, не содержимое сторон.
     * Остальные POST обслуживаются явным сценарием конкретного теста.
     */
    async post(url, payload) {
      requests.push({
        method: 'POST',
        url,
        payload,
      });

      if (url.includes('/review-fingerprints?')) {
        return { comparisons: payload.comparisons.map((comparison) => {
          const group = comparison.group === 'staged' ? snapshot.staged : snapshot.files;
          const file = group.find((entry) => entry.path === comparison.path);

          return { ...comparison, fingerprint: file ? fingerprint(file) : null };
        }) };
      }

      if (post) {
        return post(url, payload);
      }

      throw new Error(`Неожиданный POST ${url}`);
    },
  };
  const mounted = await mountCodeView(t, {
    api,
    storage,
    props,
    confirm,
    chat: { newSession: (options) => {
      sessions.push(options);

      return 'review-chat';
    } },
  });

  await selectCodeTab(mounted.wrapper, 'changes');
  await settle(mounted.flushPromises, 8);

  return {
    ...mounted,
    snapshot,
    requests,
    sessions,
    fingerprint,
  };
}

/**
 * Отсутствующий новый control должен дать короткий assertion, без сериализации DOM.
 * После появления control тест продолжает проверять его действие на редактор или HTTP.
 */
function reviewControl(wrapper, action) {
  const control = wrapper.find(`[data-action="${action}"]`);

  if (control.exists()) {
    return control;
  }

  const teleported = wrapper.element.ownerDocument.querySelector(`[data-action="${action}"]`);

  assert.ok(teleported, `Отсутствует control ${action}`);

  return new CodeViewDomWrapper(teleported);
}

test('CODE-RESIZE: события отрисовки Monaco не перестраивают зоны синхронно', async (t) => {
  const h = await mountReviewPanel(t);
  const editors = reviewEditors(h);
  let insideMonacoRender = true;
  let updates = 0;

  for (const editor of editors) {
    const changeZones = editor.changeViewZones.bind(editor);

    editor.changeViewZones = (callback) => {
      assert.equal(insideMonacoRender, false, 'снимок whitespace ещё используется Monaco');
      updates += 1;
      changeZones(callback);
    };

    for (const listener of [...editor.layoutListeners, ...editor.contentSizeListeners]) {
      listener();
    }
  }

  assert.equal(updates, 0);
  insideMonacoRender = false;
  await settle(h.flushPromises);
  assert.ok(updates > 0, 'зоны выровнены после завершения отрисовки Monaco');
});

test('CODE-LAYOUT: фильтры и групповые команды появляются по контексту', async (t) => {
  const h = await mountReviewPanel(t);
  const filters = h.wrapper.get('#code-status-filter');
  const selection = h.wrapper.get('.git-selection-tools');

  assert.equal(filters.isVisible(), false);
  assert.equal(selection.isVisible(), false);
  assert.equal(h.wrapper.get('.git-filter-summary').isVisible(), false);
  await reviewControl(h.wrapper, 'git-filter-toggle').trigger('click');
  assert.equal(filters.isVisible(), true);
  await reviewControl(h.wrapper, 'git-filter-status').setValue('M');
  await reviewControl(h.wrapper, 'git-filter-toggle').trigger('click');
  assert.equal(filters.isVisible(), true, 'активный статус остаётся доступен после закрытия фильтра');
  await reviewControl(h.wrapper, 'git-filter-path').setValue('missing-file');
  assert.match(h.wrapper.get('[role="status"]').text(), /Нет файлов/);
  await reviewControl(h.wrapper, 'git-filter-clear').trigger('click');
  assert.equal(filters.isVisible(), false);
  await h.wrapper.get('button.git-file[data-path="a.txt"]').trigger('click', { ctrlKey: true });
  assert.equal(selection.isVisible(), true);
  assert.match(reviewControl(h.wrapper, 'git-selection-count').text(), /Выбрано: 1/);
  await reviewControl(h.wrapper, 'git-selection-clear').trigger('click');
  assert.equal(selection.isVisible(), false);
  assert.equal(h.wrapper.get('.ehead .epath').text(), 'a.txt');
});

test('CODE-LAYOUT: меню выбирает блок, быстрый список заменяет скрытое дерево', async (t) => {
  const h = await mountReviewPanel(t);

  assert.equal(h.browser.document.querySelector('[data-action="select-diff-hunk"]') === null, true);
  assert.equal(h.wrapper.find('[data-action="diff-file-list"]').exists(), false);
  await clickReviewMenuAction(h, 'select-diff-hunk');
  assert.equal(h.browser.document.querySelector('[data-action="select-diff-hunk"]') === null, true);
  assert.ok(reviewEditors(h).some((editor) => editor.getSelection()?.startLineNumber === 5));
  await h.wrapper.get('button.navigator-toggle').trigger('click');
  await reviewControl(h.wrapper, 'diff-file-list').setValue('work:b.txt');
  await settle(h.flushPromises);
  assert.equal(h.wrapper.get('.ehead .epath').text(), 'b.txt');
  await h.wrapper.get('button.navigator-toggle').trigger('click');
  assert.equal(h.wrapper.find('[data-action="diff-file-list"]').exists(), false);
  assert.equal(h.wrapper.get('button.git-file[data-path="b.txt"]').attributes('aria-pressed'), 'true');
});

/**
 * Открывает настоящее меню действий перед выбором команды, как при работе мышью.
 * После закрытия popover следующий вызов снова проходит через его кнопку.
 */
async function clickReviewMenuAction(h, action, trigger = 'review-tools') {
  const selector = `[data-action="${action}"]`;

  if (!h.browser.document.querySelector(selector)) {
    await reviewControl(h.wrapper, trigger).trigger('click');
    await settle(h.flushPromises);
  }

  await reviewControl(h.wrapper, action).trigger('click');
  await settle(h.flushPromises);
}

/**
 * Настройки могут быть телепортированы общим popover за пределы wrapper.
 * Меняем настоящий native select/switch и посылаем тот же change, что делает браузер.
 */
async function reviewSetting(h, action, value) {
  let input = h.browser.document.querySelector(`[data-action="${action}"]`);

  if (!input) {
    await reviewControl(h.wrapper, 'diff-view').trigger('click');
    await settle(h.flushPromises);
    input = h.browser.document.querySelector(`[data-action="${action}"]`);
  }

  assert.ok(input, `Отсутствует настройка ${action}`);

  if (input.type === 'checkbox') {
    input.checked = value;
  } else {
    input.value = String(value);
  }

  input.dispatchEvent(new h.browser.Event('change', { bubbles: true }));
  await settle(h.flushPromises, 8);
}

const reviewEditors = (h) => [...h.monacoState.fileEditors, ...h.monacoState.sideEditors]
  .filter((editor) => !editor.disposed && editor.model);
const reviewDecorations = (h) => h.monacoState.decorationCollections
  .flatMap((collection) => collection.decorations);

test('CODE-VIEW-CONTEXT: 3/10/all и collapse меняют скрытые исходные строки', async (t) => {
  const h = await mountReviewPanel(t);

  await reviewSetting(h, 'diff-context', '3');

  const hidden3 = reviewEditors(h).flatMap((editor) => editor.hiddenAreas);

  assert.ok(hidden3.some((range) => range.endLineNumber - range.startLineNumber > 50));
  await reviewSetting(h, 'diff-context', '10');

  const hidden10 = reviewEditors(h).flatMap((editor) => editor.hiddenAreas);
  const size = (ranges) => ranges.reduce(
    (sum, range) => sum + range.endLineNumber - range.startLineNumber, 0,
  );

  assert.ok(size(hidden10) < size(hidden3));
  await reviewSetting(h, 'diff-context', 'all');
  assert.equal(reviewEditors(h).flatMap((editor) => editor.hiddenAreas).length, 0);
  await reviewSetting(h, 'diff-context', '3');
  await reviewSetting(h, 'diff-collapse', false);
  assert.equal(reviewEditors(h).flatMap((editor) => editor.hiddenAreas).length, 0);
});

test('CODE-VIEW-DETAIL: color→colour даёт строку, слово и ровно u', async (t) => {
  const h = await mountReviewPanel(t, { files: [{
    path: 'a.txt',
    status: 'M',
    add: 1,
    del: 1,
    binary: false,
    oldContent: 'color\n',
    newContent: 'colour\n',
  }] });

  await reviewSetting(h, 'diff-detail', 'line');
  assert.ok(reviewDecorations(h).some((item) => item.options.isWholeLine));
  await reviewSetting(h, 'diff-detail', 'word');
  assert.ok(reviewDecorations(h).some((item) => item.range.startColumn === 1 && item.range.endColumn === 7));
  await reviewSetting(h, 'diff-detail', 'char');
  assert.ok(reviewDecorations(h).some((item) => item.range.startColumn === 5 && item.range.endColumn === 6));
  assert.ok(h.monacoState.models.some((model) => model.content === 'colour\n'));
});

test('CODE-VIEW-WS: trim и ignore-all меняют hunks, сырые модели прежние', async (t) => {
  const h = await mountReviewPanel(t, { files: [{
    path: 'a.txt',
    status: 'M',
    add: 4,
    del: 3,
    binary: false,
    oldContent: ' a \nx y\nz\n',
    newContent: 'a\nx\ty\n\nz\n',
  }] });

  await reviewSetting(h, 'diff-whitespace-mode', 'all');

  const all = reviewControl(h.wrapper, 'hunk-position').text();

  assert.doesNotMatch(all, /0\s*\/\s*0/);
  await reviewSetting(h, 'diff-whitespace-mode', 'trim');
  assert.doesNotMatch(reviewControl(h.wrapper, 'hunk-position').text(), /0\s*\/\s*0/);
  await reviewSetting(h, 'diff-whitespace-mode', 'ignore-all');
  assert.match(reviewControl(h.wrapper, 'hunk-position').text(), /0\s*\/\s*0/);
  assert.ok(h.monacoState.models.some((model) => model.content === 'a\nx\ty\n\nz\n'));
});

test('CODE-VIEW-RENDER/PREFS: glyph/wrap обеих сторон, reload и narrow не теряют выбор', async (t) => {
  const resize = installResizeObserver(t);
  const h = await mountReviewPanel(t);

  await reviewSetting(h, 'diff-render-whitespace', true);
  await reviewSetting(h, 'diff-wrap', true);

  const editors = reviewEditors(h);

  assert.equal(editors.length, 2);
  assert.ok(editors.every((editor) => editor.options.renderWhitespace === 'all'));
  assert.ok(editors.every((editor) => editor.options.wordWrap === 'on'));
  resize.resize(h.wrapper.get('.lay').element, 360);
  await settle(h.flushPromises);
  resize.resize(h.wrapper.get('.lay').element, 1200);
  await settle(h.flushPromises);

  const storage = Object.fromEntries(Array.from({ length: h.browser.localStorage.length }, (_, index) => {
    const key = h.browser.localStorage.key(index);

    return [key, h.browser.localStorage.getItem(key)];
  }));

  h.wrapper.unmount();

  const restored = await mountReviewPanel(t, { storage });

  assert.ok(reviewEditors(restored).every((editor) => editor.options.renderWhitespace === 'all'));
  assert.ok(reviewEditors(restored).every((editor) => editor.options.wordWrap === 'on'));
});

for (const sync of [false, true]) {
  for (const align of [false, true]) {
    test(`CODE-VIEW-SCROLL: sync=${sync}, align=${align} независимы`, async (t) => {
      const h = await mountReviewPanel(t, { files: [{
        path: 'a.txt',
        status: 'M',
        add: 2,
        del: 0,
        binary: false,
        oldContent: 'one\ntwo\nthree\n',
        newContent: 'one\nnew\nextra\ntwo\nthree\n',
      }] });

      await reviewSetting(h, 'diff-sync-scroll', sync);
      await reviewSetting(h, 'diff-align', align);

      const [left, right] = reviewEditors(h);

      assert.ok(left && right);
      left.setScrollTop(100);
      await settle(h.flushPromises);
      assert.equal(right.scrollTop > 0, sync);
      assert.equal(left.zones.size + right.zones.size > 0, align);
    });
  }
}

test('CODE-VIEW-OVERVIEW: два блока имеют обзорную разметку и выравнивающие зоны', async (t) => {
  const oldLines = Array.from({ length: 120 }, (_, index) => `line ${index + 1}`);
  const newLines = [...oldLines];

  newLines[4] = 'changed';
  newLines.splice(109, 0, 'inserted', 'extra');

  const h = await mountReviewPanel(t, { files: [{
    path: 'a.txt',
    status: 'M',
    add: 3,
    del: 1,
    binary: false,
    oldContent: oldLines.join('\n'),
    newContent: newLines.join('\n'),
  }] });

  await reviewSetting(h, 'diff-align', true);

  const editors = reviewEditors(h);
  const overview = reviewDecorations(h).filter((item) => item.options.overviewRuler);

  assert.equal(editors.length, 2);
  assert.ok(editors.every((editor) => editor.options.overviewRulerLanes > 0));
  assert.ok(overview.some((item) => item.range.startLineNumber === 5));
  assert.ok(overview.some((item) => item.range.startLineNumber === 110));
  assert.ok(editors.some((editor) => editor.zones.size > 0));
});

test('CODE-NAV-HUNKS: F7/Shift+F7 продолжают блоки в соседнем файле', async (t) => {
  const h = await mountReviewPanel(t);
  const [a, b] = h.snapshot.files;

  b.oldContent = b.oldContent.replace('line 5', 'before b');
  b.newContent = b.newContent.replace('color', 'after b');

  assert.match(reviewControl(h.wrapper, 'hunk-position').text(), /1\s*\/\s*2/);
  await h.wrapper.trigger('keydown', { key: 'F7' });
  await settle(h.flushPromises);
  assert.match(reviewControl(h.wrapper, 'hunk-position').text(), /2\s*\/\s*2/);
  await h.wrapper.trigger('keydown', { key: 'F7' });
  await settle(h.flushPromises);
  assert.equal(h.requests.filter((request) => request.url.includes('/file-diff?')).at(-1)
    .url.includes('path=b.txt'), true);
  assert.match(reviewControl(h.wrapper, 'hunk-position').text(), /1\s*\/\s*2/);
  assert.equal(h.wrapper.get('.ehead .epath').text(), b.path);
  assert.equal(diffView(h.monacoState).original.content, b.oldContent);
  assert.equal(diffView(h.monacoState).modified.content, b.newContent);
  assert.equal(diffView(h.monacoState).editors.at(-1).revealed.at(-1), 5);

  const readsBeforeBack = h.requests.filter((request) => request.url.includes('/file-diff?')).length;

  await h.wrapper.trigger('keydown', { key: 'F7', shiftKey: true });
  await settle(h.flushPromises);
  assert.match(reviewControl(h.wrapper, 'hunk-position').text(), /2\s*\/\s*2/);
  assert.equal(h.wrapper.get('.ehead .epath').text(), a.path);
  assert.equal(h.wrapper.get('button.git-file[data-group="work"][data-path="a.txt"]').classes()
    .includes('sel'), true);
  assert.match(h.wrapper.get('.diffhead').text(), /индекс → рабочая копия/);
  assert.equal(diffView(h.monacoState).original.content, a.oldContent);
  assert.equal(diffView(h.monacoState).modified.content, a.newContent);
  assert.equal(diffView(h.monacoState).editors.at(-1).revealed.at(-1), 110);
  assert.equal(h.requests.filter((request) => request.url.includes('/file-diff?')).length,
    readsBeforeBack, 'возврат к прочитанным сторонам сохраняет lazy-cache');
});

test('CODE-NAV-HUNKS: скрытое дерево оставляет быстрый список и отдельные file arrows', async (t) => {
  const h = await mountReviewPanel(t);

  await h.wrapper.get('button.navigator-toggle').trigger('click');
  await reviewControl(h.wrapper, 'diff-file-list').setValue('work:b.txt');
  await settle(h.flushPromises);

  const request = h.requests.filter((entry) => entry.url.includes('/file-diff?')).at(-1);

  assert.equal(query(request.url).get('group'), 'work');
  assert.equal(query(request.url).get('path'), 'b.txt');
  assert.equal(h.wrapper.find('button[aria-label="Следующий файл"]').exists(), true);
  assert.equal(h.wrapper.find('button[aria-label="Предыдущий файл"]').exists(), true);
});

test('CODE-VIEWED-PROGRESS/STALE: 1/3, next, refresh и same-count edit', async (t) => {
  const h = await mountReviewPanel(t);

  await reviewControl(h.wrapper, 'mark-viewed').trigger('click');
  assert.match(reviewControl(h.wrapper, 'review-progress').text(), /1\s*\/\s*3/);
  assert.equal(h.wrapper.find('[data-path="a.txt"][data-viewed="true"]').exists(), true);
  await reviewControl(h.wrapper, 'next-unreviewed').trigger('click');
  await settle(h.flushPromises);
  assert.equal(query(h.requests.filter((entry) => entry.url.includes('/file-diff?')).at(-1).url)
    .get('path'), 'b.txt');
  await reviewControl(h.wrapper, 'mark-viewed').trigger('click');
  await refreshCurrentCode(h.wrapper, h.browser, h.flushPromises);
  assert.match(reviewControl(h.wrapper, 'review-progress').text(), /2\s*\/\s*3/);
  h.snapshot.files[0].newContent = h.snapshot.files[0].newContent.replace('color', 'other');
  await refreshCurrentCode(h.wrapper, h.browser, h.flushPromises);
  assert.match(reviewControl(h.wrapper, 'review-progress').text(), /1\s*\/\s*3/);
  assert.equal(h.wrapper.find('[data-path="a.txt"][data-viewed="true"]').exists(), false);
  assert.equal(h.wrapper.find('[data-path="b.txt"][data-viewed="true"]').exists(), true);

  const reads = h.requests.filter((entry) => entry.url.includes('/file-diff?'));

  assert.equal(reads.some((entry) => query(entry.url).get('path') === 'c.txt'), false);
});

test('CODE-VIEWED-SCOPE: staged и work одного пути имеют разные отметки', async (t) => {
  const entry = {
    path: 'same.txt',
    status: 'M',
    add: 1,
    del: 1,
    binary: false,
    oldContent: 'head\n',
    newContent: 'index\n',
  };
  const h = await mountReviewPanel(t, { staged: [entry], files: [{
    ...entry,
    oldContent: 'index\n',
    newContent: 'work\n',
  }] });

  await h.wrapper.get('button.git-file[data-group="work"][data-path="same.txt"]').trigger('click');
  await settle(h.flushPromises);
  await reviewControl(h.wrapper, 'mark-viewed').trigger('click');

  const workRow = h.wrapper.find('[data-group="work"][data-path="same.txt"][data-viewed="true"]');

  assert.equal(workRow.exists(), true);

  const stagedRow = h.wrapper.find('[data-group="staged"][data-path="same.txt"][data-viewed="true"]');

  assert.equal(stagedRow.exists(), false);
  assert.match(reviewControl(h.wrapper, 'review-progress').text(), /1\s*\/\s*2/);
});

test('CODE-VIEWED-STORAGE-ERROR: отказ storage оставляет панель и стороны рабочими', async (t) => {
  const h = await mountReviewPanel(t);
  const storage = h.browser.localStorage;
  const original = globalThis.localStorage;
  let attempts = 0;
  let marking = true;

  // Happy DOM связывает методы при первом чтении: оборачиваем публичный storage,
  // чтобы вызов приложения гарантированно прошёл через отказ, а не кеш binding.
  const failingStorage = new Proxy(storage, {
    get(target, property) {
      if (property !== 'setItem') {
        return Reflect.get(target, property, target);
      }

      return (key, value) => {
        if (marking && key === 'grigdesk-code-review-v1') {
          attempts += 1;

          throw new h.browser.DOMException('Квота', 'QuotaExceededError');
        }

        return target.setItem(key, value);
      };
    },
  });

  globalThis.localStorage = failingStorage;
  t.after(() => {
    if (globalThis.localStorage === failingStorage) {
      globalThis.localStorage = original;
    }
  });

  const mark = h.wrapper.find('[data-action="mark-viewed"]');
  const models = h.monacoState.models.filter((model) => !model.disposed);

  if (mark.exists()) {
    await mark.trigger('click');
    await settle(h.flushPromises);
    assert.ok(attempts > 0, 'Попытка сохранить viewed действительно дошла до storage');
  }

  marking = false;
  globalThis.localStorage = original;

  assert.equal(h.wrapper.find('[data-viewed="true"]').exists(), false);
  assert.ok(models.every((model) => !model.disposed));
  await h.wrapper.get('button.git-file[data-path="b.txt"]').trigger('click');
  await settle(h.flushPromises);
  assert.ok(h.requests.some((entry) => entry.url.includes('/file-diff?')
    && query(entry.url).get('path') === 'b.txt'));
  assert.equal(h.wrapper.find('.diff-error').exists(), false);

  const filter = h.wrapper.find('[data-action="git-filter-path"]');

  if (filter.exists()) {
    await filter.setValue('b.txt');
    await settle(h.flushPromises);
    assert.equal(h.wrapper.findAll('button.git-file').length, 1);
  }

  const retained = {};

  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);

    retained[key] = storage.getItem(key);
  }

  h.wrapper.unmount();

  const reloaded = await mountReviewPanel(t, { storage: retained });

  assert.equal(reloaded.wrapper.find('[data-viewed="true"]').exists(), false);
  assert.equal(reloaded.wrapper.find('button.git-file[data-path="b.txt"]').exists(), true);
});

/**
 * Выбирает исходные строки активной стороны через публичную Monaco selection.
 * Изменение выделения не заменяет ни одной строки модели и не пишет файл.
 */
function selectReviewLines(h, side, from, to = from) {
  const editors = reviewEditors(h);
  const editor = editors[side === 'old' ? 0 : 1];

  assert.ok(editor, `Нет редактора стороны ${side}`);
  editor.setSelection({
    startLineNumber: from,
    endLineNumber: to,
    startColumn: 1,
    endColumn: editor.model.getLineMaxColumn(to),
  });
  editor.setPosition({ lineNumber: from, column: 1 });

  for (const listener of editor.cursorListeners) {
    listener({ position: editor.getPosition() });
  }
}

test('CODE-NOTES-BATCH/SIDES: old/new двух файлов, редактируемый пакет и один draft', async (t) => {
  const h = await mountReviewPanel(t, { files: ['a.txt', 'b.txt'].map((file) => ({
    path: file,
    status: 'M',
    add: 1,
    del: 1,
    binary: false,
    oldContent: ' \nold deletion\n',
    newContent: '\n\nnew insertion\n',
  })) });

  await reviewSetting(h, 'diff-whitespace-mode', 'ignore-all');
  selectReviewLines(h, 'old', 2);
  await clickReviewMenuAction(h, 'add-review-note');
  await reviewControl(h.wrapper, 'review-note-text').setValue('Почему удалено?');
  await reviewControl(h.wrapper, 'save-review-note').trigger('click');
  await h.wrapper.get('button.git-file[data-path="b.txt"]').trigger('click');
  await settle(h.flushPromises);
  selectReviewLines(h, 'new', 3);
  await clickReviewMenuAction(h, 'explain-selection');
  await reviewControl(h.wrapper, 'review-notes-preview').trigger('click');

  const draft = reviewControl(h.wrapper, 'review-draft');

  assert.match(draft.element.value, /a\.txt[\s\S]*old deletion/);
  assert.match(draft.element.value, /b\.txt[\s\S]*new insertion/);
  assert.match(draft.element.value, /work|Рабочее дерево/);
  assert.match(draft.element.value, /a\.txt[\s\S]*?(?:строк[аи]|lines?|:)\s*2\b/i);
  assert.match(draft.element.value, /b\.txt[\s\S]*?(?:строк[аи]|lines?|:)\s*3\b/i);
  assert.equal(h.sessions.length, 0);
  await draft.setValue(`${draft.element.value}\nДополнение человека`);
  await reviewControl(h.wrapper, 'review-create-draft').trigger('click');
  await settle(h.flushPromises);
  assert.equal(h.sessions.length, 1);
  assert.match(h.sessions[0].draft, /Дополнение человека/);
  assert.equal(h.requests.filter((entry) => entry.method === 'POST'
    && !entry.url.includes('/review-fingerprints?')).length, 0);
});

test('CODE-PARTIAL-UI: stage C передаёт raw ids/token без whole-file fallback', async (t) => {
  const h = await mountReviewPanel(t, {
    files: [{
      path: 'a.txt',
      status: 'M',
      add: 2,
      del: 2,
      binary: false,
      oldContent: 'a\nb\nc\nd\n',
      newContent: 'a\nb\nC\nD\n',
    }],
    confirm: async () => true,
    post: async () => ({ ok: true, changed: 1 }),
  });

  selectReviewLines(h, 'new', 3);
  await clickReviewMenuAction(h, 'partial-stage');
  await settle(h.flushPromises);

  const partial = h.requests.find((entry) => entry.url.includes('/partial-index?'));

  assert.ok(partial);
  assert.deepEqual(partial.payload, {
    group: 'work',
    path: 'a.txt',
    token: 'raw-token',
    atomIds: ['raw-C'],
  });
  assert.equal(h.requests.some((entry) => /\/(stage|unstage)\?/.test(entry.url)), false);
});

test('CODE-FILTER-PATH-STATUS: A/M/D/U, найдено/всего и очистка', async (t) => {
  const h = await mountReviewPanel(t, { files: [
    ['src/new.txt', 'A'], ['src/mod.txt', 'M'], ['src/deleted.txt', 'D'], ['other/conflict.txt', 'U'],
  ].map(([file, status]) => ({
    path: file,
    status,
    add: 1,
    del: 1,
    binary: false,
    oldContent: 'old\n',
    newContent: 'new\n',
  })) });

  await reviewControl(h.wrapper, 'git-filter-path').setValue('SRC/');
  await reviewControl(h.wrapper, 'git-filter-status').setValue('A');
  await settle(h.flushPromises);
  assert.match(reviewControl(h.wrapper, 'git-filter-count').text(), /1\s*\/\s*4/);

  const paths = h.wrapper.findAll('button.git-file').map((row) => row.attributes('data-path'));

  assert.deepEqual(paths, ['src/new.txt']);
  await reviewControl(h.wrapper, 'git-filter-clear').trigger('click');
  assert.match(reviewControl(h.wrapper, 'git-filter-count').text(), /4\s*\/\s*4/);
  assert.equal(h.wrapper.findAll('button.git-file').length, 4);
});

test('CODE-SELECT-KEEP: Ctrl/Shift, фильтр, tree/list и refresh сохраняют выбранное', async (t) => {
  const h = await mountReviewPanel(t);

  await h.wrapper.get('button.git-file[data-path="a.txt"]').trigger('click', { ctrlKey: true });
  await h.wrapper.get('button.git-file[data-path="c.txt"]').trigger('click', { shiftKey: true });
  assert.match(reviewControl(h.wrapper, 'git-selection-count').text(), /3/);
  await reviewControl(h.wrapper, 'git-filter-path').setValue('a.txt');
  await settle(h.flushPromises);
  assert.match(reviewControl(h.wrapper, 'git-selection-count').text(), /3/);
  await reviewControl(h.wrapper, 'git-filter-clear').trigger('click');
  await h.wrapper.get('button[data-view="list"]').trigger('click');
  await h.wrapper.get('button[data-view="tree"]').trigger('click');
  await refreshCurrentCode(h.wrapper, h.browser, h.flushPromises);
  assert.match(reviewControl(h.wrapper, 'git-selection-count').text(), /3/);
});

test('CODE-TREE-CONTROLS: collapse/reveal и счётчики leaf-файлов', async (t) => {
  const h = await mountReviewPanel(t, { files: ['src/sub/a.txt', 'src/b.txt', 'other/c.txt'].map((file) => ({
    path: file,
    status: 'M',
    add: 1,
    del: 1,
    binary: false,
    oldContent: 'old\n',
    newContent: 'new\n',
  })) });

  await h.wrapper.get('button.git-file[data-path="src/sub/a.txt"]').trigger('click');
  await clickReviewMenuAction(h, 'git-collapse-all', 'git-tree-tools');
  assert.equal(h.wrapper.find('button.git-file[data-path="src/sub/a.txt"]').exists(), false);
  await clickReviewMenuAction(h, 'git-reveal-current', 'git-tree-tools');
  assert.equal(h.wrapper.get('button.git-dir[data-path="src"]').attributes('aria-expanded'), 'true');
  assert.equal(h.wrapper.get('button.git-dir[data-path="src/sub"]').attributes('aria-expanded'), 'true');
  assert.equal(h.wrapper.get('button.git-dir[data-path="other"]').attributes('aria-expanded'), 'false');
  assert.match(h.wrapper.get('[data-dir="src"] [data-action="directory-count"]').text(), /2/);
  await clickReviewMenuAction(h, 'git-expand-all', 'git-tree-tools');
  assert.equal(h.wrapper.get('button.git-dir[data-path="other"]').attributes('aria-expanded'), 'true');
});

test('CODE-SELECTION-UNION: parent+child+file без дублей и src-other', async (t) => {
  const payloads = [];
  const h = await mountReviewPanel(t, {
    files: ['src/sub/a.txt', 'src/b.txt', 'src-other/c.txt'].map((file) => ({
      path: file,
      status: 'M',
      add: 1,
      del: 1,
      binary: false,
      oldContent: 'old\n',
      newContent: 'new\n',
    })),
    confirm: async () => false,
    post: async (url, payload) => {
      payloads.push(payload);

      return {
        token: 'selection',
        eligible: payload.paths.map((file) => ({ path: file })),
        excluded: [],
      };
    },
  });

  reviewControl(h.wrapper, 'selection-stage');
  await h.wrapper.get('button.git-dir[data-path="src"]').trigger('click', { ctrlKey: true });
  await h.wrapper.get('button.git-dir[data-path="src/sub"]').trigger('click', { ctrlKey: true });
  await h.wrapper.get('button.git-file[data-path="src/sub/a.txt"]').trigger('click', { ctrlKey: true });
  await reviewControl(h.wrapper, 'selection-stage').trigger('click');
  await settle(h.flushPromises);
  assert.deepEqual(payloads[0].paths.sort(), ['src/b.txt', 'src/sub/a.txt']);
  assert.equal(payloads[0].all, undefined);
});

for (const view of ['tree', 'list']) {
  for (const [group, status, allowed, forbidden] of [
    ['work', 'A',
      ['stage-file', 'clean-file', 'ignore-shared', 'ignore-local'], ['discard-file', 'unstage-file']],
    ['work', 'M', ['stage-file', 'discard-file'], ['clean-file', 'ignore-shared']],
    ['work', 'D', ['stage-file', 'discard-file'], ['clean-file', 'ignore-local']],
    ['work', 'U', ['mark-resolved', 'ask-agent'], ['discard-file', 'clean-file', 'ignore-shared']],
    ['staged', 'M', ['unstage-file', 'ask-agent'], ['stage-file', 'discard-file', 'clean-file']],
  ]) {
    test(`CODE-MENU-MATRIX: ${view} ${group}/${status}, одинаковый смысл действий`, async (t) => {
      const file = {
        path: 'a.txt',
        status,
        add: 1,
        del: 1,
        binary: false,
        oldContent: 'old\n',
        newContent: 'new\n',
      };
      const h = await mountReviewPanel(t, {
        files: group === 'work' ? [file] : [], staged: group === 'staged' ? [file] : [],
      });

      await h.wrapper.get(`button[data-view="${view}"]`).trigger('click');

      const more = h.wrapper.find('[data-action="row-more"][data-file="a.txt"]');

      assert.equal(more.exists(), true, 'Меню доступно каждой Git-строке');
      await more.trigger('click');
      await settle(h.flushPromises);

      const menu = h.browser.document.querySelector('[role="menu"]');

      assert.ok(menu, 'Открыто доступное меню Git');

      for (const action of [...allowed, 'copy-path', 'file-history']) {
        assert.ok(menu.querySelector(`[data-action="${action}"]`), `Пункт ${action} доступен`);
      }

      for (const action of forbidden) {
        assert.equal(Boolean(menu.querySelector(`[data-action="${action}"]:not([disabled])`)), false, action);
      }

      assert.equal(h.requests.some((entry) => entry.method === 'POST'), false);
    });
  }
}

test('CODE-MENU-KEYBOARD: contextmenu, Shift+F10, стрелки, Escape возвращают фокус', async (t) => {
  const h = await mountReviewPanel(t);
  const row = h.wrapper.get('button.git-file[data-path="a.txt"]');

  await row.trigger('contextmenu', { clientX: 30, clientY: 50 });
  await settle(h.flushPromises);

  let menu = h.browser.document.querySelector('[role="menu"]');

  assert.ok(menu, 'Правая кнопка открывает меню');
  menu.dispatchEvent(new h.browser.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await settle(h.flushPromises);
  assert.equal(h.browser.document.activeElement === row.element, true);
  await row.trigger('keydown', { key: 'F10', shiftKey: true });
  await settle(h.flushPromises);
  menu = h.browser.document.querySelector('[role="menu"]');
  assert.ok(menu);
  menu.dispatchEvent(new h.browser.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  await settle(h.flushPromises);
  assert.equal(h.browser.document.activeElement?.getAttribute('role'), 'menuitem');
});

test('CODE-MENU-CANCEL: каталог показывает точные пути и отмена не вызывает execute', async (t) => {
  const confirmations = [];
  const h = await mountReviewPanel(t, {
    files: ['new/a.txt', 'new/b.txt'].map((file) => ({
      path: file,
      status: 'A',
      add: 1,
      del: 0,
      binary: false,
      oldContent: '',
      newContent: 'new\n',
    })),
    confirm: async (text) => {
      confirmations.push(text);

      return false;
    },
    post: async () => ({
      token: 'new-directory',
      eligible: [{ path: 'new/a.txt' }, { path: 'new/b.txt' }],
      excluded: [],
      counts: { eligible: 2, excluded: 0 },
    }),
  });

  await reviewControl(h.wrapper, 'dir-more').trigger('click');
  await settle(h.flushPromises);

  const remove = h.browser.document.querySelector('[role="menu"] [data-action="delete-new-dir"]');

  assert.ok(remove);
  remove.click();
  await settle(h.flushPromises);
  assert.match(String(confirmations[0]), /new\/a\.txt/);
  assert.match(String(confirmations[0]), /new\/b\.txt/);
  assert.equal(h.requests.some((entry) => entry.url.includes('/action-execute?')), false);
});

test('CODE-BATCH-PARTIAL-UI: вторая порция ошиблась, 500 выполнены, один остался выбран', async (t) => {
  let executed = 0;
  const h = await mountReviewPanel(t, {
    files: Array.from({ length: 501 }, (_, index) => ({
      path: `src/${index}.txt`,
      status: 'M',
      add: 1,
      del: 1,
      binary: false,
      oldContent: 'old\n',
      newContent: 'new\n',
    })),
    confirm: async () => true,
    post: async (url, payload) => {
      if (url.includes('/action-preview?')) {
        return {
          token: `batch-${payload.paths[0]}`,
          eligible: payload.paths.map((file) => ({ path: file })),
          excluded: [],
        };
      }

      executed += 1;

      if (executed === 2) {
        return {
          ok: false,
          completed: [],
          failed: payload.paths.map((file) => ({
          path: file, reason: 'git_busy',
        })),
          unattempted: [],
        };
      }

      return {
        ok: true,
        completed: payload.paths.map((file) => ({ path: file })),
        failed: [],
        unattempted: [],
      };
    },
  });

  await h.wrapper.get('button.git-dir[data-path="src"]').trigger('click', { ctrlKey: true });
  await reviewControl(h.wrapper, 'selection-stage').trigger('click');
  await settle(h.flushPromises, 12);
  assert.equal(executed, 2);
  assert.match(reviewControl(h.wrapper, 'git-action-result').text(), /500/);
  assert.match(reviewControl(h.wrapper, 'git-action-result').text(), /1/);
  assert.match(reviewControl(h.wrapper, 'git-selection-count').text(), /1/);
  assert.equal(h.requests.filter((entry) => entry.url.includes('/action-execute?')).length, 2);
});

test('CODE-FOLDER-REVIEW: scope src, src-other исключён, old строка открывает old сторону', async (t) => {
  const h = await mountReviewPanel(t, {
    files: ['src/a.txt', 'src-other/b.txt'].map((file) => ({
      path: file,
      status: 'M',
      add: 1,
      del: 1,
      binary: false,
      oldContent: 'old\n',
      newContent: 'new\n',
    })),
    patch: (url) => ({
      truncated: false,
      patch: query(url).get('directory') === 'src'
        ? 'diff --git a/src/a.txt b/src/a.txt\n--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1 +1 @@\n-old\n+new\n'
        : 'diff --git a/src-other/b.txt b/src-other/b.txt\n--- a/src-other/b.txt\n'
          + '+++ b/src-other/b.txt\n@@ -1 +1 @@\n-old\n+new\n',
    }),
  });

  await reviewControl(h.wrapper, 'folder-review').trigger('click');
  await settle(h.flushPromises, 8);

  const request = h.requests.find((entry) => entry.url.includes('/patch?'));

  assert.equal(query(request.url).get('directory'), 'src');
  assert.equal(h.wrapper.findAll('.patch-file').length, 1);
  assert.doesNotMatch(h.wrapper.get('[data-view="patch-review"]').text(), /src-other/);
  await h.wrapper.get('.patch-line.del').trigger('click');
  await settle(h.flushPromises);
  assert.ok(reviewEditors(h)[0].revealed.includes(1));
});

for (const missing of [null, 'base', 'theirs']) {
  test(`CODE-CONFLICT-VIEW/NAV/DRAFT: версии read-only, отсутствует ${missing}`, async (t) => {
    const markers = '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> incoming\n';
    const h = await mountReviewPanel(t, {
      files: [{
        path: 'a.txt',
        status: 'U',
        add: 0,
        del: 0,
        binary: false,
        oldContent: 'ours\n',
        newContent: markers + 'context\n' + markers,
      }],
      conflict: (path) => ({
        path,
        ...Object.fromEntries(['base', 'ours', 'theirs', 'work'].map((name) => [name, {
          presence: name !== missing,
          binary: false,
          tooBig: false,
          content: name === missing ? '' : name === 'work' ? markers + 'context\n' + markers : `${name}\n`,
          fingerprint: createHash('sha256').update(name).digest('hex'),
        }])),
      }),
    });

    assert.equal(reviewControl(h.wrapper, 'conflict-base').exists(), true);
    assert.equal(reviewControl(h.wrapper, 'conflict-ours').exists(), true);
    assert.equal(reviewControl(h.wrapper, 'conflict-theirs').exists(), true);
    assert.ok(reviewEditors(h).every((editor) => editor.options.readOnly === true));

    if (missing) {
      assert.match(reviewControl(h.wrapper, `conflict-${missing}`).text(), /отсутствует|нет версии/i);
    }

    await reviewControl(h.wrapper, 'conflict-next').trigger('click');
    assert.match(reviewControl(h.wrapper, 'conflict-position').text(), /2\s*\/\s*2/);
    await reviewControl(h.wrapper, 'conflict-previous').trigger('click');
    assert.match(reviewControl(h.wrapper, 'conflict-position').text(), /1\s*\/\s*2/);
    await reviewControl(h.wrapper, 'ask-conflict').trigger('click');
    await settle(h.flushPromises);
    assert.equal(h.sessions.length, 1);
    assert.match(h.sessions[0].draft, /a\.txt/);
    assert.match(h.sessions[0].draft, /ours/);
    assert.equal(h.requests.some((entry) => entry.method === 'POST'
      && /\/(stage|unstage|discard|clean|partial-index|action-execute)\?/.test(entry.url)), false);
  });
}

test('CODE-REVIEW-LOCALE: RU→EN меняет новые labels/aria без сброса ввода', async (t) => {
  const h = await mountReviewPanel(t);
  const setLocale = globalThis.__codeViewSetLocale;

  t.after(() => setLocale('ru'));

  await clickReviewMenuAction(h, 'add-review-note');
  await reviewControl(h.wrapper, 'review-note-text').setValue('Мой комментарий');

  const before = reviewControl(h.wrapper, 'mark-viewed').text();

  globalThis.__codeViewSetLocale('en');
  await settle(h.flushPromises);
  assert.notEqual(reviewControl(h.wrapper, 'mark-viewed').text(), before);
  assert.match(reviewControl(h.wrapper, 'mark-viewed').text(), /Viewed|Reviewed/);
  assert.match(reviewControl(h.wrapper, 'next-unreviewed').attributes('aria-label'), /unreviewed/i);
  assert.equal(reviewControl(h.wrapper, 'review-note-text').element.value, 'Мой комментарий');
  globalThis.__codeViewSetLocale('ru');
});

for (const [repo, root] of [['demo', '/linked'], ['secondary', '/secondary']]) {
  test(`CODE-VIEWED-SCOPE: ${repo}/${root} не наследует чужую отметку`, async (t) => {
    const h = await mountReviewPanel(t, { repos: [
      {
        key: 'demo',
        dir: '/demo',
        trees: [mainTree('/demo'), worktree('/linked', 'linked', 'task-1')],
      },
      {
        key: 'secondary',
        dir: '/secondary',
        trees: [mainTree('/secondary')],
      },
    ] });

    await reviewControl(h.wrapper, 'mark-viewed').trigger('click');
    assert.match(reviewControl(h.wrapper, 'review-progress').text(), /1\s*\/\s*3/);
    await h.wrapper.get('#code-context-native').setValue(JSON.stringify([repo, root]));
    await settle(h.flushPromises, 8);
    assert.match(reviewControl(h.wrapper, 'review-progress').text(), /0\s*\/\s*3/);
    assert.equal(h.wrapper.find('[data-path="a.txt"][data-viewed="true"]').exists(), false);
    await h.wrapper.get('#code-context-native').setValue(JSON.stringify(['demo', '/demo']));
    await settle(h.flushPromises, 8);
    assert.match(reviewControl(h.wrapper, 'review-progress').text(), /1\s*\/\s*3/);
  });
}

for (const withWork of [false, true]) {
  test(`CODE-HISTORICAL: +текущие=${withWork}, descriptor и запрет мутаций`, async (t) => {
    const h = await mountReviewPanel(t);

    h.snapshot.log = [{
      hash: 'c'.repeat(40),
      subject: 'tip',
      when: 'сейчас',
    }];
    await refreshCurrentCode(h.wrapper, h.browser, h.flushPromises);
    await selectCodeTab(h.wrapper, 'commits');
    await settle(h.flushPromises);
    await h.wrapper.get(`button.commit[data-hash="${'c'.repeat(40)}"]`).trigger('click');
    await settle(h.flushPromises);

    const toggle = h.wrapper.get('button[data-action="commits-with-work"]');

    if ((toggle.attributes('aria-pressed') === 'true') !== withWork) {
      await toggle.trigger('click');
      await settle(h.flushPromises);
    }

    await selectCodeTab(h.wrapper, 'changes');
    await settle(h.flushPromises);
    reviewControl(h.wrapper, 'mark-viewed');

    const mutation = h.wrapper.find('[data-action="partial-stage"]:not([disabled])');

    assert.equal(mutation.exists(), false);
    await h.wrapper.get('button.navigator-toggle').trigger('click');
    await reviewControl(h.wrapper, 'diff-file-list').setValue('commits:b.txt');
    await settle(h.flushPromises);

    const request = h.requests.filter((entry) => entry.url.includes('/file-diff?')).at(-1);

    assert.equal(query(request.url).get('group'), 'commits');
    assert.equal(query(request.url).get('base'), 'b'.repeat(40));
    assert.equal(query(request.url).get('to'), withWork ? null : 'c'.repeat(40));
    assert.equal(query(request.url).get('work') === '1', withWork);
    await reviewControl(h.wrapper, 'mark-viewed').trigger('click');

    const saved = JSON.parse(h.browser.localStorage.getItem('grigdesk-code-review-v1'));
    const descriptor = saved.map(([key]) => JSON.parse(key)).find((key) => key.at(-1) === 'b.txt');

    assert.deepEqual(descriptor, [
      'demo', 'demo', '/demo', 'commits', 'b'.repeat(40), 'c'.repeat(40), withWork, 'b.txt',
    ]);
    assert.equal(h.requests.some((entry) => entry.method === 'POST'
      && !entry.url.includes('/review-fingerprints?')), false);
  });
}

for (const action of ['stage', 'unstage', 'discard', 'clean-new']) {
  test(`CODE-SELECT-FILTER: ${action} не включает скрытую часть без подтверждения`, async (t) => {
    const captured = [];
    const entries = ['a.txt', 'b.txt'].map((file) => ({
      path: file,
      status: action === 'clean-new' ? 'A' : 'M',
      add: 1,
      del: 1,
      binary: false,
      oldContent: 'old\n',
      newContent: 'new\n',
    }));
    const h = await mountReviewPanel(t, {
      files: action === 'unstage' ? [] : entries,
      staged: action === 'unstage' ? entries : [],
      confirm: async () => false,
      post: async (url, payload) => {
        captured.push(payload);

        return {
          token: 'filtered',
          eligible: payload.paths.map((file) => ({ path: file })),
          excluded: [],
        };
      },
    });

    reviewControl(h.wrapper, `selection-${action}`);
    await h.wrapper.get('button.git-file[data-path="a.txt"]').trigger('click', { ctrlKey: true });
    await h.wrapper.get('button.git-file[data-path="b.txt"]').trigger('click', { ctrlKey: true });
    await reviewControl(h.wrapper, 'git-filter-path').setValue('a.txt');
    await settle(h.flushPromises);
    await reviewControl(h.wrapper, `selection-${action}`).trigger('click');
    await settle(h.flushPromises);
    assert.deepEqual(captured[0].paths, ['a.txt']);
    assert.equal(captured[0].all, undefined);
    assert.equal(h.requests.some((entry) => entry.url.includes('/action-execute?')), false);
  });
}

test('CODE-VIEW-WORKER: поздний результат не заменяет актуальный, dispose завершает поток', async (t) => {
  const h = await mountReviewPanel(t);

  reviewControl(h.wrapper, 'hunk-position');
  h.snapshot.files[1].newContent = h.snapshot.files[1].newContent.replace('second change', 'line 110');

  const held = holdCodeReviewWorkerResponses(t);

  await h.wrapper.get('button.git-file[data-path="b.txt"]').trigger('click');
  await settle(h.flushPromises);
  await h.wrapper.get('button.git-file[data-path="c.txt"]').trigger('click');
  await settle(h.flushPromises);
  assert.ok(held.length >= 2, 'Оба сравнения действительно вычислены Worker');

  for (const deliver of held.reverse()) {
    deliver();
    await settle(h.flushPromises);
  }

  assert.equal(h.wrapper.get('.ehead .epath').text(), 'c.txt');
  assert.match(reviewControl(h.wrapper, 'hunk-position').text(), /1\s*\/\s*2/);
  assert.ok(activeCodeReviewWorkers() > 0);
  h.wrapper.unmount();
  assert.equal(activeCodeReviewWorkers(), 0);
});

test('CODE-VIEWED-SCOPE: новый base и +текущие не наследуют просмотр диапазона', async (t) => {
  const h = await mountReviewPanel(t);

  reviewControl(h.wrapper, 'mark-viewed');
  h.snapshot.log = [
    {
      hash: 'c'.repeat(40),
      subject: 'tip',
      when: 'сейчас',
    },
    {
      hash: 'a'.repeat(40),
      subject: 'old',
      when: 'вчера',
    },
  ];
  await refreshCurrentCode(h.wrapper, h.browser, h.flushPromises);
  await selectCodeTab(h.wrapper, 'commits');
  await settle(h.flushPromises);
  await h.wrapper.get(`button.commit[data-hash="${'c'.repeat(40)}"]`).trigger('click');
  await settle(h.flushPromises);
  await selectCodeTab(h.wrapper, 'changes');
  await settle(h.flushPromises);
  await reviewControl(h.wrapper, 'mark-viewed').trigger('click');
  assert.match(reviewControl(h.wrapper, 'review-progress').text(), /1\s*\/\s*3/);
  await selectCodeTab(h.wrapper, 'commits');
  await settle(h.flushPromises);
  await h.wrapper.get(`button.commit[data-hash="${'a'.repeat(40)}"]`).trigger('click', { shiftKey: true });
  await selectCodeTab(h.wrapper, 'changes');
  await settle(h.flushPromises);
  assert.match(reviewControl(h.wrapper, 'review-progress').text(), /0\s*\/\s*3/);
  await reviewControl(h.wrapper, 'mark-viewed').trigger('click');
  await selectCodeTab(h.wrapper, 'commits');
  await settle(h.flushPromises);
  await h.wrapper.get('button[data-action="commits-with-work"]').trigger('click');
  await selectCodeTab(h.wrapper, 'changes');
  await settle(h.flushPromises);
  assert.match(reviewControl(h.wrapper, 'review-progress').text(), /0\s*\/\s*3/);
});

for (const view of ['tree', 'list']) {
  test(`CODE-MENU-MATRIX: ${view} commits не предлагает мутации даже с +текущие`, async (t) => {
    const h = await mountReviewPanel(t);

    await h.wrapper.get(`button[data-view="${view}"]`).trigger('click');

    h.snapshot.log = [{
      hash: 'c'.repeat(40),
      subject: 'tip',
      when: 'сейчас',
    }];
    await refreshCurrentCode(h.wrapper, h.browser, h.flushPromises);
    await selectCodeTab(h.wrapper, 'commits');
    await settle(h.flushPromises);
    await h.wrapper.get(`button.commit[data-hash="${'c'.repeat(40)}"]`).trigger('click');
    await settle(h.flushPromises);
    await h.wrapper.get('button.git-file[data-group="commits"][data-path="a.txt"]').trigger('contextmenu');
    await settle(h.flushPromises);

    const menu = h.browser.document.querySelector('[role="menu"]');

    assert.ok(menu, 'Контекстное меню исторической группы доступно');

    for (const action of ['stage-file', 'unstage-file', 'discard-file', 'clean-file', 'mark-resolved',
      'ignore-shared', 'ignore-local']) {
      assert.equal(Boolean(menu.querySelector(`[data-action="${action}"]:not([disabled])`)), false, action);
    }

    assert.ok(menu.querySelector('[data-action="copy-path"]'));
    assert.ok(menu.querySelector('[data-action="ask-agent"]'));
    assert.equal(h.requests.some((entry) => entry.method === 'POST'
      && !entry.url.includes('/review-fingerprints?')), false);
  });
}
