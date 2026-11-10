import assert from 'node:assert/strict';
import test from 'node:test';

import { mountTrackerBoard, openTrackerSettings, actionButton } from './helpers/trackerBoard.js';
import {
  mountMultiBoard, multiCatalog, MULTI_TASKS, SOURCE_A, SOURCE_B,
} from './helpers/trackerMultiView.js';
import { selectBoardTasks } from '../../web/src/shared/boardTaskList.ts';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { installBrowser } from './helpers/board-view.js';
import { mountTrackerCard, cardButton } from './helpers/trackerCard.js';

process.env.NODE_ENV = 'test';

test('MD-SETTINGS-UI: включения A/B независимы, default выбирается отдельно', async (t) => {
  const catalog = multiCatalog();
  const card = await mountTrackerBoard(t, {
    catalog,
    handlers: {
      get: async (url, state) => {
        if (url === '/api/trackers/settings') {
          return {
            ...state.settings,
            drivers: ['fixture-a', 'fixture-b'],
            default: 'fixture-b',
            externalId: 'fixture-b',
          };
        }
      },
    },
  });

  await openTrackerSettings(card);
  assert.equal(card.wrapper.findAll('[data-role="tracker-enabled"]').length, 2);
  assert.equal(card.wrapper.get('[data-driver="fixture-a"] [data-role="tracker-enabled"]').text(), 'Включён');
  assert.equal(card.wrapper.get('[data-driver="fixture-b"] [data-role="tracker-in-use"]').text(),
    'По умолчанию');
  assert.equal(card.wrapper.find('[data-driver="fixture-a"] [data-role="tracker-in-use"]').exists(), false);

  const choices = card.wrapper.get('#tracker-driver-native').findAll('option').map((option) => option.text());

  assert.deepEqual(choices, ['Альфа · Включён', 'Бета · Включён · По умолчанию']);
  await card.wrapper.get('[data-driver="fixture-a"]').trigger('click');
  await card.flushPromises();
  assert.equal(card.wrapper.get('[data-role="tracker-board-enabled"]').element.checked, true,
    'A включён одновременно с B, хотя default B');
  assert.equal(card.wrapper.get('[data-role="tracker-editor-enabled"]').text(), 'Включён');
  assert.equal(card.wrapper.find('[data-role="tracker-editor-in-use"]').exists(), false);
  await card.wrapper.get('[data-role="tracker-board-enabled"]').setValue(false);
  assert.equal(card.wrapper.get('[data-driver="fixture-a"] [data-role="tracker-enabled"]').text(), 'Включён',
    'Несохранённый флажок не меняет чип действующего подключения');
  await card.wrapper.get('[data-role="tracker-board-enabled"]').setValue(true);
  await card.wrapper.get('[data-driver="fixture-b"]').trigger('click');
  await card.flushPromises();
  assert.equal(card.wrapper.get('[data-role="tracker-board-enabled"]').element.checked, true);
  assert.equal(card.wrapper.get('[data-role="tracker-editor-enabled"]').text(), 'Включён');
  assert.equal(card.wrapper.get('[data-role="tracker-editor-in-use"]').text(), 'По умолчанию');

  assert.equal(card.wrapper.get('[data-role="tracker-make-default"]').element.disabled, true,
    'Текущий черновой дефолт уже выбран');
  await card.wrapper.get('[data-driver="fixture-a"]').trigger('click');
  await card.wrapper.get('[data-role="tracker-board-enabled"]').setValue(false);

  const makeDefault = card.wrapper.get('[data-role="tracker-make-default"]');

  assert.equal(makeDefault.text(), 'По умолчанию');
  assert.equal(makeDefault.element.disabled, false, 'Выключенный доступный драйвер можно назначить основным');
  await makeDefault.trigger('click');
  assert.equal(card.wrapper.get('[data-role="tracker-board-enabled"]').element.checked, true,
    'Назначение основной доски включает её');
  assert.equal(makeDefault.element.disabled, true);
  assert.equal(makeDefault.attributes('aria-pressed'), 'true');
  assert.equal(card.state.catalog.default, 'fixture-b', 'До сохранения действует прежняя основная доска');
  assert.equal(card.apiCalls.some((call) => call.method === 'POST'), false);
  await card.wrapper.get('[data-driver="fixture-b"]').trigger('click');
  assert.equal(card.wrapper.get('[data-driver="fixture-b"] [data-role="tracker-in-use"]').text(),
    'По умолчанию', 'Несохранённый дефолт не перемещает чип');
  await actionButton(card.wrapper, /^Сохранить$/u).trigger('click');
  await card.flushPromises();

  const write = card.apiCalls.find((call) => call.method === 'POST' && call.url === '/api/trackers/settings');

  assert.deepEqual(write.payload.drivers.toSorted(), ['fixture-a', 'fixture-b']);
  assert.equal(write.payload.default, 'fixture-a');
  assert.equal(card.wrapper.get('[data-driver="fixture-a"] [data-role="tracker-in-use"]').text(),
    'По умолчанию');
  assert.equal(card.wrapper.find('[data-role="tracker-editor-in-use"]').exists(), false);
  assert.equal(card.wrapper.findAll('[data-role="tracker-enabled"]').length, 2);
});

