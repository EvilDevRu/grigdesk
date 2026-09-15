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

test('движение линии ведёт к работающему этапу и не обещает запуск следующего', async (t) => {
  const browser = await installUiBrowser(t);
  const [{ mount }, FactoryGraph] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/views/pipeline/FactoryGraph.vue')),
  ]);
  const graph = {
    ...GRAPH,
    pos: { build: [140, 55], review: [480, 55] },
    nodes: { build: ['agent', 'Сборка', ''], review: ['agent', 'Ревью', ''] },
    edges: [...GRAPH.edges, ['build', 'review', '', 'pass', 'h']],
    statuses: { build: 'run', review: 'pending' },
  };
  const wrapper = mount(FactoryGraph, {
    attachTo: browser.document.querySelector('#mount'),
    props: { graph },
  });
  t.after(() => wrapper.unmount());

  assert.equal(wrapper.get('[data-source="_start"] path').classes().includes('e-flow'), true);
  assert.equal(wrapper.get('[data-source="build"] path').classes().includes('e-off'), true);

  await wrapper.setProps({ graph: { ...graph, statuses: { build: 'done', review: 'run' } } });

  assert.equal(wrapper.get('[data-source="_start"] path').classes().includes('e-on'), true);
  assert.equal(wrapper.get('[data-source="build"] path').classes().includes('e-flow'), true);
});

test('возможные возвраты скрыты, фактические видны и подпись открывается с узла', async (t) => {
  const browser = await installUiBrowser(t);
  const [{ mount }, FactoryGraph] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/views/pipeline/FactoryGraph.vue')),
  ]);
  const graph = {
    ...GRAPH,
    pos: { build: [140, 55], review: [480, 55] },
    nodes: { build: ['agent', 'Сборка', ''], review: ['agent', 'Ревью', ''] },
    edges: [...GRAPH.edges, ['review', 'build', 'Исправить замечания', 'fail', 'arc_up']],
    statuses: { build: 'run', review: 'done' },
  };
  const wrapper = mount(FactoryGraph, {
    attachTo: browser.document.querySelector('#mount'),
    props: { graph },
  });
  t.after(() => wrapper.unmount());

  assert.equal(wrapper.find('.e-fail').exists(), false);

  await wrapper.setProps({ loopsOn: true });

  assert.equal(wrapper.find('.e-fail').exists(), true);
  assert.equal(wrapper.find('.elbl-fail').exists(), false);

  await wrapper.get('[data-node="review"]').trigger('focusin');

  assert.equal(wrapper.get('.elbl-fail').text(), 'Исправить замечания');

  await wrapper.setProps({ loopsOn: false, graph: { ...graph, loops: { review: 2 } } });

  assert.equal(wrapper.get('.e-loop').classes().includes('e-flow'), true);
  assert.equal(wrapper.get('.elbl-fail').text(), 'Исправить замечания ×2');
});

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

test('знак статуса не двигает название, а его смысл доступен текстом', async (t) => {
  const browser = await installUiBrowser(t);
  const [{ mount }, FactoryGraph] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/views/pipeline/FactoryGraph.vue')),
  ]);
  const wrapper = mount(FactoryGraph, {
    attachTo: browser.document.querySelector('#mount'),
    props: {
      graph: {
        ...GRAPH,
        statuses: { build: 'done' },
      },
    },
  });
  t.after(() => wrapper.unmount());

  const node = wrapper.get('.ng');
  const label = node.get('.nlbl');
  const state = node.get('.node-state');
  const titlePosition = [label.attributes('x'), label.attributes('y')];

  assert.equal(label.text(), 'Сборка', 'знак больше не сдвигает подпись узла');
  assert.equal(label.find('.mk').exists(), false, 'знак отделён от текста');
  assert.equal(state.get('.mk').text(), '✓');
  assert.match(node.get('title').text(), /Готово/, 'подсказка называет состояние словами');
  assert.match(node.attributes('aria-description'), /Готово/, 'состояние доступно скринридеру');
  assert.equal(Number(state.attributes('x')) > Number(label.attributes('x')), true);

  await wrapper.setProps({ graph: { ...GRAPH, statuses: { build: 'run' } } });

  assert.equal(node.get('.node-state .mk').text(), '●');
  assert.match(node.get('title').text(), /В работе/);
  assert.match(node.attributes('aria-description'), /В работе/);
  assert.deepEqual([label.attributes('x'), label.attributes('y')], titlePosition);
});

