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
  daemonAlive: true,
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
  assert.equal(wrapper.findAll('.e-flow').length, 1, 'старт не движется вместе с возвратом');
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
  assert.match(node.attributes('data-ui-tooltip'), /Готово/, 'подсказка называет состояние словами');
  assert.match(node.attributes('aria-description'), /Готово/, 'состояние доступно скринридеру');
  assert.equal(Number(state.attributes('x')) > Number(label.attributes('x')), true);

  await wrapper.setProps({ graph: { ...GRAPH, statuses: { build: 'run' } } });

  assert.equal(node.find('.node-state').exists(), false);
  assert.equal(node.find('.node-state-bg').exists(), false);
  assert.equal(node.find('.node-run-outline').exists(), true);
  assert.match(node.attributes('data-ui-tooltip'), /В работе/);
  assert.match(node.attributes('aria-description'), /В работе/);
  assert.deepEqual([label.attributes('x'), label.attributes('y')], titlePosition);
});

test('обводка автоматического шага и возврат замирают при паузе и остановке', async (t) => {
  const browser = await installUiBrowser(t);
  const [{ mount }, FactoryGraph] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/views/pipeline/FactoryGraph.vue')),
  ]);
  const graph = {
    ...GRAPH,
    pos: { build: [140, 55], review: [480, 55] },
    nodes: { build: ['code', 'Проверка', ''], review: ['agent', 'Ревью', ''] },
    edges: [...GRAPH.edges, ['review', 'build', 'Повторить', 'fail', 'arc_up']],
    statuses: { build: 'run', review: 'pending' },
    loops: { review: 2 },
  };
  const wrapper = mount(FactoryGraph, {
    attachTo: browser.document.querySelector('#mount'),
    props: { graph },
  });

  t.after(() => wrapper.unmount());

  const node = wrapper.get('[data-node="build"]');
  const outline = node.get('.node-run-outline');

  assert.equal(outline.element.localName, 'path', 'движение следует контуру ромба');
  assert.equal(outline.attributes('d'), node.get('.node-shape').attributes('d'));
  assert.equal(node.find('.node-state-bg').exists(), false);
  assert.equal(wrapper.findAll('.e-flow').length, 1);
  assert.equal(wrapper.get('[data-source="review"] path').classes().includes('e-flow'), true);

  for (const stopped of [
    { daemonAlive: false },
    { stall: { node: 'build', title: 'Остановка' } },
  ]) {
    await wrapper.setProps({ graph: { ...graph, ...stopped } });

    assert.equal(wrapper.find('.node-run-outline').exists(), false);
    assert.equal(wrapper.find('.e-flow').exists(), false);
    assert.equal(wrapper.find('.e-loop').exists(), true, 'история возврата остаётся видимой');
  }

  await wrapper.setProps({ graph, reference: true });

  assert.equal(wrapper.find('.node-run-outline').exists(), false);
  assert.equal(wrapper.find('.e-flow').exists(), false);
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
  assert.equal(/вернул решение тебе/.test(wrapper.get('.ng').attributes('data-ui-tooltip')), true);
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

const LOOP_GRAPH = {
  pos: {
    build: [140, 50],
    review: [480, 50],
    accept: [820, 50],
  },
  nodes: {
    build: ['agent', 'Реализация', ''],
    review: ['agent', 'Проверка', ''],
    accept: ['human', 'Приёмка', ''],
  },
  edges: [
    ['_start', 'review', '', 'plain', 'arc_up'],
    ['build', 'review', '', 'plain', 'h'],
    ['review', 'build', 'failed', 'fail', 'arc_up'],
    ['review', 'accept', '', 'plain', 'h'],
    ['accept', 'review', 'rejected', 'fail', 'arc_up'],
  ],
  loop: { lead: 'review', worker: 'build' },
  loopProgress: {
    round: 3,
    maxRounds: 20,
    stage: 2,
  },
  daemonAlive: true,
  statuses: {
    build: 'run',
    review: 'pending',
    accept: 'pending',
  },
};

/**
 * Оба представления получают одинаковый граф, как в живой карточке конвейера.
 * Настоящие SFC проверяют смену состояний без запуска маршрута и настоящих агентов.
 */
async function mountLoop(t, component = 'FactoryGraph') {
  const browser = await installUiBrowser(t);
  const [{ mount }, Component] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile(`src/views/pipeline/${component}.vue`)),
  ]);
  const wrapper = mount(Component, {
    attachTo: browser.document.querySelector('#mount'),
    props: { graph: structuredClone(LOOP_GRAPH) },
  });

  t.after(() => wrapper.unmount());

  return wrapper;
}

