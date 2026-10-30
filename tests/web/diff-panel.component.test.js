import assert from 'node:assert/strict';
import test from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

const API_STUB = `
  export const api = { get: (url) => globalThis.__diffPanel.get(url) };
  export const failureText = (error) => error.message;
`;
const MONACO_STUB = `
  export const READONLY_OPTS = {};
  export const langOf = () => 'text';
  export const monaco = { editor: {
    createDiffEditor(_host, options) {
      const instance = {
        options,
        disposed: false,
        model: null,
        setModel(model) {
          this.model = model;
        },
        updateOptions(options) {
          Object.assign(this.options, options);
        },
        dispose() {
          this.disposed = true;
        },
      };
      globalThis.__diffPanel.editors.push(instance);
      return instance;
    },
    createModel(text) {
      const model = {
        text,
        disposed: false,
        dispose() {
          this.disposed = true;
        },
      };
      globalThis.__diffPanel.models.push(model);
      return model;
    },
  }};
`;

/**
 * Два репозитория имеют одинаковый путь, чтобы проверка выбора не могла пройти
 * по одному имени файла, потеряв принадлежность исходной рабочей копии.
 */
function snapshot() {
  const file = {
    path: 'app/Domain/Service.php',
    status: 'M',
    add: 4,
    del: 2,
    oldContent: 'before',
    newContent: 'after',
  };

  return {
    repos: [
      {
        name: 'backend',
        branch: 'task-demo',
        files: [file, {
          ...file,
          path: 'app/Domain/User.php',
        }],
      },
      {
        name: 'worker-tools',
        branch: 'task-worker',
        files: [{
          ...file,
          newContent: 'worker change',
        }],
      },
    ],
  };
}

/**
 * Панель получает настоящий UI и записывающие порты API и Monaco.
 * Проверяем выбор, модели и lifecycle без чтения рабочих репозиториев человека.
 */
async function mountPanel(t, reply = snapshot()) {
  await installUiBrowser(t);

  const harness = {
    reply,
    editors: [],
    models: [],
    calls: [],
    async get(url) {
      this.calls.push(url);

      return structuredClone(this.reply);
    },
  };

  globalThis.__diffPanel = harness;

  const component = await compileVue(webFile('src/views/diff/DiffPanel.vue'), {
    stubs: {
      '../../shared/apiClient.ts': API_STUB,
      '../../shared/monaco.ts': MONACO_STUB,
    },
  });
  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const wrapper = mount(component, { props: { taskId: '42' } });

  t.after(() => {
    wrapper.unmount();
    delete globalThis.__diffPanel;
  });
  await flushPromises();

  return {
    wrapper,
    harness,
    flushPromises,
  };
}

test('диф различает репозитории с одинаковыми путями и показывает общую сводку', async (t) => {
  const { wrapper, harness, flushPromises } = await mountPanel(t);

  assert.deepEqual(wrapper.findAll('.grphead__identity strong').map((item) => item.text()),
    ['Бэкенд', 'worker-tools']);
  assert.match(wrapper.get('.diff-summary').text(), /3\+12−6/u);
  assert.equal(harness.editors.length, 1);
  assert.equal(harness.editors[0].model.modified.text, 'after');

  await wrapper.get('[data-diff-file="worker-tools:app/Domain/Service.php"]').trigger('click');
  await flushPromises();

  assert.equal(wrapper.get('.diff-context__repo').text(), 'worker-tools');
  assert.equal(wrapper.get('.diff-context__branch').text(), 'task-worker');
  assert.equal(harness.editors[0].model.modified.text, 'worker change');
  assert.equal(harness.editors.length, 1);
  assert.equal(wrapper.get('.split').classes().includes('files-collapsed'), true);
});

test('поиск раскрывает совпадения и сохраняет выбранный файл и ручное сворачивание', async (t) => {
  const { wrapper, harness } = await mountPanel(t);
  const model = harness.editors[0].model;

  await wrapper.get('.dir').trigger('click');
  assert.equal(wrapper.find('[data-diff-file="backend:app/Domain/Service.php"]').exists(), false);
  await wrapper.get('input[type="search"]').setValue('Service.php');
  assert.equal(wrapper.findAll('.frow').length, 2);
  assert.equal(wrapper.get('.dir').attributes('aria-expanded'), 'true');
  assert.equal(wrapper.get('.dir').attributes('disabled'), '');
  assert.equal(harness.editors[0].model === model, true);

  await wrapper.get('input[type="search"]').setValue('missing');
  assert.match(wrapper.get('.diff-search-empty').text(), /Подходящих файлов нет/u);
  await wrapper.get('.diff-search-empty button').trigger('click');
  assert.equal(wrapper.find('[data-diff-file="backend:app/Domain/Service.php"]').exists(), false);
  assert.equal(harness.editors[0].model === model, true);
});

test('раскладка и обновление сохраняют выбор без пересоздания редактора', async (t) => {
  const { wrapper, harness, flushPromises } = await mountPanel(t);

  await wrapper.get('[data-diff-file="worker-tools:app/Domain/Service.php"]').trigger('click');
  await wrapper.get('[data-option-value="inline"]').trigger('click');
  assert.equal(harness.editors[0].options.renderSideBySide, false);
  assert.equal(localStorage.getItem('grigdesk-diff-side'), '0');

  harness.reply.repos[1].files[0].newContent = 'updated';
  await wrapper.get('[aria-label="Обновить диф"]').trigger('click');
  await flushPromises();

  assert.equal(harness.editors.length, 1);
  assert.equal(harness.editors[0].model.modified.text, 'updated');
  assert.equal(wrapper.get('.diff-context__repo').text(), 'worker-tools');
  assert.deepEqual(harness.calls, ['/api/tasks/42/diff', '/api/tasks/42/diff']);
});

test('бинарный файл объясняет отсутствие превью и не меняет выбранный режим', async (t) => {
  const reply = snapshot();

  reply.repos[1].files[0].binary = true;

  const { wrapper, flushPromises } = await mountPanel(t, reply);

  await wrapper.get('[data-diff-file="worker-tools:app/Domain/Service.php"]').trigger('click');
  await flushPromises();
  assert.match(wrapper.get('.state--file').text(), /Бинарный файл/u);
  assert.equal(wrapper.get('[data-option-value="split"]').attributes('disabled'), '');

  await wrapper.get('[data-diff-file="backend:app/Domain/Service.php"]').trigger('click');
  assert.equal(wrapper.find('.state--file').exists(), false);
  assert.equal(wrapper.get('[data-option-value="split"]').attributes('disabled'), undefined);
});

test('повтор после ошибки создаёт редактор на новом хосте и освобождает прежние модели', async (t) => {
  const { wrapper, harness, flushPromises } = await mountPanel(t);
  const previous = harness.editors[0];
  const previousModels = [previous.model.original, previous.model.modified];

  harness.reply = { repos: 'bad' };
  await wrapper.get('[aria-label="Обновить диф"]').trigger('click');
  await flushPromises();

  assert.match(wrapper.get('.state').text(), /Не удалось загрузить изменения/u);
  assert.equal(previous.disposed, true);
  assert.deepEqual(previousModels.map((model) => model.disposed), [true, true]);

  harness.reply = snapshot();
  await wrapper.get('.state button').trigger('click');
  await flushPromises();
  assert.equal(harness.editors.length, 2);
  assert.equal(harness.editors[1].model.modified.text, 'after');
});
