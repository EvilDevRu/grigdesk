import assert from 'node:assert/strict';
import test from 'node:test';

import {
  actionButtons,
  disclosure,
  exhaustedStop,
  mountStallPipeline,
  stallFixture,
  stopDetails,
} from './helpers/pipeline-stall-fixtures.js';

process.env.NODE_ENV = 'test';

const human = {
  ...exhaustedStop,
  outcome: undefined,
  title: 'SHIP: узел вернул решение человеку',
  presentation: {
    reason: 'нужно решение человека',
    summary: 'Прочитайте вопрос узла.',
    details: { what: 'Вопрос <b>человеку</b>; текст остаётся текстом.', action: 'Ответьте на вопрос.' },
  },
};
const noProgress = {
  ...human,
  stop: 'no-progress',
  arbitrable: true,
};
const sandbox = {
  ...human,
  stage: 'SANDBOX',
  node: undefined,
  title: 'стенд не поднялся',
  presentation: {
    reason: 'стенд не запустился',
    summary: 'Проверьте журнал запуска.',
    details: { what: 'Стенд не поднялся.', action: 'Перезапустите стенд.' },
  },
};
const arbiter = {
  node: 'ship',
  verdict: 'human',
  model: 'example-arbiter',
  summary: 'Нужно решение владельца',
  dispute: 'Нужно выбрать вариант',
  why: 'Выбор меняет цель',
  recommendation: 'Уточните требование',
};

for (const graphStop of [true, false]) {
  test(`одна панель с метками: graph.stall ${graphStop ? 'есть' : 'нет'}`, async (t) => {
    const fixture = stallFixture();

    if (!graphStop) {
      fixture.graph.stall = null;
    }

    const { wrapper } = await mountStallPipeline(t, fixture);
    const panel = wrapper.get('.stalled');

    assert.equal(wrapper.findAll('.stalled, .graph-stop').length, 1);
    assert.match(panel.text(), /Вливание в dev.*агент не вернул результат/s);
    assert.match(panel.text(), /3.*заход|заход.*3/s);
    assert.match(panel.text(), /2.*сбо|сбо.*2/s);
    assert.match(panel.text(), /example-sol/);
    assert.match(panel.text(), /причина не названа/);
    assert.doesNotMatch(panel.text(), /unknown|t<TASK>|tNNNN/);
    assert.equal(wrapper.find('footer button').exists(), false);
  });
}

test('подробнее показывает только непустые полки', async (t) => {
  const { wrapper } = await mountStallPipeline(t);
  const button = disclosure(wrapper);

  assert.ok(button, 'панель должна предлагать подробнее');
  assert.equal(button.attributes('aria-expanded'), 'false');
  assert.equal(wrapper.findAll('.stalled dl').filter((item) => item.isVisible()).length, 0);
  await button.trigger('click');

  assert.equal(button.attributes('aria-expanded'), 'true');

  const controls = button.attributes('aria-controls');
  const region = wrapper.findAll('[id]').find((item) => item.attributes('id') === controls);

  assert.ok(region, 'раскрытие связано с областью подробностей');
  assert.deepEqual(wrapper.findAll('.stalled dt').map((item) => item.text()), [
    'Что случилось', 'Возможная причина', 'Что уцелело', 'Что делать',
  ]);
  assert.deepEqual(wrapper.findAll('.stalled dd').map((item) => item.text()), Object.values(stopDetails));

  await button.trigger('click');

  assert.equal(wrapper.findAll('.stalled dl').filter((item) => item.isVisible()).length, 0);
});

test('подробнее пропускает отсутствующие полки и экранирует данные', async (t) => {
  const { wrapper } = await mountStallPipeline(t, stallFixture(human));
  const button = disclosure(wrapper);

  assert.ok(button, 'нет раскрытия подробностей');
  await button.trigger('click');

  assert.deepEqual(wrapper.findAll('.stalled dt').map((item) => item.text()), [
    'Что случилось', 'Что делать',
  ]);
  assert.ok(wrapper.get('.stalled').text().includes('<b>человеку</b>'));
  assert.equal(wrapper.find('.stalled dd b').exists(), false);
});

