import assert from 'node:assert/strict';
import test from 'node:test';

import { makeDraft } from '../fixtures/routes-editor.mjs';
import { compileModule, compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

test('RE-G3-01: preview показывает точный текст, блоки, пробелы контекста и устаревание',
  async (t) => {
    const browser = await installUiBrowser(t, 'http://grigdesk.test/#/routes');
    const Component = await compileVue(webFile('src/views/routes/RoutePromptPreview.vue'));
    const { mount } = await import(
      '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
    );
    const result = { text: 'Точный текст движка.\n',
      includedBlocks: ['prompts/build.base.md'],
      excludedBlocks: ['prompts/build.audit.md'],
      issues: [{ code: 'missing_context', path: '/context/task',
        message: 'Не хватает task' }] };
    const wrapper = mount(Component, { attachTo: browser.document.querySelector('#mount'),
      props: { result, stale: true, busy: false } });
    t.after(() => wrapper.unmount());
    assert.match(wrapper.text(), /Точный текст движка/);
    assert.match(wrapper.text(), /prompts\/build.base.md/);
    assert.match(wrapper.text(), /prompts\/build.audit.md/);
    assert.match(wrapper.text(), /Не хватает task/);
    assert.match(wrapper.text(), /устарел/i);
  });

test('RE-G3-01: правка во время запроса не выдаёт старый preview за новую ревизию',
  async () => {
    const { createPinia, setActivePinia } = await import(
      '../../web/node_modules/pinia/dist/pinia.mjs'
    );
    const actions = await compileModule(webFile('src/actions/routes/index.ts'));
    assert.equal(typeof actions.previewRoutePrompt, 'function');
    setActivePinia(createPinia());
    const store = actions.useRoutesStore();
    const draft = makeDraft();
    store.opened = { profile: 'sample', draftId: draft.id, readOnly: false };
    store.serverSnapshot = structuredClone(draft);
    store.localDocument = structuredClone(draft);
    let complete;
    actions.configureRoutesRuntime(store, { api: {
      previewDraft: async () => new Promise((resolve) => { complete = resolve; }),
    } });
    const pending = actions.previewRoutePrompt({ scope: 'route', routeId: 'quick',
      nodeId: 'build', context: { task: { kind: 'audit' } } });
    actions.applyLocalChange((local) => { local.title = 'Новее запроса'; });
    complete({ draftRevision: 1, text: 'Старый точный текст',
      includedBlocks: [], excludedBlocks: [], issues: [] });
    await pending;
    assert.equal(store.promptPreview.result.text, 'Старый точный текст');
    assert.equal(store.promptPreview.draftRevision, 1);
    assert.equal(store.promptPreview.stale, true);
    actions.cancelDraftSave();
  });