test('петля всегда показывает две передачи и движется к работающему агенту', async (t) => {
  const wrapper = await mountLoop(t);
  const forward = '[data-source="build"][data-destination="review"]';
  const back = '[data-source="review"][data-destination="build"]';

  assert.equal(wrapper.get(`${back} text`).text(), 'Задание на круг');
  assert.match(
    wrapper.get(back).attributes('data-ui-tooltip'),
    /failed/,
    'исход перехода остаётся в подсказке',
  );
  assert.equal(wrapper.get(`${forward} text`).text(), 'На проверку');
  assert.equal(wrapper.get(`${back} path`).classes().includes('e-flow'), true);
  assert.equal(wrapper.findAll('.e-flow').length, 1);
  assert.equal(wrapper.get('.loop-active').attributes('data-node'), 'build');
  assert.equal(wrapper.get('.node-running').attributes('data-node'), 'build');
  assert.equal(wrapper.get('.node-run-outline').attributes('r'), wrapper.get('.node-running .node-shape')
    .attributes('r'), 'движется существующая обводка, без второго кольца');
  assert.equal(wrapper.find('.mk-run').exists(), false);
  assert.equal(wrapper.get('[data-node="review"] .node-loop-role').text(), 'Ведущий');
  assert.equal(wrapper.find('[data-source="accept"] path').exists(), false);

  await wrapper.setProps({ graph: {
    ...LOOP_GRAPH,
    statuses: {
      build: 'done',
      review: 'run',
      accept: 'pending',
    },
  } });

  assert.equal(wrapper.get(`${forward} path`).classes().includes('e-flow'), true);
  assert.equal(wrapper.get(`${back} path`).classes().includes('e-flow'), false);
  assert.equal(wrapper.findAll('.e-flow').length, 1, 'старт не движется повторно вместе с петлёй');
  assert.equal(wrapper.get('.loop-active').attributes('data-node'), 'review');
  assert.equal(wrapper.get('.node-running').attributes('data-node'), 'review');
});

test('первая постановка, пауза, приёмка и эталон не изображают выполненный круг', async (t) => {
  const wrapper = await mountLoop(t);

  await wrapper.setProps({ graph: {
    ...LOOP_GRAPH,
    loopProgress: { ...LOOP_GRAPH.loopProgress, round: 0 },
    statuses: {
      build: 'pending',
      review: 'run',
      accept: 'pending',
    },
  } });

  assert.equal(wrapper.findAll('.e-cycle.e-flow').length, 0);
  assert.equal(wrapper.get('[data-source="_start"] path').classes().includes('e-flow'), true);

  await wrapper.setProps({ graph: { ...LOOP_GRAPH, daemonAlive: false } });

  assert.equal(wrapper.find('.node-run-outline').exists(), false);
  assert.equal(wrapper.find('.e-flow').exists(), false);
  assert.equal(wrapper.findAll('.elbl-cycle').length, 2, 'обе передачи видны и на паузе');

  await wrapper.setProps({ graph: {
    ...LOOP_GRAPH,
    statuses: {
      build: 'done',
      review: 'done',
      accept: 'wait',
    },
  } });

  assert.equal(wrapper.find('.node-run-outline').exists(), false);
  assert.equal(wrapper.find('.e-flow').exists(), false);

  await wrapper.setProps({ graph: LOOP_GRAPH, reference: true });

  assert.equal(wrapper.find('.e-flow').exists(), false);
  assert.equal(wrapper.findAll('.elbl-cycle').length, 2);
});

test('сводка называет круг, этап и агента и обновляется при передаче', async (t) => {
  const wrapper = await mountLoop(t, 'LoopStatus');

  assert.match(wrapper.text(), /Круг 3 из 20/);
  assert.match(wrapper.text(), /Этап 2/);
  assert.match(wrapper.text(), /Выполняет: Реализация/);
  assert.equal(wrapper.attributes('role'), 'status');

  await wrapper.setProps({ graph: {
    ...LOOP_GRAPH,
    statuses: {
      build: 'done',
      review: 'run',
      accept: 'pending',
    },
  } });

  assert.match(wrapper.text(), /Проверяет: Проверка/);

  await wrapper.setProps({ graph: {
    ...LOOP_GRAPH,
    loopProgress: {
      round: 4,
      maxRounds: 20,
      stage: 3,
    },
  } });

  assert.match(wrapper.text(), /Круг 4 из 20/);
  assert.match(wrapper.text(), /Этап 3/);

  await wrapper.setProps({ graph: { ...LOOP_GRAPH, daemonAlive: false } });

  assert.match(wrapper.text(), /Петля на паузе/);
  assert.equal(wrapper.find('.loop-dot').exists(), false);

  await wrapper.setProps({ graph: {
    ...LOOP_GRAPH,
    stall: { node: 'build', title: 'Остановка' },
  } });

  assert.match(wrapper.text(), /Петля остановлена/);
  assert.equal(wrapper.find('.loop-dot').exists(), false);
});

test('сводка не выдумывает первый круг и не включает режим по обычным возвратам', async (t) => {
  const wrapper = await mountLoop(t, 'LoopStatus');

  await wrapper.setProps({ graph: {
    ...LOOP_GRAPH,
    loopProgress: {
      round: 0,
      maxRounds: 20,
      stage: 1,
    },
    statuses: {
      build: 'pending',
      review: 'run',
      accept: 'pending',
    },
  } });

  assert.match(wrapper.text(), /До первого круга/);
  assert.match(wrapper.text(), /Ставит задачу/);

  await wrapper.setProps({ graph: { ...LOOP_GRAPH, loopProgress: null } });

  assert.match(wrapper.text(), /Круг неизвестен/);

  await wrapper.setProps({ graph: {
    ...LOOP_GRAPH,
    loop: null,
    loops: { review: 3 },
  } });

  assert.equal(wrapper.find('.loop-status').exists(), false);
});