for (const mode of ['ручной collapsed', 'global compact']) {
  test(`collapsed оставляет строку и действия: ${mode}`, async (t) => {
    const { wrapper } = await mountStallPipeline(t, stallFixture(), { compact: mode === 'global compact' });

    if (mode === 'ручной collapsed') {
      await wrapper.get('.chev').trigger('click');
    }

    const panel = wrapper.get('.stalled');

    assert.equal(wrapper.get('article.card').classes().includes('collapsed'), true);
    assert.equal(wrapper.find('.head').exists(), true);
    assert.equal(wrapper.find('.progress').exists(), true);
    assert.match(panel.text(), /Вливание в dev.*агент не вернул результат/s);
    assert.ok(!panel.text().includes(exhaustedStop.hint));
    assert.ok(!panel.text().includes(exhaustedStop.comment));
    assert.ok(!panel.text().includes(exhaustedStop.presentation.summary));
    assert.equal(panel.find('dl').exists(), false);
    assert.equal(Boolean(disclosure(panel)), false);
    assert.equal(actionButtons(wrapper, 'продолжить прогон').length, 1);
    assert.equal(actionButtons(wrapper, 'закрыть задачу').length, 1);
  });
}

const actions = [
  ['human', human, {}, {}, ['ответить и продолжить', 'продолжить прогон', 'закрыть задачу']],
  ['exhausted', exhaustedStop, {}, {}, ['ответить и продолжить', 'продолжить прогон', 'закрыть задачу']],
  ['no-progress', noProgress, {}, {},
    ['Разбор остановки', 'разобрать остановку', 'продолжить прогон', 'закрыть задачу']],
  ['решение арбитра', { ...noProgress, arbiter }, {}, {},
    ['Разбор остановки', 'разобрать остановку', 'продолжить прогон', 'закрыть задачу']],
  ['SANDBOX isolated', sandbox, {}, {}, ['перезапустить стенд', 'продолжить прогон', 'закрыть задачу']],
  ['SANDBOX shared', sandbox, { workspaceMode: 'shared' }, { fePort: 13000 },
    ['продолжить прогон', 'закрыть задачу']],
  ['crashed', { ...exhaustedStop, kind: 'crashed' }, {}, { fePort: 13000 },
    ['продолжить прогон', 'снести стенд']],
  ['bootstrap вопрос', {
    ...human,
    phase: 'bootstrap',
    stage: 'SCOUT',
  }, {},
    { nodeOrigins: { ship: { scope: 'bootstrap', originId: 'scout' } } },
    ['ответить и продолжить', 'продолжить прогон', 'закрыть задачу']],
  ['bootstrap ответ', {
    ...human,
    phase: 'bootstrap',
    stage: 'SCOUT',
    bootstrap: { state: 'answered' },
  }, {},
    { nodeOrigins: { ship: { scope: 'bootstrap', originId: 'scout' } } },
    ['ответить и продолжить', 'продолжить прогон', 'закрыть задачу']],
];
const allActions = [
  'ответить и продолжить', 'разбор и решение', 'разобрать и продолжить', 'перезапустить стенд',
  'Разбор остановки', 'разобрать остановку', 'продолжить прогон', 'остановить',
  'снести стенд', 'закрыть задачу',
];

for (const [name, stop, task, graph, expected] of actions) {
  for (const mode of ['expanded', 'collapsed', 'compact']) {
    test(`каждое действие один раз: ${name}, ${mode}`, async (t) => {
      const { wrapper } = await mountStallPipeline(t, stallFixture(stop, task, graph), {
        compact: mode === 'compact',
      });

      if (mode === 'collapsed') {
        await wrapper.get('.chev').trigger('click');
      }

      for (const label of allActions) {
        assert.equal(actionButtons(wrapper, label).length, expected.includes(label) ? 1 : 0, label);
      }

      const primary = name.startsWith('bootstrap') || name === 'human'
        ? 'ответить и продолжить'
        : name === 'решение арбитра' ? 'Разбор остановки'
          : name === 'no-progress' ? 'разобрать остановку'
            : name === 'SANDBOX isolated' ? 'перезапустить стенд' : 'продолжить прогон';
      const primaryButtons = wrapper.findAll('.stalled button').filter((button) => (
        button.attributes('data-variant') === 'solid'
      ));

      assert.equal(primaryButtons.length, 1, 'главное действие одно');
      assert.ok(primaryButtons[0].text().includes(primary), primary);

      if (name.startsWith('SANDBOX')) {
        assert.doesNotMatch(wrapper.get('.stalled').text(), /SANDBOX/);
        assert.match(wrapper.get('.stalled').text(), /Стенд/);
      }
    });
  }
}

