import assert from 'node:assert/strict';
import test from 'node:test';

import { makeAgentNode, makeDraft } from '../fixtures/routes-editor.mjs';
import { compileModule, compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

const UI_STUB = `
import { defineComponent, h } from 'vue';
export const UiButton = defineComponent({ emits: ['click'], setup(_, { emit, slots, attrs }) {
  return () => h('button', { ...attrs, onClick: () => emit('click') }, slots.default?.());
} });
export const UiInput = defineComponent({ props: ['modelValue'], emits: ['update:modelValue'],
  setup(props, { emit, attrs }) { return () => h('input', { ...attrs, value: props.modelValue,
    onInput: (event) => emit('update:modelValue', event.target.value) }); } });
export const UiSelect = defineComponent({ props: ['modelValue'], emits: ['update:modelValue'],
  setup(props, { emit, attrs, slots }) { return () => h('select', { ...attrs,
    value: props.modelValue,
    onChange: (event) => emit('update:modelValue', event.target.value) }, slots.default?.()); } });
`;
const MARKDOWN_STUB = `
import { defineComponent, h } from 'vue';
export default defineComponent({ props: ['modelValue'], emits: ['update:modelValue', 'save', 'blur'],
  setup(props, { emit }) {
    return () => h('textarea', { value: props.modelValue,
      onInput: (event) => emit('update:modelValue', event.target.value),
      onBlur: () => emit('blur') });
  } });
`;

async function fixture(t, initial = makeDraft(), templates = [], focusPath = '') {
  const browser = await installUiBrowser(t, 'http://grigdesk.test/#/routes');
  const Component = await compileVue(webFile('src/views/routes/RoutePromptEditor.vue'), {
    stubs: {
      '../../ui': (UI_STUB) +
        "\nexport { vTooltip } from \"./src/services/tooltipDirective.ts\";",
      './RouteMarkdownInput.vue': MARKDOWN_STUB,
    },
  });
  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  let document = initial;
  const changes = [];
  let endedGroups = 0;
  const wrapper = mount(Component, {
    attachTo: browser.document.querySelector('#mount'),
    props: {
      document, routeId: 'quick', nodeId: 'build', templates, focusPath,
      'onChange': (change) => {
        changes.push(change);
        document = { ...document, routes: { ...document.routes,
          [change.routeId]: change.bundle } };
        void wrapper.setProps({ document });
      },
      'onEndHistoryGroup': () => { endedGroups += 1; },
    },
  });
  t.after(() => wrapper.unmount());
  await flushPromises();
  return { wrapper, getDocument: () => document, getChanges: () => changes,
    getEndedGroups: () => endedGroups, flushPromises };
}

test('RE-F7-01: форма инструкции bootstrap меняет только bootstrapPrompts', async (t) => {
  const browser = await installUiBrowser(t, 'http://grigdesk.test/#/routes');
  const Component = await compileVue(webFile('src/views/routes/RoutePromptEditor.vue'), {
    stubs: { '../../ui': (UI_STUB) +
      "\nexport { vTooltip } from \"./src/services/tooltipDirective.ts\";",
      './RouteMarkdownInput.vue': MARKDOWN_STUB },
  });
  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  let document = makeDraft();
  const originalRoutePrompt = document.routes.quick.prompts['prompts/build.base.md'];
  const wrapper = mount(Component, { attachTo: browser.document.querySelector('#mount'),
    props: { document, routeId: '', nodeId: 'scout', scope: 'bootstrap',
      onChange: (value) => { document = { ...document,
        bootstrap: value.bundle.route, bootstrapPrompts: value.bundle.prompts };
      void wrapper.setProps({ document }); },
    } });
  t.after(() => wrapper.unmount());
  await wrapper.find('textarea').setValue('Новая разведка.\n');
  await flushPromises();
  assert.equal(document.bootstrapPrompts['bootstrap/prompts/scout.base.md'],
    'Новая разведка.\n');
  assert.equal(document.routes.quick.prompts['prompts/build.base.md'], originalRoutePrompt);
});

test('RE-F6-04: один набор текста получает общий historyGroup и закрывается по blur',
  async (t) => {
    const { wrapper, getChanges, getEndedGroups } = await fixture(t);
    const input = wrapper.find('textarea');
    await input.setValue('П');
    await input.setValue('Пр');
    assert.deepEqual(getChanges().map((change) => change.historyGroup), [
      'prompt:quick:prompts/build.base.md', 'prompt:quick:prompts/build.base.md',
    ]);
    await input.trigger('blur');
    assert.equal(getEndedGroups(), 1);
  });

test('RE-E5-01: текст и порядок блоков меняют только выбранный маршрут', async (t) => {
  const { wrapper, getDocument, flushPromises } = await fixture(t);
  const originalAudit = getDocument().routes.quick.prompts['prompts/build.audit.md'];
  const textarea = wrapper.find('textarea');
  assert.ok(textarea.exists(), 'у выбранного блока должно быть поле Markdown');
  await textarea.setValue('# Новая инструкция\n');
  await flushPromises();
  assert.equal(getDocument().routes.quick.prompts['prompts/build.base.md'],
    '# Новая инструкция\n');
  assert.equal(getDocument().routes.quick.prompts['prompts/build.audit.md'], originalAudit);
  assert.match(wrapper.text(), /Новая инструкция/);
  await wrapper.find('[data-test="move-down-0"]').trigger('click');
  await flushPromises();
  assert.deepEqual(getDocument().routes.quick.route.nodes[0].prompt.blocks.map((block) =>
    block.file), ['prompts/build.audit.md', 'prompts/build.base.md']);
});

test('RE-E5-02: общий блок показывает потребителей и копируется только выбранному узлу',
  async (t) => {
    const draft = makeDraft();
    draft.routes.quick.route.nodes.push(makeAgentNode({
      id: 'review', promptFile: 'prompts/build.base.md',
    }));
    const { wrapper, getDocument, flushPromises } = await fixture(t, draft);
    assert.match(wrapper.text(), /Используют: build, review/);
    await wrapper.find('[data-test="copy-shared-block"]').trigger('click');
    await flushPromises();
    const nodes = getDocument().routes.quick.route.nodes;
    const buildFile = nodes.find((node) => node.id === 'build').prompt.blocks[0].file;
    const reviewFile = nodes.find((node) => node.id === 'review').prompt.blocks[0].file;
    assert.notEqual(buildFile, reviewFile);
    assert.equal(reviewFile, 'prompts/build.base.md');
    await wrapper.find('textarea').setValue('Отдельная инструкция.\n');
    await flushPromises();
    assert.equal(getDocument().routes.quick.prompts[buildFile], 'Отдельная инструкция.\n');
    assert.equal(getDocument().routes.quick.prompts[reviewFile],
      'Создай проверяемый результат.\n');
  });

test('RE-E5-03: условие сохраняет false, 0 и null, requiredContext остаётся отдельным',
  async (t) => {
    const { wrapper, getDocument, flushPromises } = await fixture(t);
    const getPrompt = () => getDocument().routes.quick.route.nodes[0].prompt;
    await wrapper.find('[data-test="when-context"]').setValue('task.flag');
    await wrapper.find('[data-test="when-type"]').setValue('boolean');
    await wrapper.find('[data-test="when-value"]').setValue('false');
    await flushPromises();
    assert.deepEqual(getPrompt().blocks[0].when,
      { context: 'task.flag', equals: false });

    await wrapper.find('[data-test="when-type"]').setValue('number');
    await wrapper.find('[data-test="when-value"]').setValue('0');
    await flushPromises();
    assert.deepEqual(getPrompt().blocks[0].when,
      { context: 'task.flag', equals: 0 });

    await wrapper.find('[data-test="when-type"]').setValue('null');
    await flushPromises();
    assert.deepEqual(getPrompt().blocks[0].when,
      { context: 'task.flag', equals: null });
    await wrapper.find('[data-test="required-context"]').setValue('task, routeCatalog');
    await flushPromises();
    assert.deepEqual(getPrompt().requiredContext, ['task', 'routeCatalog']);
    assert.deepEqual(getPrompt().blocks[0].when,
      { context: 'task.flag', equals: null });
    await wrapper.find('[data-test="when-context"]').setValue('task.other');
    await flushPromises();
    assert.deepEqual(getPrompt().blocks[0].when,
      { context: 'task.other', equals: null });
  });

test('RE-E5-05: уход при dirty требует подтверждения, cancel сохраняет страницу', async () => {
  const { confirmDirtyRouteExit } = await compileModule(
    webFile('src/actions/routes/navigation.ts')
  );
  let asked = 0;
  const cancel = async () => { asked += 1; return false; };
  assert.equal(await confirmDirtyRouteExit(true, true, cancel), false);
  assert.equal(asked, 1);
  assert.equal(await confirmDirtyRouteExit(true, false, cancel), true);
  assert.equal(await confirmDirtyRouteExit(false, true, cancel), true);
  assert.equal(asked, 1);
});

test('RE-E6-01: путь проблемы выбирает конкретный блок инструкции', async (t) => {
  const { wrapper } = await fixture(t, makeDraft(), [],
    '/routes/quick/route/nodes/0/prompt/blocks/1');
  assert.equal(wrapper.find('textarea').element.value,
    'Для аудита перечисли найденные риски.\n');
});


test('RET-PROMPT: инструкция не предлагает заготовки', async (t) => {
  for (const scope of ['route', 'bootstrap']) {
    await t.test(scope, async (t) => {
      const browser = await installUiBrowser(t, 'http://grigdesk.test/#/routes');
      const Component = await compileVue(webFile('src/views/routes/RoutePromptEditor.vue'), {
        stubs: {
          '../../ui': UI_STUB +
            '\nexport { vTooltip } from "./src/services/tooltipDirective.ts";',
          './RouteMarkdownInput.vue': MARKDOWN_STUB,
        },
      });
      const { mount, flushPromises } = await import(
        '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
      );
      const document = makeDraft();
      const wrapper = mount(Component, {
        attachTo: browser.document.querySelector('#mount'),
        props: {
          document,
          scope,
          routeId: scope === 'route' ? 'quick' : '',
          nodeId: scope === 'route' ? 'build' : 'scout',
          templates: [{
            id: 'writer',
            kind: 'agent',
            label: 'Автор',
            prompt: 'Заготовка.\n',
          }],
        },
      });

      t.after(() => wrapper.unmount());
      await flushPromises();

      const expectedText = scope === 'route'
        ? document.routes.quick.prompts['prompts/build.base.md']
        : document.bootstrapPrompts['bootstrap/prompts/scout.base.md'];

      assert.equal(wrapper.find('textarea').exists(), true);
      assert.equal(wrapper.find('textarea').element.value, expectedText);
      assert.doesNotMatch(wrapper.text(), /Заготовка из библиотеки/);

      for (const control of ['template-select', 'copy-template', 'update-template', 'template-diff']) {
        assert.equal(wrapper.find(`[data-test="${control}"]`).exists(), false, `${scope}: ${control}`);
      }
    });
  }
});
