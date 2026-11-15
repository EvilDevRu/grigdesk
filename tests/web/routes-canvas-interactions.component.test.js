import assert from 'node:assert/strict';
import test from 'node:test';

import { makeDraft } from '../fixtures/routes-editor.mjs';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

const UI_STUB = `
export * from './src/ui.ts';
import { defineComponent, h } from 'vue';
export { default as UiPaneHeader } from './src/components/composites/UiPaneHeader.vue';
export { default as UiField } from './src/components/composites/UiField.vue';
export { default as UiIconButton } from './src/components/primitives/UiIconButton.vue';
export const UiSvgPressable = defineComponent({ emits: ['click'],
  setup(_, { emit, attrs, slots }) { return () => h('g', {
    ...attrs, role: 'button', tabindex: 0,
    onClick: (event) => emit('click', event),
    onKeydown: (event) => { if (event.key === 'Enter') emit('click', event); },
  }, slots.default?.()); } });
export const UiButton = defineComponent({ emits: ['click'],
  setup(_, { emit, attrs, slots }) { return () => h('button', {
    ...attrs, onClick: (event) => emit('click', event),
    onKeydown: (event) => { if (event.key === 'Enter') emit('click', event); },
  }, slots.default?.()); } });
export const UiInput = defineComponent({ props: ['modelValue'], emits: ['update:modelValue'],
  setup(props, { emit, attrs }) { return () => h('input', { ...attrs, value: props.modelValue,
    onInput: (event) => emit('update:modelValue', event.target.value) }); } });
export const UiSelect = defineComponent({ props: ['modelValue'], emits: ['update:modelValue'],
  setup(props, { emit, attrs, slots }) { return () => h('select', { ...attrs,
    value: props.modelValue,
    onChange: (event) => emit('update:modelValue', event.target.value) }, slots.default?.()); } });
`;