test('tooltip и одно главное действие', async (t) => {
  const { wrapper } = await mountStallPipeline(t, stallFixture(noProgress));
  const panel = wrapper.get('.stalled');
  const buttons = panel.findAll('button').filter((button) => !/подробнее/i.test(button.text()));

  assert.equal(panel.find('.sfixhint').exists(), false);
  assert.equal(buttons.filter((button) => button.attributes('data-variant') === 'solid').length, 1);
  assert.equal(actionButtons(wrapper, 'разобрать остановку')[0].attributes('data-variant'), 'solid');

  for (const button of buttons) {
    assert.ok(button.attributes('data-ui-tooltip')?.trim(), button.text());
    assert.ok(button.attributes('aria-description')?.trim(), button.text());
    assert.equal(button.attributes('title'), undefined);
  }
});

for (const [actor, mode] of ['auto', 'human'].flatMap((actor) => (
  ['expanded', 'collapsed', 'compact'].map((mode) => [actor, mode])
))) {
  test(`один alert становится status: ${actor}, ${mode}`, async (t) => {
    const fixture = stallFixture(noProgress, {
      arbitrating: {
        actor,
        model: 'example-arbiter',
        startedAt: Date.now(),
        elapsedSec: 95,
      },
    });
    const { wrapper } = await mountStallPipeline(t, fixture, { compact: mode === 'compact' });

    if (mode === 'collapsed') {
      await wrapper.get('.chev').trigger('click');
    }

    assert.equal(wrapper.findAll('article.card [role="alert"]').length, 0);
    assert.equal(wrapper.findAll('article.card [role="status"]').length, 1);
    assert.match(wrapper.get('.stalled').text(), /Арбитр разбирает остановку/);
    assert.match(wrapper.get('.stalled').text(), actor === 'auto' ? /сам/ : /по кнопке/);
    assert.match(wrapper.get('.stalled').text(), /1 мин/);
    assert.match(wrapper.get('.stalled').text(), /нужно решение человека/);
    assert.equal(actionButtons(wrapper, 'разобрать остановку').length, 0);
  });
}

for (const mode of ['expanded', 'collapsed', 'compact']) {
  test(`панель объявляет остановку одним alert: ${mode}`, async (t) => {
    const { wrapper } = await mountStallPipeline(t, stallFixture(), { compact: mode === 'compact' });

    if (mode === 'collapsed') {
      await wrapper.get('.chev').trigger('click');
    }

    assert.equal(wrapper.findAll('article.card [role="alert"]').length, 1);
    assert.equal(wrapper.get('.stalled').attributes('role'), 'alert');
  });
}

for (const [name, task, graph, selector] of [
  ['идущая', { daemonAlive: true }, { statuses: { ship: 'run' } }, '.sbstop'],
  ['доделанная', { result: 'completed' }, { statuses: { ship: 'done' } }, '.sbclose'],
  ['пауза', {}, {}, '.sbresume'],
]) {
  test(`свёрнутая карточка без остановки даёт действия подвала по одному разу: ${name}`, async (t) => {
    const { wrapper } = await mountStallPipeline(t, stallFixture(null, task, graph), { compact: true });

    assert.equal(wrapper.findAll(selector).length, 1);
    assert.equal(wrapper.find('.stalled').exists(), false);
  });
}