test('MD-CHIPS: лента, related и избранное показывают PNG A, монограмму B и GrigDesk', async (t) => {
  const own = {
    id: '100000000001',
    source: 'grigdesk',
    title: 'Собственная задача',
    description: 'Текст собственной задачи',
    projectId: 'beta',
    projectTitle: 'Проект beta',
    sourceUrl: 'http://client.fixture/#/board?openTask=100000000001',
    createdAt: '2026-10-24T00:00:00Z',
  };
  const card = await mountMultiBoard(t, {
    created: MULTI_TASKS,
    favorites: { taskIds: ['42'] },
    ownApi: {
      get: async (url) => url === '/api/grigdesk-tasks/projects' ? { projects: [] }
        : {
          tasks: [own],
          revision: 1,
          trackerConfigured: true,
        },
    },
  });
  const rows = card.wrapper.findAll('li.trow');

  assert.equal(rows.length, 3);
  assert.match(rows.find((row) => row.text().includes('Задача A')).text(), /Альфа/u);
  assert.match(rows.find((row) => row.text().includes('Задача B')).text(), /Бета/u);
  assert.match(rows.find((row) => row.text().includes('Собственная задача')).text(), /GrigDesk/u);
  assert.equal(rows.find((row) => row.text().includes('Задача A')).find('img')
    .attributes('src'), card.metadata.catalog.drivers[1].logoUrl);
  assert.equal(rows.find((row) => row.text().includes('Задача B')).find('img').exists(), false);
  assert.ok(rows.find((row) => row.text().includes('Задача B')).findAll('*')
    .some((item) => /^[Бб][а-яА-ЯёЁ]?$/u.test(item.text())), 'У B есть монограмма из имени');
  await card.wrapper.get('.favfilter').trigger('click');
  await card.flushPromises();
  assert.ok(card.wrapper.findAll('li.trow').every((row) => /Альфа|Бета/u.test(row.text())));
  assert.match(card.wrapper.find('.col.secondary').text(), /Альфа/u);
  assert.match(card.wrapper.find('.col.secondary').text(), /Бета/u);
});

test('MD-FILTER: id драйвера, поиск и проект работают через AND, [] сохраняет пустоту', () => {
  const tasks = [...MULTI_TASKS, {
    id: 43,
    source: SOURCE_A,
    title: 'Другой текст',
    group: 'Другой проект',
  }];
  const selected = selectBoardTasks({
    tasks,
    sources: ['fixture-a'],
    query: 'Задача',
    group: 'Общий проект',
  });

  assert.deepEqual(selected.map((task) => [task.source, task.id]), [[SOURCE_A, 42]]);
  assert.deepEqual(selectBoardTasks({ tasks, sources: [] }), []);

  const onlyB = selectBoardTasks({ tasks, sources: ['fixture-b'] });

  assert.deepEqual(onlyB.map((task) => task.source), [SOURCE_B]);
});