test('Взаимодействия холста на reactive документах', async (suite) => {
  const browser = await installUiBrowser(suite, 'http://grigdesk.test/#/routes');
  const { reactive } = await import('../../web/node_modules/vue/index.mjs');
  const Component = await compileVue(webFile('src/views/routes/RouteCanvas.vue'), {
    stubs: { '../../ui': UI_STUB
      + '\nexport { vTooltip } from "./src/services/tooltipDirective.ts";' },
  });
  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );

/**
 * Новый mount каждого сценария сохраняет один Vue document на файл.
 * Document повторяет реальную реактивную границу стора и команды редактора.
 */
async function dragFixture(t, initial = makeDraft()) {
  let document = reactive(initial);
  let selectedNodeId = '';
  const changes = [];
  const adds = [];
  const wrapper = mount(Component, {
    attachTo: browser.document.querySelector('#mount'),
    props: {
      document,
      scope: { kind: 'route', routeId: 'quick' },
      selectedNodeId,
      onSelectNode(value) {
        selectedNodeId = value.nodeId;
        void wrapper.setProps({ selectedNodeId });
      },
      onChange(next) {
        changes.push(next);
        document = reactive(next);
        void wrapper.setProps({ document });
      },
      onAddAt(point) {
        adds.push(point);
      },
    },
  });


  t.after(() => wrapper.unmount());


  const captures = [];
  const container = wrapper.get('.route-canvas__graph').element;


  container.setPointerCapture = (id) => captures.push(id);
  container.releasePointerCapture = () => {};

  return {
    wrapper,
    browser,
    changes,
    adds,
    captures,
    flushPromises,
    getDocument: () => document,
    getSelected: () => selectedNodeId
  };
}

await suite.test('RE-G4-01: перенос reactive-документа — одна точка и никакого add-at', async (t) => {
  const f = await dragFixture(t);
  const node = f.wrapper.get('[data-node="build"]');


  await node.trigger('pointerdown', {
    pointerId: 1,
    button: 0,
    clientX: 300,
    clientY: 200
  });
  await node.trigger('pointermove', {
    pointerId: 1,
    clientX: 348,
    clientY: 224
  });
  await node.trigger('pointerup', {
    pointerId: 1,
    clientX: 348,
    clientY: 224
  });
  await f.wrapper.get('.route-canvas__graph').trigger('click', { clientX: 348, clientY: 224 });
  await f.flushPromises();

  assert.equal(f.changes.length, 1);
  assert.equal(f.getDocument().presentation['r:quick:build'].x, 188);
  assert.equal(f.getDocument().presentation['r:quick:build'].y, 74);
  assert.equal(f.adds.length, 0);
});

await suite.test('RE-G4-02: Escape отменяет перенос без change', async (t) => {
  const f = await dragFixture(t);
  const node = f.wrapper.get('[data-node="build"]');


  await node.trigger('pointerdown', {
    pointerId: 1,
    button: 0,
    clientX: 300,
    clientY: 200
  });
  await node.trigger('pointermove', {
    pointerId: 1,
    clientX: 360,
    clientY: 260
  });
  f.browser.dispatchEvent(new f.browser.KeyboardEvent('keydown', { key: 'Escape' }));
  await node.trigger('pointerup', {
    pointerId: 1,
    clientX: 360,
    clientY: 260
  });
  assert.equal(f.changes.length, 0);
  assert.equal(f.getDocument().presentation['r:quick:build'], undefined);
});

await suite.test('RE-G4-03: обычный click после pointerup выбирает узел без capture', async (t) => {
  const f = await dragFixture(t);
  const node = f.wrapper.get('[data-node="build"]');


  await node.trigger('pointerdown', {
    pointerId: 1,
    button: 0,
    clientX: 300,
    clientY: 200
  });
  await node.trigger('pointermove', {
    pointerId: 1,
    clientX: 302,
    clientY: 201
  });
  await node.trigger('pointerup', {
    pointerId: 1,
    clientX: 302,
    clientY: 201
  });
  // Test Utils не создаёт browser click из pointer-событий.
  await node.trigger('click', { clientX: 302, clientY: 201 });
  assert.equal(f.getSelected(), 'build');
  assert.equal(f.captures.length, 0);
  assert.equal(f.changes.length, 0);
  assert.equal(f.adds.length, 0);
});

await suite.test('RE-G4-04: чужой pointerup не завершает жест, свой pointercancel отменяет', async (t) => {
  const f = await dragFixture(t);
  const node = f.wrapper.get('[data-node="build"]');


  await node.trigger('pointerdown', {
    pointerId: 1,
    button: 0,
    clientX: 300,
    clientY: 200
  });
  await node.trigger('pointermove', {
    pointerId: 1,
    clientX: 360,
    clientY: 260
  });
  await node.trigger('pointerup', {
    pointerId: 2,
    clientX: 100,
    clientY: 100
  });
  assert.equal(f.changes.length, 0);
  await node.trigger('pointercancel', { pointerId: 1 });
  await node.trigger('pointerup', {
    pointerId: 1,
    clientX: 360,
    clientY: 260
  });
  assert.equal(f.changes.length, 0);
});

await suite.test('RE-G4-07: изменение live CTM/viewBox не дрожит внутри переноса', async (t) => {
  const f = await dragFixture(t);
  const node = f.wrapper.get('[data-node="build"]');
  const svg = f.wrapper.get('svg.graph').element;
  const initialBox = svg.getAttribute('viewBox');
  let offset = 0;


  svg.getScreenCTM = () => ({ inverse: () => ({
    a: 1,
    b: 0,
    c: 0,
    d: 1,
    e: offset,
    f: 0
  }) });
  await node.trigger('pointerdown', {
    pointerId: 1,
    button: 0,
    clientX: 140,
    clientY: 50
  });
  await node.trigger('pointermove', {
    pointerId: 1,
    clientX: 240,
    clientY: 150
  });
  offset = 10000;
  await node.trigger('pointermove', {
    pointerId: 1,
    clientX: 250,
    clientY: 160
  });
  assert.equal(svg.getAttribute('viewBox'), initialBox);
  await node.trigger('pointerup', {
    pointerId: 1,
    clientX: 250,
    clientY: 160
  });
  assert.equal(f.getDocument().presentation['r:quick:build'].x, 250);
  assert.equal(f.getDocument().presentation['r:quick:build'].y, 160);
});
await suite.test('RE-G5-03: пустой фон просит точку, click узла — только выбор', async (t) => {
  const f = await dragFixture(t);


  await f.wrapper.get('.route-canvas__graph').trigger('click', { clientX: 300, clientY: 100 });
  assert.deepEqual(f.adds, [{ x: 300, y: 100 }]);
  await f.wrapper.get('[data-node="build"]').trigger('click');
  assert.equal(f.adds.length, 1);
  assert.equal(f.getSelected(), 'build');
});
await suite.test('RE-G6-01: reactive исход check/failed становится переходом к build', async (t) => {
  const draft = makeDraft();


  draft.presentation['r:quick:build'] = { x: 200, y: 40 };
  draft.presentation['r:quick:check'] = { x: 700, y: 40 };


  const f = await dragFixture(t, draft);


  await f.wrapper.get('[data-node="check"]').trigger('click');
  await f.flushPromises();


  const chip = f.wrapper.get('[data-test="outcome-chip-failed"]');


  await chip.trigger('pointerdown', {
    pointerId: 2,
    button: 0,
    clientX: 740,
    clientY: 80
  });
  await chip.trigger('pointermove', {
    pointerId: 2,
    clientX: 200,
    clientY: 40
  });
  await chip.trigger('pointerup', {
    pointerId: 2,
    clientX: 200,
    clientY: 40
  });
  await f.flushPromises();


  const check = f.getDocument().routes.quick.route.nodes.find((node) => node.id === 'check');


  assert.equal(check.on.failed.next, 'build');
  assert.equal(f.changes.length, 1);
  assert.equal(Boolean(f.browser.document.querySelector('[data-test="outcome-ghost"]')), false);
});

await suite.test('RE-G6-02: рядом с hit-area, но вне узла — без перехода', async (t) => {
  const draft = makeDraft();


  draft.presentation['r:quick:build'] = { x: 200, y: 40 };
  draft.presentation['r:quick:check'] = { x: 700, y: 40 };


  const f = await dragFixture(t, draft);


  await f.wrapper.get('[data-node="check"]').trigger('click');


  const chip = f.wrapper.get('[data-test="outcome-chip-failed"]');
  // 150 px от центра build: старый радиус 240 ошибочно создал бы переход.
  await chip.trigger('pointerdown', {
    pointerId: 2,
    button: 0,
    clientX: 740,
    clientY: 80
  });
  await chip.trigger('pointermove', {
    pointerId: 2,
    clientX: 350,
    clientY: 40
  });
  await chip.trigger('pointerup', {
    pointerId: 2,
    clientX: 350,
    clientY: 40
  });
  assert.equal(f.changes.length, 0);
});

await suite.test('RE-G6-03: отпускание на source не создаёт петлю', async (t) => {
  const draft = makeDraft();


  draft.presentation['r:quick:check'] = { x: 700, y: 40 };


  const f = await dragFixture(t, draft);


  await f.wrapper.get('[data-node="check"]').trigger('click');


  const chip = f.wrapper.get('[data-test="outcome-chip-failed"]');


  await chip.trigger('pointerdown', {
    pointerId: 2,
    button: 0,
    clientX: 900,
    clientY: 100
  });
  await chip.trigger('pointermove', {
    pointerId: 2,
    clientX: 700,
    clientY: 40
  });
  await chip.trigger('pointerup', {
    pointerId: 2,
    clientX: 700,
    clientY: 40
  });
  assert.equal(f.changes.length, 0);
});

for (const cancel of ['Escape', 'pointercancel']) {
  await suite.test(`RE-G6-04/${cancel}: отмена, чужой pointer и новый жест`, async (t) => {
    const draft = makeDraft();


    draft.presentation['r:quick:build'] = { x: 200, y: 40 };
    draft.presentation['r:quick:check'] = { x: 700, y: 40 };


    const f = await dragFixture(t, draft);


    await f.wrapper.get('[data-node="check"]').trigger('click');


    const chip = f.wrapper.get('[data-test="outcome-chip-failed"]');


    await chip.trigger('pointerdown', {
      pointerId: 2,
      button: 0,
      clientX: 740,
      clientY: 80
    });
    await chip.trigger('pointermove', {
      pointerId: 2,
      clientX: 200,
      clientY: 40
    });
    await chip.trigger('pointerup', {
      pointerId: 9,
      clientX: 200,
      clientY: 40
    });
    assert.equal(f.changes.length, 0);


    if (cancel === 'Escape') {
      f.browser.dispatchEvent(new f.browser.KeyboardEvent('keydown', { key: 'Escape' }));
    } else {
      await chip.trigger('pointercancel', { pointerId: 2 });
    }


    await chip.trigger('pointerup', {
      pointerId: 2,
      clientX: 200,
      clientY: 40
    });
    assert.equal(f.changes.length, 0);
    assert.equal(Boolean(f.browser.document.querySelector('[data-test="outcome-ghost"]')), false);
    await chip.trigger('pointerdown', {
      pointerId: 3,
      button: 0,
      clientX: 740,
      clientY: 80
    });
    await chip.trigger('pointermove', {
      pointerId: 3,
      clientX: 200,
      clientY: 40
    });
    await chip.trigger('pointerup', {
      pointerId: 3,
      clientX: 200,
      clientY: 40
    });
    assert.equal(f.changes.length, 1);
  });
}


await suite.test('RE-G7-01: кнопка автологики снимает координаты своей области', async (t) => {
  const draft = makeDraft();

  // Ключ r:other:* — посторонняя область: маршрут other в фикстуре не существует
  // и координата обязана уцелеть. «Чинить» фикстуру не нужно.
  draft.presentation['r:quick:build'] = { x: 900, y: 60 };
  draft.presentation['r:other:build'] = { x: 10, y: 10 };

  const { wrapper, getDocument } = await dragFixture(t, draft);

  await wrapper.find('[data-test="auto-layout"]').trigger('click');

  assert.equal(Object.hasOwn(getDocument().presentation, 'r:quick:build'), false);
  assert.deepEqual(getDocument().presentation['r:other:build'], { x: 10, y: 10 });
});
});
