import assert from 'node:assert/strict';
import test from 'node:test';

import { compileTaskModal } from './helpers/task-modal.js';
import { installUiBrowser } from './helpers/ui-components.js';
import { disclosure, exhaustedStop, stallFixture, stopDetails } from './helpers/pipeline-stall-fixtures.js';

process.env.NODE_ENV = 'test';

/**
 * Окно читает синтетические summary и graph через свои прежние сетевые порты.
 * Оба представления используют настоящий TaskModal, stores изолированы новой Pinia.
 */
async function mountTaskStop(t, presentation, { legacy = false, graphError = false } = {}) {
  const browser = await installUiBrowser(t, 'http://grigdesk.test/#/board');
  const [{ mount, flushPromises }, { createPinia, defineStore }] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
  ]);
  const first = structuredClone(exhaustedStop);

  if (legacy) {
    delete first.presentation;
    first.title = 'SHIP: нужно решение человека';
  }

  const stops = {
    42: first,
    43: {
      kind: 'human',
      stage: 'SHIP',
      title: 'SHIP: другая задача ждёт ответа',
      hint: 'Подсказка другой задачи.',
      presentation: {
        reason: 'другая задача ждёт ответа',
        summary: 'Откройте новый вопрос.',
        details: { what: 'Новый вопрос.', action: 'Дайте новый ответ.' },
      },
    },
  };
  const calls = [];
  const globals = {
    Api: {
      /**
       * Сводка и граф отвечают из одного набора остановок по текущей задаче.
       * Ошибка графа моделируется только в явно заданном сценарии совместимости.
       */
      async get(url) {
        calls.push(url);

        if (url === '/api/tasks') {
          return {
            tasks: Object.entries(stops).map(([task, stall]) => ({
              task,
              stall,
              attempt: 'a_test',
            })),
          };
        }

        if (url.endsWith('/graph')) {
          if (graphError) {
            throw new Error('Граф недоступен');
          }

          const taskId = url.split('/')[3];

          return stallFixture(stops[taskId]).graph;
        }

        return {};
      },
      async post() {
        return { ok: true };
      },
    },
    UiStore: defineStore('task-stop-ui', {
      state: () => ({ taskId: 42, launchRequested: false }),
      actions: {
        close() {
          this.taskId = null;
        },
        consumeTaskLaunch() {},
      },
    }),
    TasksStore: defineStore('task-stop-tasks', {
      actions: {
        async load(id) {
          return {
            id,
            title: `Задача ${id}`,
            status: 3,
            description: 'Описание задачи',
          };
        },
      },
    }),
    BoardStore: defineStore('task-stop-board', { state: () => ({ data: null }) }),
    FavoritesStore: () => ({
      loaded: true,
      isFavorite: () => false,
      isPending: () => false,
      async load() {},
    }),
    SeenStore: () => ({ async markSeen() {} }),
    AnalysisStore: () => ({
      async detail() {
        return {};
      },
    }),
    PluginsStore: () => ({ enabled: () => false, byId: () => ({ enabled: false }) }),
  };

  for (const [suffix, value] of Object.entries(globals)) {
    globalThis[`__taskStop${suffix}`] = value;
  }

  const compiled = await compileTaskModal('__taskStop');

  const pinia = createPinia();
  const wrapper = mount(compiled, {
    attachTo: browser.document.querySelector('#mount'),
    props: { presentation },
    global: { plugins: [pinia], stubs: { teleport: true } },
  });

  t.after(() => {
    wrapper.unmount();

    for (const suffix of Object.keys(globals)) {
      delete globalThis[`__taskStop${suffix}`];
    }
  });

  await flushPromises();
  await flushPromises();

  return {
    wrapper,
    calls,
    ui: globals.UiStore(pinia),
    flushPromises,
  };
}

for (const presentation of ['dialog', 'document']) {
  test(`короткая остановка раскрывает полки: ${presentation}`, async (t) => {
    const { wrapper, calls } = await mountTaskStop(t, presentation);
    const panel = wrapper.get('.convstall');

    assert.equal(calls.filter((url) => url === '/api/tasks').length, 1);
    assert.equal(calls.filter((url) => url === '/api/tasks/42/graph').length, 1);
    assert.match(panel.text(), /агент не вернул результат/);
    assert.ok(!panel.text().includes(exhaustedStop.hint));

    const button = disclosure(panel);

    assert.ok(button, 'окно задачи должно давать подробнее');
    assert.equal(button.attributes('aria-expanded'), 'false');
    await button.trigger('click');

    assert.equal(button.attributes('aria-expanded'), 'true');
    assert.deepEqual(panel.findAll('dt').map((item) => item.text()), [
      'Что случилось', 'Возможная причина', 'Что уцелело', 'Что делать',
    ]);
    assert.deepEqual(panel.findAll('dd').map((item) => item.text()), Object.values(stopDetails));
    assert.equal(calls.filter((url) => url === '/api/tasks').length, 1);
  });

  test(`другая задача закрывает старые подробности: ${presentation}`, async (t) => {
    const { wrapper, ui, flushPromises } = await mountTaskStop(t, presentation);
    const button = disclosure(wrapper.get('.convstall'));

    assert.ok(button, 'нет раскрытия подробностей');
    await button.trigger('click');

    ui.taskId = 43;
    await flushPromises();
    await flushPromises();

    const panel = wrapper.get('.convstall');
    const next = disclosure(panel);

    assert.match(panel.text(), /другая задача ждёт ответа/);
    assert.ok(next);
    assert.equal(next.attributes('aria-expanded'), 'false');
    assert.equal(panel.findAll('dl').filter((item) => item.isVisible()).length, 0);
    assert.ok(!panel.text().includes(stopDetails.what));
  });

  test(`старый DTO и отказ graph не дают пустой блок: ${presentation}`, async (t) => {
    const { wrapper, calls } = await mountTaskStop(t, presentation, { legacy: true, graphError: true });
    const panel = wrapper.get('.convstall');

    assert.match(panel.text(), /нужно решение человека/);
    assert.equal(calls.filter((url) => url === '/api/tasks/42/graph').length, 1);

    const button = disclosure(panel);

    assert.ok(button, 'запасной вид тоже раскрывает полные данные');
    await button.trigger('click');

    assert.ok(panel.text().includes(exhaustedStop.hint));
    assert.ok(panel.findAll('dd').every((item) => item.text().trim()));
  });
}
