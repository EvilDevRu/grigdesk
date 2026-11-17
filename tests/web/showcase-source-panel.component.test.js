// Блок «О чём ролик»: черновик принадлежит человеку.
//
// Проверяется то, что легко потерять между ответами сервера: введённое пожелание и
// галочки переживают ответ списка и его обновление, чужая правка выбора не затирает
// тронутый черновик, сохранённый выбор вне видимого списка виден и снимается, а переход
// от умолчания к явным отметкам при скрытой истории спрашивает человека.
import assert from 'node:assert/strict';
import test from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

const PANEL = webFile('src/views/showcase/ShowcaseSourcePanel.vue');

const UI_STUB = `
export * from './src/ui.ts';
export { default as UiLoadingState } from './src/components/feedback/UiLoadingState.vue';
export { default as UiButton } from '${webFile('src/components/primitives/UiButton.vue')}';
export { default as UiInput } from '${webFile('src/components/primitives/UiInput.vue')}';
export { default as UiCheckbox } from '${webFile('src/components/primitives/UiCheckbox.vue')}';
export { default as UiSpinner } from '${webFile('src/components/primitives/UiSpinner.vue')}';
export { default as UiTextarea } from '${webFile('src/components/primitives/UiTextarea.vue')}';
export { default as UiField } from '${webFile('src/components/composites/UiField.vue')}';
export { default as UiInlineMessage } from '${webFile('src/components/feedback/UiInlineMessage.vue')}';
export const confirmDialog = async (text, options) => {
  globalThis.__showcaseSourceHarness.confirmations.push({ text, options });
  return globalThis.__showcaseSourceHarness.confirmed;
};
export { vTooltip } from "./src/services/tooltipDirective.ts";
`;

let compiledPanel = null;

function panelComponent() {
  compiledPanel ??= compileVue(PANEL, { stubs: {
    '../../ui': UI_STUB,
    '../../stores/tasks': `export const useTasksStore = () => ({
      load: async (id) => {
        const h = globalThis.__showcaseSourceHarness;
        h.asked = id;
        await h.load?.(id);
      },
      title: (id) => 'Задача ' + id,
    });`,
  } });

  return compiledPanel;
}

function project(overrides = {}) {
  return {
    id: 'project-1',
    revision: 3,
    ref: { kind: 'sandbox', id: '990001' },
    target: { status: 'ready' },
    scenes: [],
    source: null,
    ...overrides,
  };
}

/**
 * Панель монтируется с настоящими контролами и изолированным чтением задачи.
 * Вывод события проверяет сохранение введённого текста, а не детали реализации.
 */
async function mountPanel(t, props = {}, { confirmed = true } = {}) {
  const browser = await installUiBrowser(t, 'http://grigdesk.test/#/showcase');
  const harness = {
    confirmed,
    confirmations: [],
    applied: [],
    reloads: 0,
  };

  globalThis.__showcaseSourceHarness = harness;

  const Component = await panelComponent();
  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const wrapper = mount(Component, {
    attachTo: browser.document.querySelector('#mount'),
    props: {
      project: project(),
      busy: false,
      onApply: (source) => harness.applied.push(source),
      onReload: () => {
        harness.reloads += 1;
      },
      ...props,
    },
  });

  t.after(() => {
    wrapper.unmount();

    if (globalThis.__showcaseSourceHarness === harness) {
      delete globalThis.__showcaseSourceHarness;
    }
  });

  await flushPromises();

  return {
    wrapper,
    harness,
    flushPromises,
  };
}

function buttonByText(wrapper, text) {
  return wrapper.findAll('button').find((button) => button.text().includes(text));
}

async function apply(wrapper, flushPromises) {
  await wrapper.find('[data-testid="showcase-source-apply"]').trigger('click');
  await flushPromises();
}


test('задача и комментарий отправляются без git-полей', async (t) => {
  const { wrapper, harness, flushPromises } = await mountPanel(t);

  await wrapper.find('[data-testid="showcase-source-task"]').setValue('4920');
  await wrapper.find('textarea').setValue('  Показать фильтр  ');
  await apply(wrapper, flushPromises);
  assert.deepEqual(harness.applied, [{ taskId: '4920', note: 'Показать фильтр' }]);
});

test('пустой источник отправляется умолчанием', async (t) => {
  const { wrapper, harness, flushPromises } = await mountPanel(t);

  await apply(wrapper, flushPromises);
  assert.deepEqual(harness.applied, [null]);
});