// Пока идёт разбор, задача снаружи неотличима от вставшей: тот же красный узел, та же
// плашка тревоги. Человек читает это как «работа стоит на мне» и берётся за неё руками —
// параллельно с арбитром, который её в этот момент и делает.
test('идущий разбор перекрашивает узел остановки и снимает тревогу с плашки', async (t) => {
  const browser = await installUiBrowser(t);
  const [{ mount }, FactoryGraph] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/views/pipeline/FactoryGraph.vue')),
  ]);
  const graph = {
    ...GRAPH,
    statuses: { build: 'stall' },
    stall: {
      node: 'build',
      stage: 'BUILD',
      title: 'BUILD: узел вернул решение человеку',
      hint: 'открой узел и прочитай его замечание',
    },
  };
  const wrapper = mount(FactoryGraph, {
    attachTo: browser.document.querySelector('#mount'),
    props: { graph },
  });
  t.after(() => wrapper.unmount());

  assert.equal(wrapper.get('.ng').classes().includes('ns-stall'), true);
  assert.equal(wrapper.get('.graph-stop').attributes('role'), 'alert');

  await wrapper.setProps({ arbitrating: { actor: 'auto', elapsedSec: 180 } });

  assert.equal(wrapper.get('.ng').classes().includes('ns-arb'), true, 'узел показан разбираемым');
  assert.equal(wrapper.get('.ng').classes().includes('ns-stall'), false, 'тревога снята');
  assert.equal(wrapper.get('.mk').classes().includes('mk-arb'), true, 'у статуса своя метка');
  assert.equal(
    wrapper.get('.graph-stop').attributes('role'),
    'status',
    'разбор — это не alert: работа идёт, а не требует человека',
  );

  const plate = wrapper.get('.graph-stop').text();

  assert.match(plate, /Арбитр разбирает остановку/);
  assert.match(plate, /сам · 3 мин/, 'видно, что задача едет сама и сколько уже');
  assert.match(plate, /вернул решение человеку/, 'исходная причина остановки не потеряна');
});

// Арбитр разбирает ОДНУ остановку, и она принадлежит одному узлу. Красить соседние
// значило бы обещать работу там, где её нет.
test('разбор красит только узел остановки', async (t) => {
  const browser = await installUiBrowser(t);
  const [{ mount }, FactoryGraph] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/views/pipeline/FactoryGraph.vue')),
  ]);
  const graph = {
    pos: { build: [140, 55], review: [280, 55] },
    nodes: { build: ['agent', 'Сборка', ''], review: ['agent', 'Ревью', ''] },
    edges: [['build', 'review', '', 'pass', 'h']],
    statuses: { build: 'stall', review: 'pending' },
    stall: { node: 'build', stage: 'BUILD', title: 'встал', hint: '' },
  };
  const wrapper = mount(FactoryGraph, {
    attachTo: browser.document.querySelector('#mount'),
    props: { graph, arbitrating: { actor: 'human', elapsedSec: 12 } },
  });
  t.after(() => wrapper.unmount());

  const classes = wrapper.findAll('.ng').map((node) => node.classes().join(' '));

  assert.equal(classes.filter((c) => c.includes('ns-arb')).length, 1);
  assert.equal(classes.some((c) => c.includes('ns-pending')), true, 'соседний узел не тронут');
});

// Идущий разбор виден статусом `arb` и гаснет вместе с ним. А вопрос «кто двигал курсор
// на этом узле» остаётся и после: без следа человек, открыв схему, не отличает узел,
// который прошёл сам, от узла, который вернул арбитр.
test('след арбитра помечает узел и после того, как разбор кончился', async (t) => {
  const browser = await installUiBrowser(t);
  const [{ mount }, FactoryGraph] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/views/pipeline/FactoryGraph.vue')),
  ]);
  const graph = {
    ...GRAPH,
    pos: { build: [140, 55], review: [340, 55] },
    nodes: { build: ['agent', 'Сборка', ''], review: ['agent', 'Ревью', ''] },
    edges: [['build', 'review', '', 'pass', 'h']],
    statuses: { build: 'done', review: 'stall' },
  };
  const wrapper = mount(FactoryGraph, {
    attachTo: browser.document.querySelector('#mount'),
    props: { graph, arbitrated: { build: 'human' } },
  });
  t.after(() => wrapper.unmount());

  const marks = wrapper.findAll('.node-arb');
  assert.equal(marks.length, 1, 'помечен ровно тот узел, который разбирал арбитр');
  assert.equal(marks[0].classes().includes('node-arb-human'), true);
  // Подсказка обязана называть исход: «здесь был арбитр» без вердикта не говорит,
  // ждёт ли узел человека.
  assert.equal(/вернул решение тебе/.test(wrapper.get('.ng title').text()), true);
});

// Эталонная схема маршрута к прогонам отношения не имеет: следов там быть не может.
test('эталонный режим след арбитра не рисует', async (t) => {
  const browser = await installUiBrowser(t);
  const [{ mount }, FactoryGraph] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/views/pipeline/FactoryGraph.vue')),
  ]);
  const wrapper = mount(FactoryGraph, {
    attachTo: browser.document.querySelector('#mount'),
    props: { graph: GRAPH, reference: true, arbitrated: { build: 'human' } },
  });
  t.after(() => wrapper.unmount());

  assert.equal(wrapper.find('.node-arb').exists(), false);
});
