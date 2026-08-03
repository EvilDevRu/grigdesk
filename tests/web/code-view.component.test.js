import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.NODE_ENV = 'test';

const VIEW_PATH = fileURLToPath(new URL('../../web/src/views/CodeView.vue', import.meta.url));
const VUE_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/node_modules/vue/index.mjs', import.meta.url),
)).href;
const CODE_TREE_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/src/shared/code-tree.js', import.meta.url),
)).href;
let compileNonce = 0;

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

function query(url) {
  return new URL(url, 'http://cockpit.test').searchParams;
}

async function compileCodeView() {
  const { parse, compileScript } = await import(
    '../../web/node_modules/@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js'
  );
  const source = await readFile(VIEW_PATH, 'utf8');
  const { descriptor, errors } = parse(source, { filename: VIEW_PATH });
  assert.deepEqual(errors, []);
  let code = compileScript(descriptor, {
    id: `data-v-code-view-test-${compileNonce}`,
    inlineTemplate: true,
  }).content;
  code = code
    .replaceAll('from "vue"', `from "${VUE_URL}"`)
    .replaceAll("from 'vue'", `from "${VUE_URL}"`)
    .replace(
      "import { api } from '../shared/api-client.js';",
      'const api = globalThis.__codeViewApi;',
    )
    .replace(
      "import { usePluginsStore } from '../stores/plugins.js';",
      'const usePluginsStore = globalThis.__codeViewPluginsStore;',
    )
    .replace(
      "import { monaco, langOf, READONLY_OPTS } from '../shared/monaco.js';",
      'const monaco = globalThis.__codeViewMonaco; const langOf = (path) => path.split(".").pop() || "plaintext"; const READONLY_OPTS = {};',
    )
    .replace(
      "import TopbarActions from '../shared/layout/TopbarActions.vue';",
      "const TopbarActions = { template: '<div class=\"topbar-stub\"><slot /></div>' };",
    )
    .replace(
      "from '../shared/code-tree.js'",
      `from "${CODE_TREE_URL}"`,
    );
  const nonce = compileNonce++;
  return (await import(
    `data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${nonce}`
  )).default;
}

function installBrowser(t, storage = {}) {
  return import('../../web/node_modules/happy-dom/lib/index.js').then(({ Window }) => {
    const browser = new Window({ url: 'http://cockpit.test/#/code' });
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
    t.after(() => browser.close());
    return browser;
  });
}

