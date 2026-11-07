import assert from 'node:assert/strict';
import test from 'node:test';

import { makeDraft } from '../fixtures/routes-editor.mjs';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

const UI = `
import { defineComponent, h } from 'vue';
export const UiButton = defineComponent({
  props: ['disabled'], emits: ['click'],
  setup(props, { attrs, emit, slots }) {
    return () => h('button', { ...attrs, disabled: props.disabled,
      onClick: () => emit('click') }, slots.default?.());
  },
});
export const UiTextarea = defineComponent({
  props: ['modelValue'], emits: ['update:modelValue'],
  setup(props, { attrs, emit }) {
    return () => h('textarea', { ...attrs, value: props.modelValue,
      onInput: (event) => emit('update:modelValue', event.target.value) });
  },
});
`;

test('RE-H4-01: подтверждение публикации получает фокус и возвращает его кнопке открытия',
  async (t) => {
    const browser = await installUiBrowser(t, 'http://grigdesk.test/#/routes');
    const document = browser.document;
    const opener = document.createElement('button');
    opener.textContent = 'Опубликовать';
    document.querySelector('#mount').append(opener);
    opener.focus();
    assert.ok(document.activeElement === opener);

    const Component = await compileVue(webFile('src/views/routes/RoutePublishDialog.vue'), {
      stubs: { '../../ui': (UI) +
        "\nexport { vTooltip } from \"./src/services/tooltipDirective.ts\";" },
    });
    const { mount } = await import(
      '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
    );
    const draft = makeDraft();
    const wrapper = mount(Component, {
      attachTo: document.querySelector('#mount'),
      props: { report: { draftId: draft.id, draftRevision: 1,
        currentCatalogHash: null, sourceMode: 'editor', sourceRevision: 1,
        capabilitiesHash: 'a'.repeat(64), changes: [] },
      canPublish: true },
    });
    t.after(() => wrapper.unmount());
    const dialog = wrapper.find('[role="dialog"]').element;
    assert.ok(document.activeElement === dialog,
      'после открытия клавиатура работает внутри подтверждения');
    assert.equal(dialog.getAttribute('aria-label'), 'Подтверждение публикации маршрутов');
    assert.equal(wrapper.find('textarea').attributes('id'), 'route-publication-comment');
    wrapper.unmount();
    assert.ok(document.activeElement === opener,
      'после закрытия фокус возвращается вызвавшей кнопке');
  });
