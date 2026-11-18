import assert from 'node:assert/strict';

import { after, before, test } from 'node:test';

import { drain } from './helpers/chat-load.js';

import { compileVue, webFile } from './helpers/compile-vue.js';

import { installUiBrowser } from './helpers/ui-components.js';

let vue;

let mount;

let Dialog;

before(async () => {
  await installUiBrowser({ after: (cleanup) => after(cleanup) });

  vue = await import('../../web/node_modules/vue/index.mjs');

  ({ mount } = await import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'));

  globalThis.__createConfirm = true;
  globalThis.__createSaveOk = true;
  globalThis.__createCalls = [];

  const store = vue.reactive({
    draft: null,
    opened: null,
    conflict: null,
    checks: {},
    dependencies: null,
    setDraft(value) {
      this.draft = value;
    },
    setOpened(value) {
      this.opened = value;
    },
    setConflict(value) {
      this.conflict = value;
    },
  });

  globalThis.__createStore = store;

  const stubs = {
    '../../ui': `
      export const t = (key) => key;
      export const messageRef = (key) => key;
      export const confirmDialog = async () => globalThis.__createConfirm !== false;
      export const UiButton = { template: '<button><slot /></button>' };
      export const UiDialog = {
        props: ['open', 'busy'],
        emits: ['update:open'],
        template: '<div data-dialog>'
          + '<button data-close @click="$emit(\\'update:open\\', false)">x</button>'
          + '<slot /><footer data-dialog-footer><slot name="footer" /></footer></div>',
      };
    `,
    'vue-router': 'export const useRouter = () => ({ push: async () => {} });',
    '../../actions/projects': `
      export const useProjectsStore = () => globalThis.__createStore;
      export const checkRepositories = async () => {};
      export const saveProject = async (id, draft, options) => {
        globalThis.__createCalls.push({ id, draft, options });

        if (globalThis.__createSaveOk === false) {
          return { ok: false, error: 'exists', fieldErrors: [] };
        }

        globalThis.__createStore.opened = { id: draft.id || 'new-proj' };

        return { ok: true, error: '', fieldErrors: [] };
      };
    `,
    './ProjectFormScreen.vue': `
      export default {
        props: ['saveFailure', 'dirty', 'draftPresent', 'formId'],
        emits: ['save'],
        data: () => ({ canSave: true, saveStatus: '' }),
        template: '<form :id="formId" data-screen :data-save-failure="saveFailure"'
          + ' @submit.prevent="$emit(\\'save\\')" />',
      };
    `,
  };

  Dialog = await compileVue(webFile('src/views/projects/ProjectCreateDialog.vue'), { stubs });
});

/**
 * Монтирование сразу открытым: watch инициализации немедленный, как у владельца,
 * который показывает окно только после клика по плюсу.
 */
function openDialog() {
  return mount(Dialog, { props: { open: true } });
}

test('CREATE-DIALOG-INIT: открытие начинает пустой черновик создания', async () => {
  const store = globalThis.__createStore;

  store.setDraft(null);
  openDialog();
  await drain();

  assert.ok(store.draft);
  assert.equal(store.draft.id, '');
  assert.equal(store.draft.title, '');
});

test('CREATE-DIALOG-SAVE: успех закрывает окно, отдаёт id и очищает черновик', async () => {
  const store = globalThis.__createStore;
  const wrapper = openDialog();

  await drain();
  store.draft.id = 'alpha';

  await wrapper.find('form').trigger('submit');
  await drain();

  assert.equal(globalThis.__createCalls.at(-1).id, null);
  assert.deepEqual(wrapper.emitted('saved').at(-1), ['alpha']);
  assert.deepEqual(wrapper.emitted('update:open').at(-1), [false]);
  assert.equal(store.draft, null);
});

test('CREATE-DIALOG-EXISTS: отказ «проект уже есть» остаётся в окне с подсказкой', async () => {
  const store = globalThis.__createStore;
  const wrapper = openDialog();

  await drain();
  store.draft.id = 'alpha';
  globalThis.__createSaveOk = false;

  await wrapper.find('form').trigger('submit');
  await drain();

  globalThis.__createSaveOk = true;

  assert.equal(wrapper.find('[data-screen]').attributes('data-save-failure'), 'exists');
  assert.equal(wrapper.emitted('update:open'), undefined);
  assert.ok(store.draft);
});

test('CREATE-DIALOG-CLOSE-DIRTY: закрытие с правками спрашивает, без правок — нет', async () => {
  const store = globalThis.__createStore;
  const wrapper = openDialog();

  await drain();
  store.draft.title = 'черновик';
  globalThis.__createConfirm = false;

  await wrapper.find('[data-close]').trigger('click');
  await drain();

  assert.equal(wrapper.emitted('update:open'), undefined);
  assert.ok(store.draft);

  globalThis.__createConfirm = true;

  await wrapper.find('[data-close]').trigger('click');
  await drain();

  assert.deepEqual(wrapper.emitted('update:open').at(-1), [false]);
  assert.equal(store.draft, null);
});

test('CREATE-DIALOG-CANCEL: отмена закрывает окно с защитой изменений в дополнительных полях', async () => {
  const store = globalThis.__createStore;
  const wrapper = openDialog();

  await drain();
  store.draft.description = 'Черновик описания';
  globalThis.__createConfirm = false;

  try {
    await wrapper.find('[data-role="project-cancel"]').trigger('click');
    await drain();

    assert.equal(wrapper.emitted('update:open'), undefined);
    assert.equal(store.draft.description, 'Черновик описания');
  } finally {
    globalThis.__createConfirm = true;
  }

  await wrapper.find('[data-close]').trigger('click');
  await drain();

  assert.deepEqual(wrapper.emitted('update:open').at(-1), [false]);
  assert.equal(store.draft, null);
});

test('CREATE-DIALOG-FOOTER: кнопка в слоте связана с нативной формой', async (t) => {
  const wrapper = openDialog();

  t.after(() => wrapper.unmount());
  await drain();

  const footer = wrapper.get('[data-dialog-footer]');
  const save = footer.get('[data-role="project-save"]');

  assert.ok(footer.find('[data-role="project-cancel"]').exists());
  assert.equal(save.attributes('variant'), 'solid');
  assert.equal(save.attributes('tone'), 'accent');
  assert.equal(save.element.type, 'submit');
  assert.equal(save.attributes('form'), wrapper.get('form').attributes('id'));
});
