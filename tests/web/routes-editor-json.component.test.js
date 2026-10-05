import assert from 'node:assert/strict';
import test from 'node:test';

import { makeDraft } from '../fixtures/routes-editor.mjs';
import { compileModule, compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

async function fixture(t) {
  await installUiBrowser(t, 'http://cockpit.test/#/routes');
  const { createPinia, setActivePinia } = await import(
    '../../web/node_modules/pinia/dist/pinia.mjs'
  );
  const actions = await compileModule(webFile('src/actions/routes/index.ts'));
  setActivePinia(createPinia());
  const store = actions.useRoutesStore();
  const draft = makeDraft();
  store.opened = { profile: 'sample', draftId: draft.id, readOnly: false };
  store.serverSnapshot = structuredClone(draft);
  store.localDocument = structuredClone(draft);
  return { actions, store, draft };
}

test('RE-G5-01: полный JSON roundtrip сохраняет поля, неизвестные поля не исчезают',
  async (t) => {
    const { actions, store, draft } = await fixture(t);
    assert.equal(typeof actions.openJsonDraftBuffer, 'function');
    actions.openJsonDraftBuffer();
    const raw = store.jsonBuffer.raw;
    assert.match(raw, /"bootstrapPrompts"/);
    assert.match(raw, /"provenance"/);
    actions.applyJsonDraftBuffer();
    assert.deepEqual(store.localDocument.routes, draft.routes);
    assert.deepEqual(store.localDocument.bootstrap, draft.bootstrap);
    assert.deepEqual(store.localDocument.bootstrapPrompts, draft.bootstrapPrompts);
    const unexpected = JSON.parse(raw);
    unexpected.unrecognized = 'Оставить как есть';
    actions.updateJsonDraftBuffer(JSON.stringify(unexpected));
    actions.formatJsonDraftBuffer();
    assert.match(store.jsonBuffer.raw, /unrecognized/);
    assert.match(store.jsonBuffer.error, /unrecognized|неизвестн|Некорректн/i);
  });

test('RE-G5-02: сломанный raw переживает вкладку и отмену ухода, save/publish заблокированы',
  async (t) => {
    const { actions, store } = await fixture(t);
    let patches = 0;
    actions.configureRoutesRuntime(store, { api: {
      patchDraft: async () => { patches += 1; throw new Error('запись запрещена'); },
    }, scheduler: { setTimeout: () => 1, clearTimeout: () => {} } });
    actions.openJsonDraftBuffer();
    const raw = '{"title":';
    actions.updateJsonDraftBuffer(raw);
    actions.openJsonDraftBuffer();
    assert.equal(store.jsonBuffer.raw, raw);
    actions.applyLocalChange((draft) => { draft.title = 'Правка формы'; });
    await actions.saveDraft();
    assert.equal(patches, 0);
    assert.match(store.saveError, /JSON/);
    assert.equal(store.canPublish, false);
    const leave = await actions.confirmDirtyRouteExit(
      store.dirty || store.jsonBuffer.dirty, true, async () => false);
    assert.equal(leave, false);
    assert.equal(store.jsonBuffer.raw, raw);
  });

test('RE-G5-03: исправленный JSON применяется одной undo-командой и запускает autosave',
  async (t) => {
    const { actions, store, draft } = await fixture(t);
    let scheduled = 0;
    actions.configureRoutesRuntime(store, { scheduler: {
      setTimeout: () => { scheduled += 1; return scheduled; },
      clearTimeout: () => {},
    } });
    actions.openJsonDraftBuffer();
    actions.updateJsonDraftBuffer('{"title":');
    actions.applyJsonDraftBuffer();
    assert.equal(store.localDocument.title, draft.title);
    assert.match(store.jsonBuffer.error, /синтаксис JSON/);
    const changed = JSON.parse(store.jsonBuffer.baselineRaw);
    changed.routes.quick.prompts['prompts/build.base.md'] = 'Исправлено через JSON.\n';
    actions.updateJsonDraftBuffer(JSON.stringify(changed));
    actions.applyJsonDraftBuffer();
    assert.equal(store.historyPast.length, 1);
    assert.equal(scheduled, 1);
    assert.equal(store.dirty, true);
    assert.equal(store.jsonBuffer.dirty, false);
    assert.equal(store.localDocument.routes.quick.prompts['prompts/build.base.md'],
      'Исправлено через JSON.\n');
    assert.equal(actions.undoDraft(), true);
    assert.equal(store.localDocument.routes.quick.prompts['prompts/build.base.md'],
      draft.routes.quick.prompts['prompts/build.base.md']);
    assert.equal(actions.redoDraft(), true);
    assert.equal(store.localDocument.routes.quick.prompts['prompts/build.base.md'],
      'Исправлено через JSON.\n');
  });

test('RE-G5-04: конфликт сохраняет raw и baseline до явного согласия на перечитывание',
  async (t) => {
    const { actions, store, draft } = await fixture(t);
    const newer = structuredClone(draft);
    newer.revision = 2;
    newer.title = 'Чужая правка';
    actions.configureRoutesRuntime(store, { api: { draft: async () => newer } });
    actions.openJsonDraftBuffer();
    const baseline = store.jsonBuffer.baselineRaw;
    const raw = '{"title":';
    actions.updateJsonDraftBuffer(raw);
    store.conflict = true;
    await actions.reloadConflict(async () => false);
    assert.equal(store.jsonBuffer.raw, raw);
    assert.equal(store.jsonBuffer.baselineRaw, baseline);
    assert.equal(store.serverSnapshot.revision, 1);
    await actions.reloadConflict(async () => true);
    assert.equal(store.serverSnapshot.revision, 2);
    assert.equal(store.jsonBuffer, null);
  });

test('RE-G5-04: копия конфликтного черновика не отбрасывает неприменённый JSON',
  async (t) => {
    const { actions, store } = await fixture(t);
    let created = 0;
    actions.configureRoutesRuntime(store, { api: {
      createDraft: async () => { created += 1; throw new Error('Нельзя создавать копию'); },
    } });
    actions.openJsonDraftBuffer();
    const baseline = store.jsonBuffer.baselineRaw;
    actions.updateJsonDraftBuffer('{"title":');
    store.conflict = true;
    await actions.saveConflictCopy();
    assert.equal(created, 0);
    assert.equal(store.jsonBuffer.raw, '{"title":');
    assert.equal(store.jsonBuffer.baselineRaw, baseline);
    assert.match(store.saveError, /JSON/);
  });

test('RE-G5-04: ACK прежней правки формы не блокирует неприменённый JSON', async (t) => {
  const { actions, store } = await fixture(t);
  actions.openJsonDraftBuffer();
  const changed = JSON.parse(store.jsonBuffer.raw);
  changed.title = 'Правка через JSON';
  actions.updateJsonDraftBuffer(JSON.stringify(changed));
  store.serverSnapshot.revision = 2;
  store.localDocument.revision = 2;
  actions.applyJsonDraftBuffer();
  assert.equal(store.localDocument.title, 'Правка через JSON');
  assert.equal(store.jsonBuffer.error, '');
});

test('RE-G5-03: JSON-компонент показывает typed issues и отдаёт точный raw-текст',
  async (t) => {
    const browser = await installUiBrowser(t, 'http://cockpit.test/#/routes');
    const component = await compileVue(webFile('src/views/routes/RouteJsonEditor.vue'), {
      stubs: {
        '../../ui': (`import { defineComponent, h } from 'vue';
          export const UiButton = defineComponent({ props: ['disabled'], emits: ['click'],
            setup(props, { emit, slots }) { return () => h('button',
              { disabled: props.disabled, onClick: () => emit('click') }, slots.default?.()); } });`) +
          "\nexport { vTooltip } from \"./src/services/tooltipDirective.ts\";",
        './RouteMarkdownInput.vue': `import { defineComponent, h } from 'vue';
          export default defineComponent({ props: ['modelValue', 'language'],
            emits: ['update:modelValue', 'save'],
            setup(props, { emit }) { return () => h('textarea',
              { value: props.modelValue,
                onInput: (event) => emit('update:modelValue', event.target.value) }); } });`,
      },
    });
    const { mount } = await import(
      '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
    );
    const buffer = { draftId: 'sample', baselineRevision: 1, generation: 0,
      baselineRaw: '{}', raw: '{"title":', dirty: true, error: 'синтаксис JSON' };
    const wrapper = mount(component, {
      attachTo: browser.document.querySelector('#mount'),
      props: { buffer, issues: [{ path: '/routes/quick/nodes/check',
        message: 'Нет исхода failed' }], readOnly: false },
    });
    t.after(() => wrapper.unmount());
    assert.equal(wrapper.find('textarea').element.value, '{"title":');
    assert.match(wrapper.text(), /синтаксис JSON/);
    assert.match(wrapper.text(), /\/routes\/quick\/nodes\/check/);
    assert.match(wrapper.text(), /Нет исхода failed/);
    await wrapper.find('textarea').setValue('{"title":"исправлено"}');
    assert.deepEqual(wrapper.emitted('update:raw')?.at(-1), ['{"title":"исправлено"}']);
  });
