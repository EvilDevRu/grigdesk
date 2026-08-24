import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

const GRAPH = {
  pos: {
    build: [140, 55],
  },
  nodes: {
    build: ['agent', 'Сборка', 'npm run build'],
  },
  edges: [
    ['_start', 'build', '', 'pass', 'h'],
  ],
  statuses: {
    build: 'pending',
  },
};

test('FactoryGraph даёт интерактивным SVG-узлам button-контракт и клавиатуру', async (t) => {
  const browser = await installUiBrowser(t);
  const [{ mount }, FactoryGraph] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/views/pipeline/FactoryGraph.vue')),
  ]);
  const activations = [];
  const wrapper = mount(FactoryGraph, {
    attachTo: browser.document.querySelector('#mount'),
    props: {
      graph: GRAPH,
      onNode: (...args) => activations.push(args),
    },
  });
  t.after(() => wrapper.unmount());

  let node = wrapper.get('.ng');

  assert.equal(node.element.localName, 'g');
  assert.equal(node.classes().includes('ui-svg-pressable'), true);
  assert.equal(node.attributes('role'), 'button');
  assert.equal(node.attributes('tabindex'), '0');
  assert.equal(node.attributes('aria-label'), 'Сборка');

  let pressable = wrapper.getComponent({ name: 'UiSvgPressable' });

  assert.equal(typeof pressable.vm.$.subTree.props?.onClick, 'function');
  assert.equal(typeof pressable.vm.$.subTree.props?.onKeydown, 'function');
  pressable.vm.$.subTree.props.onClick(new browser.MouseEvent('click'));
  assert.equal(activations.length, 1);

  pressable.vm.$.subTree.props.onKeydown(new browser.KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
  }));
  assert.equal(activations.length, 2);
  assert.equal(activations[0][0].id, 'build');
  assert.equal(activations[1][1].key, 'Enter');

  await wrapper.setProps({ reference: true });
  node = wrapper.get('.ng');

  assert.equal(node.classes().includes('ui-svg-pressable'), false);
  assert.equal(node.attributes('role'), undefined);
  assert.equal(node.attributes('tabindex'), undefined);
  assert.equal(activations.length, 2);

  await wrapper.setProps({ interactive: true });
  node = wrapper.get('.ng');

  assert.equal(node.classes().includes('ui-svg-pressable'), true);
  pressable = wrapper.getComponent({ name: 'UiSvgPressable' });
  pressable.vm.$.subTree.props.onKeydown(new browser.KeyboardEvent('keydown', {
    key: ' ',
    bubbles: true,
    cancelable: true,
  }));
  assert.equal(activations.length, 3);
});