test('MD-UI-FAILURE: недоступный A сохраняет строки и причину, B/own доступны', async (t) => {
  const catalog = multiCatalog();

  Object.assign(catalog.drivers[1], { status: 'unavailable', reason: 'Сервис Альфа недоступен' });

  const card = await mountMultiBoard(t, { catalog });
  const rows = card.wrapper.findAll('li.trow');

  assert.equal(rows.length, 2);

  const a = rows.find((row) => row.text().includes('Задача A'));
  const accessible = [a.text(), ...a.findAll('[aria-label], [title]').map((item) =>
    item.attributes('aria-label') || item.attributes('title'))].join(' ');

  assert.match(accessible, /Сервис Альфа недоступен/u);
  assert.match(rows.find((row) => row.text().includes('Задача B')).text(), /Бета/u);
});

test('MD-CHIPS: полка различает taskSource и причину события, сохраняет пару при открытии', async (t) => {
  const browser = await installBrowser(t);
  const [{ mount }, { reactive }] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../web/node_modules/vue/index.mjs'),
  ]);
  const opened = [];
  const metadata = { catalog: multiCatalog(), async load() {} };
  const shelf = reactive({
    allRows: [SOURCE_A, SOURCE_B, 'grigdesk'].map((taskSource, index) => ({
      taskId: index === 2 ? '100000000001' : '42',
      taskSource,
      title: ['Карточка A', 'Карточка B', 'Своя карточка'][index],
      addedAt: '2026-11-01T00:00:00Z',
      reasonText: 'Жду ответ',
      state: 'lit',
      source: 'comments',
      message: 'Новый комментарий',
      completed: false,
      details: {},
    })),
    loaded: true,
    loading: false,
    error: null,
    sourceIssues: [],
    isPending: () => false,
    async load() {},
    async acknowledge() {},
    async remove() {},
  });

  globalThis.__multiShelfPanel = {
    shelf,
    metadata,
    ui: { openTask: (...args) => opened.push(args) },
  };
  t.after(() => delete globalThis.__multiShelfPanel);

  const component = await compileVue(webFile('src/views/shelf/TaskShelfPanel.vue'), {
    stubs: {
      '../../stores/taskShelf.ts':
        'export const useTaskShelfStore = () => globalThis.__multiShelfPanel.shelf;',
      '../../stores/ui.ts': 'export const useUiStore = () => globalThis.__multiShelfPanel.ui;',
      '../../stores/trackers.ts':
        'export const useTrackersStore = () => globalThis.__multiShelfPanel.metadata;',
      '../stores/trackers.ts': 'export const useTrackersStore = () => globalThis.__multiShelfPanel.metadata;',
    },
  });
  const wrapper = mount(component, { attachTo: browser.document.querySelector('#mount') });

  t.after(() => wrapper.unmount());

  const rows = wrapper.findAll('[data-ui-task-shelf-row]');

  assert.equal(rows.length, 3);
  assert.match(rows[0].text(), /Альфа/u);
  assert.match(rows[1].text(), /Бета/u);
  assert.match(rows[2].text(), /GrigDesk/u);
  assert.equal(rows[0].get('img').attributes('src'), metadata.catalog.drivers[1].logoUrl);
  assert.equal(rows[1].find('img').exists(), false);
  await rows[1].get('.ui-selectable-row__primary').trigger('click');
  assert.deepEqual(opened, [['42', SOURCE_B]]);
});

test('MD-CHIPS: карточка A показывает источник и PNG при default B', async (t) => {
  const catalog = multiCatalog();
  const card = await mountTrackerCard(t, {
    trackerId: 'fixture-a',
    catalog,
    taskSource: SOURCE_A,
    boardSource: SOURCE_B,
    detail: { title: 'Карточка Альфа' },
  });

  assert.match(card.wrapper.text(), /Альфа/u);
  assert.equal(card.wrapper.findAll('img').some((image) =>
    image.attributes('src') === catalog.drivers[1].logoUrl), true);

  const image = card.wrapper.findAll('img')
    .find((item) => item.attributes('src') === catalog.drivers[1].logoUrl);

  await image.trigger('error');
  await card.flushPromises();
  assert.equal(card.wrapper.findAll('img').some((item) =>
    item.attributes('src') === catalog.drivers[1].logoUrl), false);
  assert.match(card.wrapper.text(), /Альфа/u);
  assert.ok(card.wrapper.findAll('*').some((item) => /^[Аа][а-яА-ЯёЁ]?$/u.test(item.text())),
    'Ошибка PNG оставляет монограмму источника');
});

