// Проверяет отображение расширенных изменений файлов в ленте шагов агента.
import assert from 'node:assert/strict';
import test from 'node:test';
import { compileVue, webFile } from './helpers/compile-vue.js';

process.env.NODE_ENV = 'test';

const STEP_LIST_PATH = webFile('src/views/chat/StepList.vue');

async function compileStepList() {
  return compileVue(STEP_LIST_PATH);
}

let browser;

async function mountSteps(t, steps) {
  if (!browser) {
    const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
    browser = new Window({ url: 'http://cockpit.test/#/chats' });
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      Node: browser.Node,
      Element: browser.Element,
      HTMLElement: browser.HTMLElement,
      SVGElement: browser.SVGElement,
      Event: browser.Event,
      CustomEvent: browser.CustomEvent,
    })) {
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    }
  }
  browser.document.body.innerHTML = '<div id="mount"></div>';
  const [{ mount }, StepList] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileStepList(),
  ]);
  const wrapper = mount(StepList, {
    attachTo: browser.document.querySelector('#mount'),
    props: { live: true, steps },
  });
  t.after(() => wrapper.unmount());
  return wrapper;
}

test('StepList показывает каждый файл и точные строки многофайлового unified diff', async (t) => {
  const wrapper = await mountSteps(t, [{
    k: 'tool',
    id: 'codex-file-change-1',
    name: 'Edit',
    title: 'Изменено файлов: 2',
    changes: [
      {
        path: 'src/config.js',
        kind: 'update',
        diff: [
          '@@ -1,4 +1,4 @@',
          " import { oldName } from './dep.js';",
          "-const mode = 'old';",
          '-const retries = 1;',
          "+const mode = 'new';",
          '+const retries = 3;',
          ' export { mode, retries };',
        ].join('\n'),
      },
      {
        path: 'src/ready.js',
        kind: 'add',
        diff: [
          '@@ -0,0 +1,2 @@',
          '+export const ready = true;',
          "+export const label = 'cockpit';",
        ].join('\n'),
      },
    ],
  }]);

  assert.equal(
    wrapper.find('.stat').exists(),
    true,
    'многофайловый changes должен дать общую статистику правки',
  );
  assert.equal(wrapper.get('.stat').text(), '+4 −2');
  await wrapper.get('.head').trigger('click');

  const changes = wrapper.findAll('.change');
  assert.equal(changes.length, 2, 'каждый файл должен иметь отдельный блок diff');
  assert.deepEqual(
    changes.map((change) => change.get('.path').text()),
    ['src/config.js', 'src/ready.js'],
  );
  assert.deepEqual(
    changes.flatMap((change) => change.findAll('.dcell.del').map((cell) => cell.text())),
    ["const mode = 'old';", 'const retries = 1;'],
  );
  assert.deepEqual(
    changes.flatMap((change) => change.findAll('.dcell.add').map((cell) => cell.text())),
    [
      "const mode = 'new';",
      'const retries = 3;',
      'export const ready = true;',
      "export const label = 'cockpit';",
    ],
  );
});

test('StepList сохраняет прежний контракт Claude diff.old/diff.new', async (t) => {
  const wrapper = await mountSteps(t, [{
    k: 'tool',
    id: 'claude-edit-1',
    name: 'Edit',
    title: 'src/legacy.js',
    sub: 'src/legacy.js',
    diff: {
      old: 'const value = 1;\nrun();',
      new: 'const value = 2;\nrun();',
    },
  }]);

  assert.equal(wrapper.get('.stat').text(), '+1 −1');
  await wrapper.get('.head').trigger('click');
  assert.equal(wrapper.findAll('.diff').length, 1);
  assert.deepEqual(
    wrapper.findAll('.dcell.del').map((cell) => cell.text()),
    ['const value = 1;'],
  );
  assert.deepEqual(
    wrapper.findAll('.dcell.add').map((cell) => cell.text()),
    ['const value = 2;'],
  );
});

test('StepList показывает точную ACP-пару Kimi внутри changes[]', async (t) => {
  const wrapper = await mountSteps(t, [{
    k: 'tool',
    id: 'kimi-edit-1',
    name: 'Edit',
    title: 'src/kimi.js',
    changes: [{
      path: 'src/kimi.js',
      kind: 'update',
      diff: {
        old: 'const value = 1;\nconst stable = true;',
        new: 'const value = 2;\nconst stable = true;',
      },
    }],
  }]);

  assert.equal(wrapper.get('.stat').text(), '+1 −1');
  await wrapper.get('.head').trigger('click');
  assert.equal(wrapper.get('.change .path').text(), 'src/kimi.js');
  assert.deepEqual(
    wrapper.findAll('.change .dcell.del').map((cell) => cell.text()),
    ['const value = 1;'],
  );
  assert.deepEqual(
    wrapper.findAll('.change .dcell.add').map((cell) => cell.text()),
    ['const value = 2;'],
  );
});

test('StepList читает сохранённый до нормализации add/delete Codex как файл целиком', async (t) => {
  const wrapper = await mountSteps(t, [{
    k: 'tool',
    id: 'codex-file-change-raw',
    name: 'Edit',
    title: '2 файлов',
    changes: [
      // Ленты до сентября 2026 хранят в `diff` созданного файла его текст без знаков строк.
      { path: 'make-report.py', kind: 'add', diff: 'import json\n\ndef main():\n    pass\n' },
      { path: 'legacy.py', kind: 'delete', diff: 'x = 1\n' },
    ],
  }]);

  assert.equal(wrapper.get('.stat').text(), '+4 −1');
  await wrapper.get('.head').trigger('click');
  assert.deepEqual(
    wrapper.findAll('.change .dcell.add').map((cell) => cell.text()),
    ['import json', '', 'def main():', 'pass'],
  );
  assert.deepEqual(
    wrapper.findAll('.change .dcell.del').map((cell) => cell.text()),
    ['x = 1'],
  );
  assert.equal(wrapper.findAll('.change .dcell.ctx').length, 0, 'у файла целиком нет контекста');
});

test('StepList показывает серверный разрыв patch строкой, а не склеивает половины', async (t) => {
  const wrapper = await mountSteps(t, [{
    k: 'tool',
    id: 'codex-file-change-cut',
    name: 'Edit',
    title: 'big.py',
    changes: [{
      path: 'big.py',
      kind: 'add',
      diff: '@@ -0,0 +1,300 @@\n+import json\n+head = 1\n… сокращено …\nail_tail = 2\n+tail = 3\n',
    }],
  }]);

  assert.equal(wrapper.get('.stat').text(), '+3 −0');
  await wrapper.get('.head').trigger('click');
  assert.deepEqual(
    wrapper.findAll('.change .drow').map((row) => row.get('.dcell:last-child').text()),
    ['import json', 'head = 1', '… сокращено …', 'tail = 3'],
  );
});
