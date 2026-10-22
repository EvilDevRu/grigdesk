import assert from 'node:assert/strict';
import test from 'node:test';

import { compileModule, webFile } from './helpers/compile-vue.js';
import { compileTaskModal } from './helpers/task-modal.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

const LABELS = {
  2: 'Ждёт выполнения',
  3: 'В работе',
  4: 'Сдана',
  5: 'Завершена',
  6: 'Отложена',
};

let nonce = 0;

// Настоящие карточка и кеш деталей работают с управляемым ответом портала.
// Подменяется только сеть и соседние stores: действия проходят через tasks.js.
async function mountCard(t, browser, {
  status = 5,
  timerRunning = false,
  confirmed = true,
  renewStatus = 3,
  renewError = null,
} = {}) {
  nonce += 1;

  const prefix = `__taskStatus${nonce}`;
  const [{ createPinia, defineStore }, { mount, flushPromises }] = await Promise.all([
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
  ]);
  const task = {
    id: 42,
    title: 'Проверка действий задачи',
    status,
    status_label: LABELS[status],
  };
  const calls = [];
  const confirmations = [];
  const useBoardStore = defineStore(`task-status-board-${nonce}`, {
    state: () => ({
      data: {
        tasks: [{ id: 42, timerRunning }],
        toReview: [],
        created: [],
      },
    }),
    actions: {
      async load(force) {
        calls.push(`board:${force}`);
      },
    },
  });
  const useUiStore = defineStore(`task-status-ui-${nonce}`, {
    state: () => ({ taskId: 42, launchRequested: false }),
    actions: {
      close() {
        this.taskId = null;
      },
      consumeTaskLaunch() {},
    },
  });
  const api = {
    // Детали копируются как сетевой ответ, чтобы кеш не менялся вместе с порталом.
    // Остальные запросы карточки получают пустые независимые ответы.
    async get(url) {
      if (url === '/api/b24/task/42') {
        calls.push(`GET:${url}`);

        return { ...task };
      }

      if (url === '/api/tasks') {
        return { tasks: [] };
      }

      return {};
    },
    // Мутация меняет источник, но не уже выданный кеш деталей.
    // Ошибка возобновления сохраняет прежний статус и проверяет общий путь ошибки.
    async post(url) {
      calls.push(`POST:${url}`);

      if (url.endsWith('/renew') && renewError) {
        throw new Error(renewError);
      }

      if (url.endsWith('/complete') || url.endsWith('/renew')) {
        task.status = url.endsWith('/complete') ? 5 : renewStatus;
        task.status_label = LABELS[task.status];
      }

      return { ok: true };
    },
  };
  const globals = {
    Api: api,
    BoardStore: useBoardStore,
    UiStore: useUiStore,
    ConfirmDialog: async (...args) => {
      confirmations.push(args);

      return confirmed;
    },
    AnalysisStore: () => ({
      async detail() {
        return {};
      },
    }),
    FavoritesStore: () => ({
      loaded: true,
      isFavorite: () => false,
      isPending: () => false,
      async load() {},
    }),
    SeenStore: () => ({ async markSeen() {} }),
  };

  for (const [suffix, value] of Object.entries(globals)) {
    globalThis[`${prefix}${suffix}`] = value;
  }

  let wrapper = null;

  t.after(() => {
    wrapper?.unmount();

    for (const suffix of [...Object.keys(globals), 'TasksStore']) {
      delete globalThis[`${prefix}${suffix}`];
    }
  });

  const module = await compileModule(webFile('src/stores/tasks.ts'), {
    stubs: {
      '../shared/apiClient.ts': `export const api = globalThis.${prefix}Api;`,
      './board.ts': `export const useBoardStore = globalThis.${prefix}BoardStore;`,
    },
  });

  globalThis[`${prefix}TasksStore`] = module.useTasksStore;

  const TaskModal = await compileTaskModal(prefix);
  const pinia = createPinia();

  wrapper = mount(TaskModal, {
    attachTo: browser.document.querySelector('#mount'),
    global: { plugins: [pinia], stubs: { teleport: true } },
  });

  await flushPromises();
  await flushPromises();

  const ui = useUiStore(pinia);

  // Открываем тот же компонент повторно, пока кеш ещё находится внутри TTL.
  // Счётчик GET отличает новое чтение от возврата сохранённой копии.
  async function reopen() {
    ui.close();
    await flushPromises();
    ui.taskId = 42;
    await flushPromises();
    await flushPromises();
  }

  return {
    wrapper,
    calls,
    confirmations,
    flushPromises,
    reopen,
    tasks: module.useTasksStore(pinia),
    ui,
  };
}

const footerButton = (wrapper, text) => wrapper.findAll('footer.controls button')
  .find((button) => button.text().trim() === text);

