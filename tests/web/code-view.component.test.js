import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { compileVue, webFile } from './helpers/compile-vue.js';

process.env.NODE_ENV = 'test';

// Маршрутный CodeView теперь только adapter. Состояние и Monaco живут в единственном
// CodePanel, поэтому компонентные контракты проверяем непосредственно на нём.
const VIEW_PATH = webFile('src/views/code/CodePanel.vue');

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
  return compileVue(VIEW_PATH, {
    stubs: {
      '../../shared/api-client.js': 'export const api = globalThis.__codeViewApi;',
      '../../shared/monaco.js': `
        export const monaco = globalThis.__codeViewMonaco;
        export const langOf = (path) => path.split('.').pop() || 'plaintext';
        export const READONLY_OPTS = {};
      `,
    },
  });
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
      setModel(model) { this.model = model; this.setCalls.push(model); },
      revealLineInCenter(line) { this.revealed.push(line); },
      setPosition(value) { this.position = value; },
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

async function settle(flushPromises, cycles = 5) {
  for (let i = 0; i < cycles; i += 1) await flushPromises();
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

async function mountCodeView(t, { api, storage = {}, props = {} }) {
  const browser = await installBrowser(t, storage);
  const { monaco, state: monacoState } = makeMonaco();
  globalThis.__codeViewApi = api;
  globalThis.__codeViewMonaco = monaco;
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
  assert.equal(loading.find('.rail').exists(), true);
  assert.equal(loading.find('.panel').exists(), true);
  assert.equal(loading.find('.code-split').exists(), true);
  assert.equal(loading.find('.editorwrap').exists(), true);
  assert.equal(wrapper.find('.empty').exists(), false);

  projectsRequest.resolve({ projects: [{ id: 'demo', repos: ['/demo'] }] });
  await settle(flushPromises);
  assert.equal(wrapper.find('.code-loading').exists(), false);
  assert.equal(wrapper.get('.lay').classes().includes('compact'), true);
});

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
      'cockpit-project': 'cockpit',
      'cockpit-code-context:cockpit': storedWeb,
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
  assert.equal(monacoState.diffEditors[0].options.renderSideBySide, true);
  await wrapper.get('button.git-file[data-path="src/a.js"]').trigger('click');
  await settle(flushPromises);
  assert.match(wrapper.get('.ehead').text(), /src\/a\.js.*одна колонка/s);
  assert.equal(monacoState.diffEditors[0].options.renderSideBySide, false,
    'новый файл не оставляет пустую половину side-by-side diff');

  await nested.trigger('click');
  await settle(flushPromises);
  assert.match(wrapper.get('.ehead').text(), /src\/deep\/b\.js/);
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

test('повторное открытие обновляет Code без пустого кадра и разрыва Monaco-модели', async (t) => {
  const nextProjects = deferred();
  const nextRepos = deferred();
  const nextRoot = deferred();
  const nextFile = deferred();
  let projectsCalls = 0;
  let reposCalls = 0;
  let rootCalls = 0;
  let fileCalls = 0;
  const projectPayload = { projects: [{ id: 'demo', repos: ['/demo'] }] };
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
      if (url === '/api/projects') return { projects: [{ id: 'demo', repos: ['/demo'] }] };
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
  assert.equal(wrapper.get('button[title="Обновить"]').attributes('disabled'), undefined);
});