for (const [name, task, graph, absent] of [
  ['readOnly', { readOnly: true }, { readOnly: true }, allActions],
  ['нет attempt', { attempt: null }, {}, ['продолжить прогон']],
  ['completed', { result: 'completed' }, {}, ['продолжить прогон']],
  ['abandoned', { result: 'abandoned' }, {}, ['продолжить прогон']],
  ['daemonAlive', { daemonAlive: true }, {}, ['ответить и продолжить', 'разбор и решение',
    'Разбор остановки', 'разобрать остановку', 'продолжить прогон']],
  ['стенд строится', {}, { sandbox: {
    step: 1,
    total: 3,
    label: 'Сборка',
  } }, ['закрыть задачу']],
]) {
  for (const mode of ['expanded', 'collapsed', 'compact']) {
    test(`прежние гейты не расширяют права: ${name}, ${mode}`, async (t) => {
      const { wrapper } = await mountStallPipeline(t, stallFixture(noProgress, task, graph), {
        compact: mode === 'compact',
      });

      if (mode === 'collapsed') {
        await wrapper.get('.chev').trigger('click');
      }

      for (const label of absent) {
        assert.equal(actionButtons(wrapper, label).length, 0, label);
      }
    });
  }
}

for (const [label, stop, task, graph, endpoint] of [
  ['продолжить прогон', exhaustedStop, {}, {}, '/resume'],
  ['перезапустить стенд', sandbox, {}, {}, '/sandbox/retry'],
  ['остановить', null, { daemonAlive: true }, {}, '/stop'],
  ['снести стенд', exhaustedStop, {}, { fePort: 13000 }, '/sandbox/down'],
  ['закрыть задачу', exhaustedStop, {}, {}, '/close'],
]) {
  test(`клик сохраняет прежний запрос и отмену подтверждения: ${label}`, async (t) => {
    const { wrapper, harness, posts, flushPromises } = await mountStallPipeline(
      t, stallFixture(stop, task, graph),
    );
    const button = actionButtons(wrapper, label)[0];

    assert.ok(button, `нет действия ${label}`);
    harness.confirmed = false;
    await button.trigger('click');
    await flushPromises();

    assert.equal(posts.length, 0);
    harness.confirmed = true;
    await button.trigger('click');
    await flushPromises();

    assert.deepEqual(posts.map((post) => post.url), [`/api/tasks/42${endpoint}`]);
  });
}

test('busy не дублирует запрос продолжения', async (t) => {
  const { wrapper, harness, posts, flushPromises } = await mountStallPipeline(t);
  let finish;

  harness.pending = new Promise((resolve) => {
    finish = resolve;
  });

  t.after(() => finish());

  const button = actionButtons(wrapper, 'продолжить прогон')[0];

  await button.trigger('click');
  await flushPromises();
  await button.trigger('click');
  await flushPromises();

  assert.equal(posts.length, 1);
  finish();
  await flushPromises();
});

test('другая остановка закрывает старые подробности панели', async (t) => {
  const { wrapper, harness, flushPromises } = await mountStallPipeline(t);
  const button = disclosure(wrapper);

  assert.ok(button, 'нет раскрытия подробностей');
  await button.trigger('click');

  harness.fixture = stallFixture(human);
  globalThis.__stallPanelSseHandler('state-change', { task: '42' });
  await new Promise((resolve) => {
    setTimeout(resolve, 1000);
  });
  await flushPromises();

  const next = disclosure(wrapper);

  assert.ok(next);
  assert.equal(next.attributes('aria-expanded'), 'false');
  assert.equal(wrapper.findAll('.stalled dl').filter((item) => item.isVisible()).length, 0);
  assert.match(wrapper.get('.stalled').text(), /нужно решение человека/);
});

test('подробнее разных карточек имеет уникальные controls и независимое состояние', async (t) => {
  const fixture = stallFixture();

  fixture.additionalTasks = [{ ...fixture.factoryTask, task: 43 }];

  const { wrapper } = await mountStallPipeline(t, fixture);
  const cards = wrapper.findAll('article.card');
  const buttons = cards.map((card) => disclosure(card));

  assert.equal(cards.length, 2);
  assert.ok(buttons.every(Boolean), 'у каждой карточки есть подробнее');

  const controls = buttons.map((button) => button.attributes('aria-controls'));

  assert.ok(controls.every(Boolean));
  assert.equal(new Set(controls).size, 2);
  await buttons[0].trigger('click');

  assert.equal(buttons[0].attributes('aria-expanded'), 'true');
  assert.equal(buttons[1].attributes('aria-expanded'), 'false');
});