function makeMonaco() {
  const state = { models: [], fileEditors: [], diffEditors: [] };
  const makeEditor = (kind) => {
    const editor = {
      kind,
      model: undefined,
      setCalls: [],
      disposed: false,
      setModel(model) { this.model = model; this.setCalls.push(model); },
      updateOptions() {},
      dispose() { this.disposed = true; },
    };
    state[kind === 'file' ? 'fileEditors' : 'diffEditors'].push(editor);
    return editor;
  };
  const monaco = {
    editor: {
      create: () => makeEditor('file'),
      createDiffEditor: () => makeEditor('diff'),
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

async function settle(flushPromises, cycles = 5) {
  for (let i = 0; i < cycles; i += 1) await flushPromises();
}

async function waitFor(check, message) {
  for (let i = 0; i < 40; i += 1) {
    if (check()) return;
    await new Promise((resolve) => { setImmediate(resolve); });
  }
  assert.fail(message);
}

async function mountCodeView(t, { api, storage = {} }) {
  const browser = await installBrowser(t, storage);
  const { monaco, state: monacoState } = makeMonaco();
  globalThis.__codeViewApi = api;
  globalThis.__codeViewMonaco = monaco;
  globalThis.__codeViewPluginsStore = () => ({
    loaded: true,
    enabled: () => true,
    async load() {},
  });
  const [{ mount, flushPromises }, CodeView] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileCodeView(),
  ]);
  const wrapper = mount(CodeView, {
    attachTo: browser.document.querySelector('#mount'),
    global: {
      stubs: { RouterLink: { template: '<a href="/projects"><slot /></a>' } },
    },
  });
  t.after(() => {
    wrapper.unmount();
    delete globalThis.__codeViewApi;
    delete globalThis.__codeViewMonaco;
    delete globalThis.__codeViewPluginsStore;
  });
  await settle(flushPromises);
  return { browser, wrapper, flushPromises, monacoState };
}

test('CodeView показывает два подписанных уровня, хранит контекст по проекту и сообщает о недоступном repo', async (t) => {
  const calls = [];
  const projects = [
    { id: 'cockpit', repos: ['/engine', '/web', '/broken'] },
    { id: 'solo', repos: ['/solo'] },
  ];
  const repos = {
    cockpit: [
      {
        key: 'engine', dir: '/engine', trees: [
          mainTree('/engine', 'master'),
          worktree('/work/t8165', 't8165', 'task-8165', 't8165'),
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
      'cockpit-project': 'cockpit',
      'cockpit-code-context:cockpit': storedWeb,
    },
  });

  assert.equal(wrapper.findAll('.sels select').length, 2);
  assert.equal(wrapper.get('label[for="code-project"]').text(), 'Проект');
  assert.equal(wrapper.get('label[for="code-context"]').text(), 'Рабочая копия');
  assert.equal(wrapper.get('#code-context').element.value, JSON.stringify(['web', '/work/web-preview']));
  assert.deepEqual(wrapper.findAll('#code-context optgroup').map((group) => group.attributes('label')), [
    'engine', 'web',
  ]);
  const optionTexts = wrapper.findAll('#code-context option').map((option) => option.text());
  assert.ok(optionTexts.includes('engine · Основная · master'));
  assert.ok(optionTexts.includes('engine · Задача t8165 · task-8165'));
  assert.ok(optionTexts.includes('web · Worktree web-preview · detached HEAD'));
  assert.match(wrapper.get('.context-warning').text(), /broken.*\/missing\/broken/s);
  assert.match(wrapper.get('.context-warning a').text(), /Проекты/);

  const restoredLs = calls.find((url) => url.includes('/api/code/cockpit/ls?'));
  assert.equal(query(restoredLs).get('repo'), 'web');
  assert.equal(query(restoredLs).get('root'), '/work/web-preview');

  await wrapper.get('#code-context').setValue(JSON.stringify(['engine', '/engine']));
  await settle(flushPromises);
  assert.deepEqual(JSON.parse(browser.localStorage.getItem('cockpit-code-context:cockpit')), {
    v: 1,
    repoKey: 'engine',
    treePath: '/engine',
  });
  const latestCockpitLs = calls.filter((url) => url.includes('/api/code/cockpit/ls?')).at(-1);
  assert.equal(query(latestCockpitLs).get('repo'), 'engine');
  assert.equal(query(latestCockpitLs).get('root'), '/engine');

  await wrapper.get('#code-project').setValue('solo');
  await settle(flushPromises);
  assert.equal(wrapper.findAll('.sels select').length, 1);
  assert.equal(wrapper.get('.context-static').text(), 'Рабочая копия: solo · Основная · trunk');

  await wrapper.get('#code-project').setValue('cockpit');
  await settle(flushPromises);
  assert.equal(wrapper.get('#code-context').element.value, JSON.stringify(['engine', '/engine']));
  assert.equal(browser.localStorage.getItem('cockpit-code-context:solo'), JSON.stringify({
    v: 1,
    repoKey: 'solo',
    treePath: '/solo',
  }));
});

test('Git по умолчанию показан деревом, доступно переключается в список и сохраняет выбранный diff', async (t) => {
  const git = {
    branch: 'main',
    files: [
      { path: 'src/deep/b.js', status: 'M', add: 2, del: 1, oldContent: 'old b', newContent: 'new b' },
      { path: 'src/a.js', status: 'A', add: 4, del: 0, oldContent: '', newContent: 'a' },
      { path: 'root.md', status: 'D', add: 0, del: 3, oldContent: 'root', newContent: '' },
      { path: 'foo', status: 'D', add: 0, del: 1, oldContent: 'file', newContent: '' },
      { path: 'foo/bar.js', status: 'A', add: 1, del: 0, oldContent: '', newContent: 'bar' },
    ],
    log: [],
  };
  const api = {
    async get(url) {
      if (url === '/api/projects') return { projects: [{ id: 'demo', repos: ['/demo'] }] };
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
    storage: { 'cockpit-code-git-view': 'damaged' },
  });

  await wrapper.get('button[title^="Гит:"]').trigger('click');
  await settle(flushPromises);

  const toggle = wrapper.get('[role="group"][aria-label="Вид изменений"]');
  const treeButton = toggle.get('button[data-view="tree"]');
  const listButton = toggle.get('button[data-view="list"]');
  assert.equal(treeButton.attributes('aria-pressed'), 'true');
  assert.equal(listButton.attributes('aria-pressed'), 'false');
  assert.equal(treeButton.get('svg').attributes('aria-hidden'), 'true');
  assert.equal(wrapper.get('button.git-dir[data-path="src"]').attributes('aria-expanded'), 'true');
  assert.equal(wrapper.get('button.git-dir[data-path="foo"]').attributes('aria-expanded'), 'true');
  assert.equal(wrapper.findAll('[data-path="foo"]').length, 2);

  const nested = wrapper.get('button.git-file[data-path="src/deep/b.js"]');
  await nested.trigger('click');
  await settle(flushPromises);
  assert.match(wrapper.get('.ehead').text(), /src\/deep\/b\.js/);
  assert.match(nested.text(), /\+2.*−1/s);
  const diffSetCalls = monacoState.diffEditors[0].setCalls.length;

  await listButton.trigger('click');
  await settle(flushPromises);
  assert.equal(treeButton.attributes('aria-pressed'), 'false');
  assert.equal(listButton.attributes('aria-pressed'), 'true');
  assert.equal(wrapper.get('button.git-file[data-path="src/deep/b.js"]').classes().includes('sel'), true);
  assert.equal(wrapper.get('button.git-file[data-path="src/deep/b.js"] .nm').text(), 'src/deep/b.js');
  assert.equal(monacoState.diffEditors[0].setCalls.length, diffSetCalls);

  await treeButton.trigger('click');
  await settle(flushPromises);
  assert.equal(wrapper.get('button.git-file[data-path="src/deep/b.js"]').classes().includes('sel'), true);
  assert.match(wrapper.get('.ehead').text(), /src\/deep\/b\.js/);
  assert.equal(monacoState.diffEditors[0].setCalls.length, diffSetCalls);

  await wrapper.get('button.git-dir[data-path="src"]').trigger('click');
  await settle(flushPromises);
  assert.equal(wrapper.get('button.git-dir[data-path="src"]').attributes('aria-expanded'), 'false');
  assert.equal(wrapper.find('button.git-file[data-path="src/deep/b.js"]').exists(), false);
  assert.equal(wrapper.find('button.git-file[data-path="root.md"]').exists(), true);
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
      if (url === '/api/projects') return { projects: [{ id: 'race', repos: ['/race'] }] };
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
    branch: 'main',
    files: [{ path, status: 'M', add: 1, del: 0, oldContent: '', newContent: path }],
    log: [],
  });
  const api = {
    async get(url) {
      if (url === '/api/projects') {
        return { projects: [{ id: 'a', repos: ['/a'] }, { id: 'b', repos: ['/b'] }] };
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
        if (mainGitCalls === 1) return gitPayload('main-initial.js');
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

  await wrapper.get('button[title^="Гит:"]').trigger('click');
  await settle(flushPromises);
  assert.equal(wrapper.find('button.git-file[data-path="main-initial.js"]').exists(), true);

  await wrapper.get('#code-context').setValue(JSON.stringify(['a', '/a/task']));
  await waitFor(() => taskGitCalls === 1, 'не стартовал Git-запрос старого task-контекста');
  await wrapper.get('#code-context').setValue(JSON.stringify(['a', '/a/main']));
  await waitFor(() => mainGitCalls === 2, 'не стартовал Git-запрос нового main-контекста');
  currentMainGit.resolve(gitPayload('main-current.js'));
  await settle(flushPromises);
  lateTaskGit.resolve(gitPayload('task-late.js'));
  await settle(flushPromises);

  assert.equal(wrapper.find('button.git-file[data-path="main-current.js"]').exists(), true);
  assert.equal(wrapper.find('button.git-file[data-path="task-late.js"]').exists(), false);
  assert.match(wrapper.get('.ehead').text(), /main-current\.js/);
});