test('Действия карточки учитывают завершение и обновляют кеш после смены статуса', async (t) => {
  const browser = await installUiBrowser(t);

  await t.test('завершённая задача: только возобновление, запуск учёта закрыт с объяснением', async (s) => {
    const { wrapper } = await mountCard(s, browser);

    assert.equal(footerButton(wrapper, '✓ Завершить'), undefined);
    assert.equal(footerButton(wrapper, '↺ Возобновить')?.element.disabled, false);
    assert.equal(footerButton(wrapper, '▶ Начать учёт')?.element.disabled, true);
    assert.equal(
      footerButton(wrapper, '▶ Начать учёт')?.attributes('data-ui-tooltip'),
      'Задача завершена — сначала возобновите её',
    );
  });

  await t.test('идущий учёт завершённой задачи можно остановить', async (s) => {
    const { wrapper, calls, flushPromises } = await mountCard(s, browser, { timerRunning: true });
    const stop = footerButton(wrapper, '⏸ Остановить учёт');

    assert.equal(stop?.element.disabled, false);
    assert.equal(stop?.attributes('data-ui-tooltip'), undefined);
    await stop.trigger('click');
    await flushPromises();
    assert.ok(calls.includes('POST:/api/b24/task/42/timer/pause'));
  });

  for (const status of [2, 3, 4, 6]) {
    await t.test(`статус «${LABELS[status]}» сохраняет прежние действия`, async (s) => {
      const { wrapper, calls, flushPromises } = await mountCard(s, browser, { status });

      assert.equal(footerButton(wrapper, '↺ Возобновить'), undefined);
      assert.equal(footerButton(wrapper, '✓ Завершить')?.element.disabled, false);
      assert.equal(footerButton(wrapper, '▶ Начать учёт')?.element.disabled, false);
      assert.equal(footerButton(wrapper, '▶ Начать учёт')?.attributes('data-ui-tooltip'), undefined);
      await footerButton(wrapper, '▶ Начать учёт').trigger('click');
      await flushPromises();
      assert.ok(calls.includes('POST:/api/b24/task/42/timer/start'));
    });
  }

  await t.test('подтверждение возобновляет, перечитывает доску и берёт статус из GET', async (s) => {
    const { wrapper, calls, confirmations, flushPromises, reopen } = await mountCard(s, browser, {
      renewStatus: 2,
    });

    await footerButton(wrapper, '↺ Возобновить').trigger('click');
    await flushPromises();
    assert.deepEqual(confirmations, [['Возобновить задачу?', { okText: 'Возобновить' }]]);
    assert.deepEqual(calls, [
      'GET:/api/b24/task/42',
      'POST:/api/b24/task/42/renew',
      'board:true',
      'GET:/api/b24/task/42',
    ]);
    assert.equal(wrapper.get('.task-status').text(), 'Ждёт выполнения');
    assert.equal(footerButton(wrapper, '↺ Возобновить'), undefined);
    assert.equal(footerButton(wrapper, '✓ Завершить')?.element.disabled, false);
    assert.equal(footerButton(wrapper, '▶ Начать учёт')?.element.disabled, false);
    await reopen();
    assert.equal(wrapper.get('.task-status').text(), 'Ждёт выполнения');
  });

  await t.test('отказ в подтверждении ничего не меняет', async (s) => {
    const { wrapper, calls, confirmations, flushPromises } = await mountCard(s, browser, {
      confirmed: false,
    });

    await footerButton(wrapper, '↺ Возобновить').trigger('click');
    await flushPromises();
    assert.equal(confirmations.length, 1);
    assert.deepEqual(calls, ['GET:/api/b24/task/42']);
    assert.equal(wrapper.get('.task-status').text(), 'Завершена');
  });

  await t.test('ошибка портала остаётся в открытой карточке', async (s) => {
    const { wrapper, calls, flushPromises, ui } = await mountCard(s, browser, {
      renewError: 'Портал не разрешил возобновить задачу',
    });

    await footerButton(wrapper, '↺ Возобновить').trigger('click');
    await flushPromises();
    assert.equal(ui.taskId, 42);
    assert.equal(wrapper.get('.malerts .err').text(), 'Портал не разрешил возобновить задачу');
    assert.equal(footerButton(wrapper, '↺ Возобновить')?.element.disabled, false);
    assert.deepEqual(calls, ['GET:/api/b24/task/42', 'POST:/api/b24/task/42/renew']);
  });

  await t.test('после завершения повторное открытие читает новый статус без ожидания TTL', async (s) => {
    const { wrapper, calls, flushPromises, reopen, tasks, ui } = await mountCard(s, browser, { status: 3 });

    await footerButton(wrapper, '✓ Завершить').trigger('click');
    await flushPromises();
    assert.equal(ui.taskId, null);
    // Конвейер берёт название задачи из того же кеша: устаревший статус его не стирает.
    assert.equal(tasks.title(42), 'Проверка действий задачи');
    await reopen();
    assert.equal(wrapper.get('.task-status').text(), 'Завершена');
    assert.equal(footerButton(wrapper, '✓ Завершить'), undefined);
    assert.deepEqual(calls, [
      'GET:/api/b24/task/42',
      'POST:/api/b24/task/42/complete',
      'board:true',
      'GET:/api/b24/task/42',
    ]);
  });
});