test('MD-FILTER: переключение драйвера сбрасывает раскрытые страницы общего списка', async (t) => {
  const tasks = ['fixture-a', 'fixture-b'].flatMap((id, index) => Array.from({ length: 45 }, (_, item) => ({
    id: item + 1,
    source: index ? SOURCE_B : SOURCE_A,
    title: `${index ? 'Бета' : 'Альфа'} задача ${item + 1}`,
    group: 'Общий проект',
    timerElapsed: 0,
  })));
  const card = await mountMultiBoard(t, { tasks });
  const { t: translate } = await import('../../web/src/services/locale.ts');
  const sourceLabel = translate('core.boardSourceFilter');
  const sourceGroup = card.wrapper.get(`[role="group"][aria-label="${sourceLabel}"]`);
  const buttons = sourceGroup.findAll('button');
  const a = buttons.find((button) => button.text().includes('Альфа'));
  const b = buttons.find((button) => button.text().includes('Бета'));

  assert.ok(a, 'У каждого драйвера должен быть отдельный фильтр');
  assert.ok(b);
  await card.wrapper.get('[data-role="board-load-more"]').trigger('click');
  assert.equal(card.wrapper.findAll('li.trow').length, 80);
  await b.trigger('click');
  await card.flushPromises();
  assert.equal(card.wrapper.findAll('li.trow').length, 40);
  assert.ok(card.wrapper.findAll('li.trow').every((row) => row.text().includes('Альфа')));
  await a.trigger('click');
  await card.flushPromises();
  assert.equal(card.wrapper.findAll('li.trow').length, 0);
});

test('MD-CARD-ALL: TaskModal читает comments/users/groups именно карточки A', async (t) => {
  const card = await mountTrackerCard(t, {
    trackerId: 'fixture-a',
    catalog: multiCatalog(),
    taskSource: SOURCE_A,
    boardSource: SOURCE_B,
  });
  const edit = card.wrapper.find('[data-role="task-edit-open"]');

  assert.equal(edit.exists(), true, 'Редактирование A не зависит от совпадения с default B');
  await edit.trigger('click');
  await card.flushPromises();

  for (const suffix of ['task/42/comments', 'users', 'groups']) {
    assert.ok(card.calls.some((call) => call.method === 'GET'
      && call.url === `/api/tracker/fixture-a/${suffix}`), suffix);
  }

  assert.equal(card.calls.some((call) => call.url.startsWith('/api/tracker/fixture-b/')), false);
});

for (const changed of ['fixture-a', 'fixture-b']) {
  test(`MD-CONFIRM: подтверждение карточки A после смены ${changed} сохраняет свою цель`, async (t) => {
    const confirm = Promise.withResolvers();
    const catalog = multiCatalog();
    const card = await mountTrackerCard(t, {
      trackerId: 'fixture-a',
      catalog,
      taskSource: SOURCE_A,
      boardSource: SOURCE_B,
      confirm: () => confirm.promise,
    });

    t.after(() => confirm.resolve(false));

    const complete = cardButton(card.wrapper, 'Завершить');

    assert.ok(complete, 'Подтверждённый source A должен открыть действия карточки при default B');
    await complete.trigger('click');
    await card.flushPromises();

    const driver = card.metadata.drivers.find((entry) => entry.id === changed);

    driver.generation += 1;
    driver.source = `${changed}@${'c'.repeat(64)}`;
    card.metadata.revision += 1;

    for (const listener of card.listeners) {
      listener('trackers-changed', { externalId: 'fixture-b', revision: card.metadata.revision });
    }

    await card.flushPromises();
    confirm.resolve(true);
    await card.flushPromises();

    const effects = card.calls.filter((call) => call.method === 'POST' && call.url.endsWith('/complete'));

    assert.equal(effects.length, changed === 'fixture-a' ? 0 : 1);

    if (effects.length) {
      assert.equal(effects[0].url, '/api/tracker/fixture-a/task/42/complete');
      assert.equal(effects[0].options.headers['x-grigdesk-tracker-generation'], '1');
    }
  });
}