test('временная ошибка фонового чтения сохраняет прежний файл и Monaco-модель', async (t) => {
  const backgroundFile = deferred();
  let fileCalls = 0;
  const api = {
    async get(url) {
      if (url === '/api/projects') return { projects: [{ id: 'demo', repos: ['/demo'] }] };
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
    { id: 'a', repos: ['/a'] },
    { id: 'b', repos: ['/b'] },
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
      if (url === '/api/projects') return { projects: [{ id: 'demo', repos: ['/demo'] }] };
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

test('compact Code оставляет дерево слева и хранит ширину вертикального разделителя', async (t) => {
  const api = {
    async get(url) {
      if (url === '/api/projects') return { projects: [{ id: 'demo', repos: ['/demo'] }] };
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
  assert.equal(separator.attributes('aria-valuenow'), '260');
  assert.equal(wrapper.get('.panel').element.nextElementSibling === separator.element, true);
  assert.equal(separator.element.nextElementSibling === wrapper.get('.editorwrap').element, true);

  await separator.trigger('keydown', { key: 'End' });
  await settle(flushPromises);
  assert.equal(separator.attributes('aria-valuenow'), '420');

  await separator.trigger('keydown', { key: 'ArrowLeft' });
  await settle(flushPromises);
  assert.equal(wrapper.get('.code-split').attributes('aria-valuenow'), '404');
  assert.equal(browser.localStorage.getItem('cockpit-code-dock-nav-width'), '404');

  await wrapper.get('.navigator-toggle').trigger('click');
  assert.equal(wrapper.get('.lay').classes().includes('navigator-collapsed'), true);
  assert.equal(wrapper.find('.code-split').exists(), false);
});

test('картинка показывается предпросмотром, а не пустым редактором', async (t) => {
  // JSON-роут `file` считает картинку бинарной и отдаёт пустое содержимое: раньше
  // это давало пустой Monaco с пометкой «бинарный» — файл выглядел сломанным.
  const api = {
    url: (path) => `http://brain${path}`,
    async get(url) {
      if (url === '/api/projects') return { projects: [{ id: 'demo', repos: ['/demo'] }] };
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
      if (url === '/api/projects') return { projects: [{ id: 'demo', repos: ['/demo'] }] };
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
    branch: 'main',
    staged: [
      { path: 'src/a.js', status: 'M', add: 1, del: 0, group: 'staged', oldContent: 'head a', newContent: 'index a' },
      { path: 'only-staged.js', status: 'M', add: 2, del: 2, group: 'staged', oldContent: 'head', newContent: 'index' },
    ],
    files: [
      { path: 'src/a.js', status: 'M', add: 3, del: 0, group: 'work', oldContent: 'index a', newContent: 'work a' },
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
  const { wrapper, flushPromises, monacoState } = await mountCodeView(t, { api });

  await wrapper.get('button[title^="Гит:"]').trigger('click');
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
  assert.match(wrapper.get('.ehead').text(), /src\/a\.js.*в индексе/s);

  await work.trigger('click');
  await settle(flushPromises);
  assert.equal(work.classes().includes('sel'), true);
  assert.equal(staged.classes().includes('sel'), false);
  assert.equal(monacoState.diffEditors[0].model.original.content, 'index a');
  assert.equal(monacoState.diffEditors[0].model.modified.content, 'work a');
  assert.match(wrapper.get('.ehead').text(), /src\/a\.js.*в рабочем дереве/s);

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
    path: 'src/a.js',
    status: 'M',
    add: 1,
    del: 0,
    oldContent: 'old',
    newContent: 'new',
  };
  let git = {
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
        return { projects: [{ id: 'demo', repos: ['/demo'] }] };
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
        return { ok: true };
      }
      if (url.includes('/stage?')) {
        git = {
          ...git,
          staged: [{ ...file, group: 'staged' }],
          files: [],
        };
        return { ok: true };
      }
      if (url.includes('/commit-message?')) {
        return {
          ok: true,
          title: 'Кокпит: добавить Git-действия',
          model: 'claude/claude-test',
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
        };
      }

      throw new Error(`unexpected POST ${url}`);
    },
  };
  const { wrapper, flushPromises } = await mountCodeView(t, { api });

  await wrapper.get('button[title^="Гит:"]').trigger('click');
  await settle(flushPromises);
  assert.equal(wrapper.find('input.commit-message').exists(), false);
  assert.equal(
    wrapper.get('textarea.commit-message').attributes('placeholder'),
    'Название коммита',
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
    'Кокпит: добавить Git-действия');
  assert.match(wrapper.get('.git-notice').text(), /claude\/claude-test/);

  await wrapper.get('button.commit-action').trigger('click');
  await settle(flushPromises);
  assert.deepEqual(posts[4].body, { message: 'Кокпит: добавить Git-действия' });
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
      if (url === '/api/projects') return { projects: [{ id: 'demo', repos: ['/demo'] }] };
      if (url === '/api/code/demo/repos') {
        return { repos: [{ key: 'demo', dir: '/demo', trees: [mainTree('/demo')] }] };
      }
      if (url.includes('/ls?')) return { entries: [] };
      if (url.includes('/git?')) {
        return {
          branch: 'main',
          staged: [],
          files: [{ path: 'a.js', status: 'M', add: 1, del: 1, oldContent: 'x', newContent: 'y' }],
          log: [],
        };
      }
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const { wrapper, flushPromises } = await mountCodeView(t, { api });
  await wrapper.get('button[title^="Гит:"]').trigger('click');
  await settle(flushPromises);

  assert.deepEqual(groupHeads(wrapper), [{ group: 'work', title: 'Не в коммите', count: '1' }]);
  // Пока вариант ровно один, называть группу в шапке нечего — подпись была бы шумом.
  assert.equal(wrapper.find('.ehead .scope').exists(), false);
});

test('заголовок группы несёт итог строк, как сводка pull request на GitHub', async (t) => {
  const git = {
    branch: 'main',
    staged: [
      { path: 'src/a.js', status: 'M', add: 23, del: 6, group: 'staged', oldContent: 'head', newContent: 'index' },
      { path: 'src/b.js', status: 'A', add: 2, del: 0, group: 'staged', oldContent: '', newContent: 'b' },
    ],
    // Бинарный файл строк не несёт: итога у такой группы нет, чтобы не рисовать «+0».
    files: [{ path: 'logo.png', status: 'A', add: 0, del: 0, binary: true, group: 'work' }],
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
  const { wrapper, flushPromises } = await mountCodeView(t, { api });
  await wrapper.get('button[title^="Гит:"]').trigger('click');
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
  assert.equal(wrapper.get('.diffstat').attributes('title'), 'добавлено строк: 25, удалено строк: 6');
  // Счётчик файлов рядом с заголовком итогом строк не подменяется.
  assert.deepEqual(groupHeads(wrapper).map((head) => head.count), ['2', '1']);
});

test('чистое рабочее дерево при непустом индексе показывает диф, а не «изменений нет»', async (t) => {
  // Всё лежит в индексе (обычное состояние перед коммитом): `files` пуст, и оверлей,
  // завязанный на одну эту группу, закрывал бы существующий диф собой.
  const api = {
    async get(url) {
      if (url === '/api/projects') return { projects: [{ id: 'demo', repos: ['/demo'] }] };
      if (url === '/api/code/demo/repos') {
        return { repos: [{ key: 'demo', dir: '/demo', trees: [mainTree('/demo')] }] };
      }
      if (url.includes('/ls?')) return { entries: [] };
      if (url.includes('/git?')) {
        return {
          branch: 'master',
          staged: [{ path: 'src/jobResult.ts', status: 'M', add: 23, del: 6, oldContent: 'head', newContent: 'index' }],
          files: [],
          log: [],
        };
      }
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const { wrapper, flushPromises, monacoState } = await mountCodeView(t, { api });
  await wrapper.get('button[title^="Гит:"]').trigger('click');
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
      if (url === '/api/projects') return { projects: [{ id: 'demo', repos: ['/demo'] }] };
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
async function mountGitPanel(t, gitPayload, { branch = 'main', post = null } = {}) {
  const api = {
    post,
    async get(url) {
      if (url === '/api/projects') return { projects: [{ id: 'demo', repos: ['/demo'] }] };
      if (url === '/api/code/demo/repos') {
        return { repos: [{ key: 'demo', dir: '/demo', trees: [mainTree('/demo', branch)] }] };
      }
      if (url.includes('/ls?')) return { entries: [] };
      if (url.includes('/git?')) return { staged: [], files: [], log: [], ...gitPayload };
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const mounted = await mountCodeView(t, { api });

  await mounted.wrapper.get('button[title^="Гит:"]').trigger('click');
  await settle(mounted.flushPromises);

  return mounted;
}

test('оба переключателя живут в шапке и не дублируются внутри панели', async (t) => {
  const api = {
    async get(url) {
      if (url === '/api/projects') return { projects: [{ id: 'demo', repos: ['/demo'] }] };
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

test('композер отдаёт поле ввода целой строке, а кнопки — своей', async (t) => {
  const { wrapper } = await mountGitPanel(t, {
    branch: 'main',
    tracking: { detached: false, upstream: 'origin/main', ahead: 0, behind: 0 },
  });

  // Поле — прямой потомок композера: деля строку с тремя кнопками, в доке оно
  // схлопывалось до двух букв, и набрать название коммита было негде.
  assert.equal(wrapper.get('.git-compose > textarea.commit-message').exists(), true);
  // Одна строка — только стартовый рост: `rows="1"` держит пустое поле в ритме кнопок.
  assert.equal(wrapper.get('textarea.commit-message').attributes('rows'), '1');
  assert.deepEqual(
    wrapper.findAll('.git-compose-actions > button').map((node) => node.classes()[0]),
    ['generate-commit', 'commit-action', 'push-action'],
  );
  assert.equal(wrapper.find('.git-compose-actions input').exists(), false);
  assert.equal(wrapper.find('.git-compose-actions textarea').exists(), false);
});

test('Enter набирает тело сообщения, а коммит уходит по Ctrl+Enter', async (t) => {
  const posts = [];
  const staged = { path: 'src/a.js', status: 'M', add: 1, del: 0 };
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
  await field.setValue('Кокпит: правка');

  // Голый Enter принадлежит тексту: иначе тело сообщения набрать нечем.
  await field.trigger('keydown', { key: 'Enter' });
  await settle(flushPromises);
  assert.deepEqual(posts, []);

  await field.trigger('keydown', { key: 'Enter', ctrlKey: true });
  await settle(flushPromises);
  assert.equal(posts.length, 1);
  assert.match(posts[0].url, /\/api\/code\/demo\/commit\?/);
  assert.deepEqual(posts[0].body, { message: 'Кокпит: правка' });
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
  // кокпита шапка устаревает, и промолчать здесь значило бы соврать.
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
  assert.match(styles, /padding-left:\s*calc\(var\(--tree-lead\)\s*\+\s*var\(--depth,\s*0\)\s*\*\s*var\(--tree-step\)\)/);
  assert.match(styles, /background-image:\s*repeating-linear-gradient\(to right, var\(--tree-guide\)/);
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
