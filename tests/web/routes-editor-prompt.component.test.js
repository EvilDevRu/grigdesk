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

test('RE-E5-04: заготовка копируется по значению; неизвестный kind не превращается в agent',
  async (t) => {
    const templates = [
      { id: 'writer', kind: 'agent', label: 'Автор', prompt: 'Заготовка v1.\n' },
      { id: 'mystery', kind: 'unknown', label: 'Иной тип', prompt: 'Не применять.\n' },
    ];
    const { wrapper, getDocument, flushPromises } = await fixture(t, makeDraft(), templates);
    await wrapper.find('[data-test="template-select"]').setValue('writer');
    await wrapper.find('[data-test="copy-template"]').trigger('click');
    await flushPromises();
    const afterCopy = getDocument();
    const file = afterCopy.routes.quick.route.nodes[0].prompt.blocks[0].file;
    assert.equal(afterCopy.routes.quick.prompts[file], 'Заготовка v1.\n');
    templates[0].prompt = 'Заготовка v2.\n';
    await wrapper.setProps({ templates: [...templates] });
    assert.equal(getDocument().routes.quick.prompts[file], 'Заготовка v1.\n');
    await wrapper.find('[data-test="template-select"]').setValue('mystery');
    assert.match(wrapper.text(), /тип.*не поддерживается/i);
    assert.equal(getDocument().routes.quick.route.nodes[0].executor, 'agent');
    assert.equal(getDocument().routes.quick.prompts[file], 'Заготовка v1.\n');
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

test('RE-E5-07: обновление из заготовки показывает diff и меняет только показанный текст',
  async (t) => {
    const draft = makeDraft();
    const originalPolicy = structuredClone(draft.routes.quick.route.nodes[0].policy);
    const untouched = draft.routes.quick.prompts['prompts/build.audit.md'];
    const templates = [{ id: 'writer', kind: 'agent', label: 'Автор',
      prompt: 'Новая версия шаблона.\n' }];
    const { wrapper, getDocument, flushPromises } = await fixture(t, draft, templates);
    await wrapper.find('[data-test="template-select"]').setValue('writer');
    await wrapper.find('[data-test="update-template"]').trigger('click');
    assert.match(wrapper.find('[data-test="template-diff"]').text(),
      /Создай проверяемый результат/);
    assert.match(wrapper.find('[data-test="template-diff"]').text(),
      /Новая версия шаблона/);
    await wrapper.find('[data-test="cancel-template-update"]').trigger('click');
    assert.equal(getDocument().routes.quick.prompts['prompts/build.base.md'],
      'Создай проверяемый результат.\n');
    await wrapper.find('[data-test="update-template"]').trigger('click');
    await wrapper.find('[data-test="apply-template-update"]').trigger('click');
    await flushPromises();
    assert.equal(getDocument().routes.quick.prompts['prompts/build.base.md'],
      'Новая версия шаблона.\n');
    assert.equal(getDocument().routes.quick.prompts['prompts/build.audit.md'], untouched);
    assert.deepEqual(getDocument().routes.quick.route.nodes[0].policy, originalPolicy);
  });

test('RE-E6-01: путь проблемы выбирает конкретный блок инструкции', async (t) => {
  const { wrapper } = await fixture(t, makeDraft(), [],
    '/routes/quick/route/nodes/0/prompt/blocks/1');
  assert.equal(wrapper.find('textarea').element.value,
    'Для аудита перечисли найденные риски.\n');
});