test('чужая правка не стирает черновик и допускает возврат сохранённого', async (t) => {
  const { wrapper, flushPromises } = await mountPanel(t);

  await wrapper.find('textarea').setValue('Мой текст');
  await wrapper.setProps({ project: project({ revision: 4, source: { taskId: null, note: 'Чужой' } }) });
  assert.equal(wrapper.find('textarea').element.value, 'Мой текст');
  assert.equal(wrapper.find('[data-role="source-external"]').exists(), true);
  await buttonByText(wrapper, 'Вернуть сохранённый').trigger('click');
  await flushPromises();
  assert.equal(wrapper.find('textarea').element.value, 'Чужой');
});

test('смена ролика загружает его источник', async (t) => {
  const { wrapper } = await mountPanel(t);

  await wrapper.find('textarea').setValue('Мой текст');
  await wrapper.setProps({ project: project({ id: 'other', source: { taskId: '45', note: 'Другой' } }) });
  assert.equal(wrapper.find('textarea').element.value, 'Другой');
  assert.equal(wrapper.find('[data-testid="showcase-source-task"]').element.value, '45');
});

test('некорректный номер не запрашивает заголовок', async (t) => {
  const { wrapper, harness, flushPromises } = await mountPanel(t);

  await wrapper.find('[data-testid="showcase-source-task"]').setValue('abc');
  await wrapper.find('[data-testid="showcase-source-task"]').trigger('blur');
  await flushPromises();
  assert.equal(harness.asked, undefined);
});

test('корректный номер добирает заголовок через стор задач', async (t) => {
  const { wrapper, harness, flushPromises } = await mountPanel(t);

  await wrapper.find('[data-testid="showcase-source-task"]').setValue('4920');
  await wrapper.find('[data-testid="showcase-source-task"]').trigger('blur');
  await flushPromises();
  assert.equal(harness.asked, '4920');
  assert.match(wrapper.text(), /Задача 4920/u);
});

for (const outcome of ['success', 'error']) {
  test(`поздний ${outcome} заголовка прежней задачи не меняет текущую`, async (t) => {
    const { wrapper, harness, flushPromises } = await mountPanel(t);
    const old = Promise.withResolvers();

    harness.load = (id) => id === '111' ? old.promise : Promise.resolve();
    await wrapper.find('[data-testid="showcase-source-task"]').setValue('111');
    await wrapper.find('[data-testid="showcase-source-task"]').trigger('blur');
    await wrapper.find('[data-testid="showcase-source-task"]').setValue('222');
    await wrapper.find('[data-testid="showcase-source-task"]').trigger('blur');
    await flushPromises();
    assert.match(wrapper.text(), /Задача 222/u);

    if (outcome === 'error') {
      old.reject(new Error('Поздний отказ'));
    } else {
      old.resolve();
    }

    await flushPromises();
    assert.match(wrapper.text(), /Задача 222/u);
    assert.doesNotMatch(wrapper.text(), /Задача 111|[Нн]е удалось/u);
  });
}

test('смена ролика не принимает старый заголовок задачи', async (t) => {
  const { wrapper, harness, flushPromises } = await mountPanel(t);
  const old = Promise.withResolvers();

  harness.load = (id) => id === '111' ? old.promise : Promise.resolve();
  await wrapper.find('[data-testid="showcase-source-task"]').setValue('111');
  await wrapper.find('[data-testid="showcase-source-task"]').trigger('blur');
  await wrapper.setProps({ project: project({ id: 'other', source: { taskId: '222', note: '' } }) });
  await flushPromises();
  old.resolve();
  await flushPromises();
  assert.match(wrapper.text(), /Задача 222/u);
  assert.doesNotMatch(wrapper.text(), /Задача 111/u);
});

test('новый ввод убирает подпись прежней задачи до blur', async (t) => {
  const { wrapper, flushPromises } = await mountPanel(t);

  await wrapper.find('[data-testid="showcase-source-task"]').setValue('111');
  await wrapper.find('[data-testid="showcase-source-task"]').trigger('blur');
  await flushPromises();
  await wrapper.find('[data-testid="showcase-source-task"]').setValue('222');
  assert.doesNotMatch(wrapper.text(), /Задача 111/u);
});

test('собственная очистка источника не считается чужой правкой', async (t) => {
  const { wrapper, harness, flushPromises } = await mountPanel(t, {
    project: project({ source: { taskId: null, note: 'Прежний рассказ' } }),
  });

  await wrapper.find('textarea').setValue('');
  await apply(wrapper, flushPromises);
  assert.deepEqual(harness.applied, [null]);
  await wrapper.setProps({ project: project({ revision: 4, source: null }) });
  await flushPromises();
  assert.equal(wrapper.find('[data-role="source-external"]').exists(), false);
});
