import assert from 'node:assert/strict';
import test from 'node:test';
import { mountSurface, propCases, portCases } from './fixtures/loading/component.mjs';
import { settingsHarness } from './helpers/settings-harness.js';
import { CUSTOM_CAPS, trackerMetadata } from './helpers/trackerCard.js';

for (const spec of [...propCases, ...portCases].filter((item) => !item.browserOnly)) {
    test(`LOAD-SURFACE-${spec.id}: pending, настоящий ready и пустой успех`, async (t) => {
        const h = await mountSurface(t, spec);
        const pendingBricks = h.wrapper.findAll('[data-ui-skeleton]').length;
        const announced = h.wrapper.find('[role="status"]').text();

        await h.ready();
        assert.equal(h.wrapper.find(spec.readySelector).exists(), true, 'ready-фикстура корректна');
        assert.equal(h.wrapper.find('[data-ui-skeleton]').exists(), false);
        assert.ok(announced.length > 0, 'статус первого чтения объявлен');
        assert.ok(pendingBricks > 0, `${spec.id}: первое открытие собрано из общих кирпичиков`);
    });

    if (spec.endpoint && spec.retryText && !spec.port) {
        test(`LOAD-ERROR-RETRY-${spec.id}: отказ и прежний повтор`, async (t) => {
            const h = await mountSurface(t, spec);

            h.pending.reject(new Error('Синтетический отказ'));

            const { flushPromises } = await import(
                '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
            );

            await flushPromises();
            await flushPromises();
            assert.match(h.wrapper.text(), /Синтетический отказ/);
            assert.equal(h.wrapper.find('[data-ui-skeleton]').exists(), false);
            assert.equal(h.wrapper.find('[data-ui-loading]').exists(), false);
            h.reset();

            const retry = h.wrapper.findAll('button').find((button) => button.text() === spec.retryText);

            assert.ok(retry, 'прежняя кнопка повтора доступна');
            await retry.trigger('click');
            assert.equal(h.calls.length, 2);
            await h.ready();
            assert.equal(h.wrapper.find(spec.readySelector).exists(), true);
            assert.equal(h.wrapper.find('[data-ui-loading]').exists(), false);
        });
    }
    if (spec.empty || spec.emptyState || spec.emptyResponse) {
        test(`LOAD-SURFACE-${spec.id}-empty: пустой ответ прекращает ожидание`, async (t) => {
            const h = await mountSurface(t, spec);

            await h.ready(true);
            assert.equal(h.wrapper.find('[data-ui-skeleton]').exists(), false);
            assert.equal(h.wrapper.find('[data-ui-loading]').exists(), false);
        });
    }
    if (spec.failure) {
        test(`LOAD-ERROR-RETRY-${spec.id}: сохранённый отказ подавляет каркас при повторе`, async (t) => {
            const h = await mountSurface(t, spec);

            await h.wrapper.setProps(spec.failure);
            assert.equal(h.wrapper.find('[data-ui-skeleton]').exists(), false);
            assert.equal(h.wrapper.find('.ui-loading-state__skeleton').exists(), false);

            if (spec.retryEvent) {
                const retry = h.wrapper.findAll('button').find((button) => button.text() === spec.retryText);

                assert.ok(retry);
                await retry.trigger('click');
                assert.equal(h.wrapper.emitted(spec.retryEvent)?.length, 1);
            }

            await h.wrapper.setProps({
              ...spec.ready,
              error: ''
            });
            assert.equal(h.wrapper.find('[data-ui-skeleton]').exists(), false);
        });
    }
}

const settingsCases = [
    ['preferences', 'automation.chats', 'PreferencesPage', '/api/settings/prefs', 'prefs'],
    ['speech', 'speech.advanced', 'SpeechPage', '/api/settings/speech', 'speech'],
    ['processes', 'system.processes', 'ProcessesPage', '/api/chat/sessions', null],
    [
        'diagnostics',
        'system.diagnostics',
        'DiagnosticsPage',
        '/api/settings/factory-debug?scope=global',
        null
    ],
];

for (const [id, page, component, endpoint, dataKey] of settingsCases) {
    test(`LOAD-SURFACE-settings-${id}: каркас до подтверждённой формы`, async (t) => {
        const pending = Promise.withResolvers();
        const h = await settingsHarness(t, page, component, {
            prepare({ control }) {
                control.handlers[endpoint] = () => pending.promise;
            },
        });
        const pendingBricks = h.wrapper.findAll('[data-ui-skeleton]').length;
        const response = dataKey ? h.control.data[dataKey] : id === 'processes'
            ? {
              sessions: [],
              limits: {
              maxSessions: 4,
              idleMs: 60000
            }
            }
            : {
                configured: 'off',
                effective: 'off',
                source: 'global',
                expiresAt: 0
            };

        pending.resolve(Response.json(response));
        await h.flushPromises();
        await h.flushPromises();
        assert.equal(
            h.wrapper.find('[role="alert"]').exists(),
            false,
            'ответ принят настоящим декодером'
        );
        assert.equal(h.wrapper.find('[data-ui-loading]').exists(), false, 'успех снимает ожидание');
        assert.ok(pendingBricks > 0, `${id}: первое чтение показывает форму или facts из UiSkeleton`);
    });
}

// Helper сохраняет настоящий TaskModal и его управляющие ветки.
// Он откладывает только подтверждение данных, как сетевой транспорт экрана.
const { mountLoadingTask } = await import('./fixtures/loading/task.mjs');

test('LOAD-SURFACE-task-options: готовые поля не дублируются каркасом справочников', async (t) => {
    const h = await mountLoadingTask(t);
    const pendingFields = h.wrapper.findAll('.task-edit .ui-field').length;
    const skeletons = h.wrapper.findAll('.task-edit [data-ui-skeleton]');

    assert.equal(h.wrapper.get('[data-role="task-edit-responsible"]').attributes('disabled'), '');
    assert.equal(h.wrapper.get('[data-role="task-edit-group"]').attributes('disabled'), '');
    h.resolveOptions();
    await h.flush();
    await h.flush();
    assert.equal(h.wrapper.findAll('.task-edit .ui-field').length, pendingFields);
    assert.equal(h.wrapper.find('.task-edit [data-ui-loading]').exists(), false);
    assert.equal(skeletons.length, 1, 'вместо прежней inline-строки только один низкий ряд');
});

test('LOAD-ERROR-RETRY-task-options: прежний повтор справочников отключает только свои поля', async (t) => {
    const h = await mountLoadingTask(t);

    h.failOptions();
    await h.flush();
    await h.flush();
    assert.equal(h.wrapper.find('[data-ui-skeleton]').exists(), false);
    assert.match(h.wrapper.text(), /Не удалось загрузить: исполнителей и проекты/);
    h.resetOptions();
    await h.wrapper.get('[data-role="task-edit-options-retry"]').trigger('click');
    assert.equal(h.calls.filter((url) => url === '/api/tracker/users').length, 2);
    assert.equal(h.wrapper.get('[data-role="task-edit-group"]').attributes('disabled'), '');
    h.resolveOptions();
    await h.flush();
    await h.flush();
    assert.equal(h.wrapper.find('[data-ui-skeleton]').exists(), false);
    assert.equal(h.wrapper.find('[data-role="task-edit-options-retry"]').exists(), false);
});

for (const area of ['description', 'comments']) {
    test(`LOAD-SURFACE-task-${area}: реальная карточка и сохранённый композер`, async (t) => {
        const h = await mountLoadingTask(t, area);
        const pendingBricks = h.wrapper.findAll('[data-ui-skeleton]').length;
        const composer = h.wrapper.find('[data-role="task-comment"]').element;

        if (area === 'description') {
            h.detail.resolve(h.task);
        } else {
            h.comments.resolve({ comments: [] });
        }

        await h.flush();
        await h.flush();
        assert.equal(h.wrapper.find('[data-ui-loading]').exists(), false);
        assert.equal(h.wrapper.findAll('[data-role="task-comment"]').length, 1);

        if (area === 'comments') {
            assert.equal(h.wrapper.get('[data-role="task-comment"]').element === composer, true);
        }

        assert.ok(pendingBricks > 0, `${area}: свой каркас заменяет первое ожидание`);
    });
}

const { mountInfrastructure } = await import('./fixtures/loading/infrastructure.mjs');

for (const kind of ['ssh', 'db']) {
    test(`LOAD-SURFACE-${kind}: первое чтение списка сменяется настоящей строкой подключения`, async (t) => {
        const h = await mountInfrastructure(t, kind);
        const pendingBricks = h.wrapper.findAll('[data-ui-skeleton]').length;

        await h.resolve();
        assert.equal(h.wrapper.find(h.selector).exists(), true);
        assert.equal(h.wrapper.find('[data-ui-loading]').exists(), false);
        assert.ok(pendingBricks > 0, `${kind}: список использует UiSkeleton до ответа`);
    });
}

const { mountBoardView } = await import('./helpers/board-view.js');
const { mountLoadingPipeline } = await import('./fixtures/loading/pipeline.mjs');
const { mountChannelView } = await import('./helpers/channel-views.js');

test('LOAD-SURFACE-board: первый каркас сменяется настоящими показателями и списком', async (t) => {
    const h = await mountBoardView(t, {
      pending: true,
      tasks: [],
      ownApi: {
        get: (url) => url === '/api/trackers' ? trackerMetadata('fixture-driver') : null,
      },
    });
    const pendingBricks = h.wrapper.findAll('[data-ui-skeleton]').length;
    const board = h.stores.board();

    board.data = {
        userId: 7,
        trackerId: 'fixture-driver',
        capabilities: { ...CUSTOM_CAPS },
        widgets: [{
            id: 'ready-summary',
            kind: 'kpi',
            title: { text: 'Готовая сводка драйвера' },
            items: [{
                id: 'ready-task-count',
                label: { text: 'Готовых задач' },
                value: 17,
                format: 'count',
            }],
        }],
        today: {
            hours: 0,
            tasks_count: 0,
            avg_time: 0
        },
        dynamics: {},
        month: {
            hours: 0,
            norm: 1,
            completedTasks: 0
        },
        charts: {},
        tasks: [],
        toReview: [],
        created: [],
    };
    board.loading = false;
    await h.flushPromises();
    assert.equal(h.wrapper.find('.tracker-widgets .stats').exists(), true);
    assert.equal(h.wrapper.get('[data-stat="ready-task-count"] .tval').text(), '17');
    assert.equal(h.wrapper.find('[data-ui-loading]').exists(), false);
    assert.ok(pendingBricks > 0, 'Доска использует собственный каркас из общих кирпичиков');
});

for (const compact of [false, true]) {
    for (const loops of [false, true]) {
        test(`LOAD-SURFACE-pipeline-${compact}-${loops}: режимы доступны ещё до ответа`, async (t) => {
            const h = await mountLoadingPipeline(t, compact, loops);
            const loading = h.wrapper.findComponent({ name: 'PipelineLoading' });
            const pendingBricks = h.wrapper.findAll('[data-ui-skeleton]').length;
            const props = loading.exists() ? loading.props() : null;

            await h.resolve();
            assert.equal(h.wrapper.find('[data-ui-loading]').exists(), false);
            assert.deepEqual(h.calls, ['/api/tasks?sources=1']);
            assert.ok(pendingBricks > 0, 'Конвейер использует свой каркас');
            assert.ok(props, 'режимы переданы лёгкому PipelineLoading');
            assert.equal(props.compact, compact);
            assert.equal(props.loopsOn, loops);
        });
    }
}

for (const view of ['inbox', 'github']) {
    test(`LOAD-SURFACE-${view}: удержанный ответ сменяется настоящей раскладкой экрана`, async (t) => {
        const pending = Promise.withResolvers();
        const h = await mountChannelView(t, view, { api: { get: () => pending.promise } });
        const pendingBricks = h.wrapper.findAll('[data-ui-skeleton]').length;
        const header = h.wrapper.get('h1').element;

        pending.resolve(view === 'inbox' ? {
            items: [],
            channels: [],
            errors: [],
            truncated: false,
            worker: {
                running: true,
                readiness: 'ready',
                lastReason: '',
                lastError: null
            },
        } : {
            configured: false,
            state: null,
            repositoryId: null,
            fullName: null,
            connectedAt: null,
            connection: 'disconnected',
            reason: null,
            cleanupPending: false,
        });
        await h.settle();
        assert.equal(h.wrapper.find('[role="alert"]').exists(), false);
        assert.equal(h.wrapper.find('[data-ui-loading]').exists(), false);
        assert.equal(h.wrapper.get('h1').element === header, true);
        assert.equal(h.wrapper.find(view === 'inbox' ? '.channels-disclosure' : '.grid').exists(), true);
        assert.ok(pendingBricks > 0, `${view}: первое чтение показывает свой каркас`);
    });
}

const { catalogFixture } = await import('../helpers/pluginCatalog.js');
const nativeCatalog = (await import('../fixtures/executor-settings/synthetic-catalog.json', {
  with: { type: 'json' },
})).default;

for (const area of ['index', 'detail']) {
  test(`LOAD-SURFACE-settings-catalog-${area}: первый ответ собирает настоящий каталог`, async (t) => {
    const fixture = catalogFixture();
    const pending = Promise.withResolvers();
    const index = {
      state: 'fresh',
      applicationVersion: '1.0.0',
      fetchedAt: fixture.index.generatedAt,
      catalog: fixture.index
    };
    const h = await settingsHarness(t, 'plugins.installed', 'PluginCatalogPanel', {
      prepare({ control }) {
        control.handlers['/api/plugin-catalog'] = () => area === 'index'
          ? pending.promise : Response.json(index);
        control.handlers['/api/plugin-catalog/demo'] = () => pending.promise;
      },
    });

    if (area === 'detail') {
      await h.wrapper.get('[data-catalog-id="demo"]').trigger('click');
      await h.flushPromises();
    }

    const bricks = h.wrapper.findAll('[data-ui-skeleton]').length;

    pending.resolve(Response.json(area === 'index' ? index : fixture.detail));
    await h.flushPromises();
    await h.flushPromises();
    assert.equal(h.wrapper.find(area === 'index' ? '[data-catalog-id="demo"]' : '[data-catalog-title]')
      .exists(), true, 'настоящий декодер принял синтетический ответ');
    assert.equal(h.wrapper.find('[data-ui-loading]').exists(), false);
    assert.ok(bricks > 0, `${area}: собственный каркас из общих кирпичиков`);
  });
}

test('LOAD-SURFACE-settings-provider-native: раскрытый каталог параметров ожидает форму', async (t) => {
  const pending = Promise.withResolvers();
  const h = await settingsHarness(t, 'agents.providers', 'ProviderPage', {
    entityId: 'fixture',
    prepare({ control }) {
      control.handlers['/api/providers/fixture/settings/catalog'] = () => pending.promise;
    },
  });

  h.settings.selectPage('agents.providers', 'fixture', 'parameters');
  await h.flushPromises();
  await h.wrapper.findAll('button').find((item) =>
    item.text().includes('Дополнительные параметры')).trigger('click');
  await h.flushPromises();

  const bricks = h.wrapper.findAll('.settings-native-panel [data-ui-skeleton]').length;

  pending.resolve(Response.json({
    ...nativeCatalog,
    providerId: 'fixture'
  }));
  await h.flushPromises();
  await h.flushPromises();
  assert.match(h.wrapper.text(), /Новая настройка/);
  assert.equal(h.wrapper.find('[data-ui-loading]').exists(), false);
  assert.ok(bricks > 0, 'native-каталог показывает форму из общих кирпичиков');
});

test('LOAD-SURFACE-settings-provider: пустой до ответа реестр сменяется настоящим picker', async (t) => {
  const pending = Promise.withResolvers();
  let response;
  const h = await settingsHarness(t, 'agents.providers', 'ProviderPage', {
    /**
     * Реестр удерживается до первого ответа, без заранее выбранного исполнителя.
     * Ответ берётся из той же синтетической коллекции, что и соседние тесты настроек.
     */
    prepare({ providers, control }) {
      response = structuredClone(control.data.providers);
      providers.loaded = false;
      providers.providers = [];
      control.handlers['/api/providers'] = () => pending.promise;
    },
  });
  const bricks = h.wrapper.findAll('[data-ui-skeleton]').length;

  pending.resolve(Response.json(response));
  await h.flushPromises();
  await h.flushPromises();
  assert.equal(h.wrapper.find('[data-select-provider="fixture"]').exists(), true);
  assert.equal(h.wrapper.find('[data-ui-loading]').exists(), false);
  assert.ok(bricks > 0, 'реестр исполнителей использует общий список');
});

test('LOAD-SURFACE-task-window: readiness открывает единственную настоящую карточку', async (t) => {
  const h = await mountLoadingTask(t, 'window');
  const pending = h.wrapper.findAll('[data-ui-skeleton]').length;

  assert.equal(h.wrapper.find('[data-role="task-modal"]').exists(), false);
  await h.wrapper.setProps({ ready: true });
  await h.flush();
  await h.flush();
  assert.equal(h.wrapper.findAll('[data-role="task-modal"]').length, 1);
  assert.equal(h.wrapper.find('[data-ui-loading]').exists(), false);
  assert.match(h.wrapper.text(), /Синтетическая задача/);
  assert.ok(pending > 0, 'окно использует каркас карточки до readiness');
});

const { mountLoadingToolWindow } = await import('./fixtures/loading/toolWindow.mjs');

test('LOAD-SURFACE-tool-window: до init свой каркас, затем один mount и importState', async (t) => {
  const h = await mountLoadingToolWindow(t);
  const pending = h.wrapper.findAll('[data-ui-skeleton]').length;
  const header = h.wrapper.get('.tool-window-titlebar').element;

  assert.equal(h.control.mounts, 0);
  assert.equal(h.wrapper.find('[data-window-ready]').exists(), false);
  await h.control.options.importState({ search: 'Синтетическая строка' });
  await h.flushPromises();
  assert.equal(h.control.mounts, 1);
  assert.deepEqual(h.control.imports, [{ search: 'Синтетическая строка' }]);
  assert.equal(h.wrapper.findAll('[data-window-ready]').length, 1);
  assert.ok(h.wrapper.get('.tool-window-titlebar').element === header);
  assert.equal(h.wrapper.find('[data-ui-loading]').exists(), false);
  assert.ok(pending > 0, 'окно выбирает лёгкий каркас Полки до init');
});

const { mountResolvingDocument } = await import('./fixtures/loading/resolution.mjs');

for (const modal of [false, true]) {
  test(`LOAD-SURFACE-document-resolve-${modal ? 'modal' : 'page'}: разрешение ссылки`, async (t) => {
    const h = await mountResolvingDocument(t, modal);
    const pending = h.wrapper.findAll('[data-ui-skeleton]').length;

    assert.equal(h.wrapper.find('.document-body').exists(), false);
    assert.equal(h.calls.length, 1, 'пока ссылка не разрешена, документ не читается');
    await h.resolve();
    assert.equal(h.wrapper.find('.document-body').exists(), true, 'готовый DocumentPanel виден');
    assert.match(h.wrapper.find('.document-body').text(), /Первая строка/);
    assert.deepEqual(h.calls.map(([method]) => method), ['POST', 'GET']);
    assert.equal(h.wrapper.find('[data-ui-loading]').exists(), false);
    assert.ok(pending > 0, 'разрешение ссылки показывает текстовый каркас');
  });
}

test('LOAD-SURFACE-db-schema: схема ждёт свой ответ и сохраняет повтор чтения', async (t) => {
  const h = await mountInfrastructure(t, 'db', true);

  h.store.sessions = [{
    id: 'fixture-session',
    label: 'Синтетическая сессия',
    engine: 'postgres',
    role: 'read',
    projectId: 'fixture'
  }];
  h.wrapper.vm.selectedSessionId = 'fixture-session';
  await h.flush();

  const scope = h.wrapper.get('[data-db-schema]');
  const bricks = scope.findAll('[data-ui-skeleton]').length;
  const announced = scope.find('[role="status"]').exists();

  h.store.schemas['fixture-session'] = { rows: [{ name: 'fixture_table' }] };
  h.schema.resolve();
  await h.flush();
  await h.flush();
  assert.match(scope.text(), /fixture_table/);
  assert.equal(scope.find('[data-ui-loading]').exists(), false);
  assert.equal(h.calls.filter((name) => name === 'loadDbSchema').length, 1);
  assert.ok(announced);
  assert.ok(bricks > 0, 'схема использует текстовый каркас при первом чтении');
});

test('LOAD-SURFACE-pipeline-document: документ этапа объявляет ожидание', async (t) => {
  const h = await mountLoadingPipeline(t);

  await h.resolve();
  h.wrapper.vm.stage = {
    task: 42,
    id: 'plan',
    key: 'PLAN',
    runnerKey: 'PLAN',
    label: 'План',
    readOnly: true,
    daemonAlive: false,
    status: 'done',
    meta: {}
  };
  h.wrapper.vm.stageDocLoading = true;
  await h.wrapper.vm.$nextTick();
  await h.wrapper.vm.$nextTick();

  const bricks = h.wrapper.findAll('[data-ui-skeleton]').length;
  const announced = h.wrapper.findAll('[role="status"]').some((status) =>
    status.text().includes('Документ этапа'));

  h.wrapper.vm.stageDoc = 'Синтетический документ этапа';
  h.wrapper.vm.stageDocLoading = false;
  await h.wrapper.vm.$nextTick();
  assert.match(h.wrapper.text(), /Синтетический документ этапа/);
  assert.equal(h.wrapper.find('[data-ui-loading]').exists(), false);
  assert.ok(announced);
  assert.ok(bricks > 0, 'документ этапа имеет текстовый каркас');
});

const { compileVue, webFile } = await import('./helpers/compile-vue.js');
const { installUiBrowser } = await import('./helpers/ui-components.js');

for (const outcome of ['ready', 'error']) {
  test(`LOAD-SURFACE-plugin-module-${outcome}: настоящий host ждёт модуль и завершает статус`, async (t) => {
    await installUiBrowser(t);

    const { mount, flushPromises } = await import(
      '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
    );
    const pending = Promise.withResolvers();

    globalThis.__loadingPluginModule = pending;
    t.after(() => delete globalThis.__loadingPluginModule);

    const component = await compileVue(webFile('src/views/ext/PluginModulePanel.vue'), { stubs: {
      '../../pluginRuntime/bootstrap.ts': `export const pluginRuntimeFor = () => ({
        acquirePanel: () => globalThis.__loadingPluginModule.promise,
      });`,
      '../../pluginRuntime/styles.ts': 'export const loadPluginStyles = async () => () => {};',
    } });
    const wrapper = mount(component, { props: {
      pluginId: 'fixture',
      label: 'Синтетический плагин',
      descriptor: {},
    } });

    t.after(() => wrapper.unmount());

    const bricks = wrapper.findAll('[data-ui-skeleton]').length;
    const announced = wrapper.find('[role="status"]').text();

    if (outcome === 'ready') {
      pending.resolve({
        component: { template: '<article data-plugin-ready>Готовый модуль</article>' },
        context: {},
        release() {},
        setActive() {},
      });
    } else {
      pending.reject(new Error('Синтетический отказ модуля'));
    }

    await flushPromises();
    await flushPromises();
    assert.equal(wrapper.find('[data-ui-loading]').exists(), false);
    assert.equal(wrapper.find('[data-ui-skeleton]').exists(), false);
    assert.equal(wrapper.find('[data-plugin-ready]').exists(), outcome === 'ready');

    if (outcome === 'error') {
      assert.match(wrapper.text(), /Не удалось загрузить/);
    }

    assert.match(announced, /Синтетический плагин/);
    assert.ok(bricks > 0, 'пока модуль неизвестен, host показывает каркас его поверхности');
  });
}

for (const [id, page, component, endpoint] of settingsCases) {
  test(`LOAD-ERROR-RETRY-settings-${id}: отказ не оставляет каркас поверх причины`, async (t) => {
    const h = await settingsHarness(t, page, component, {
      prepare({ control }) {
        control.handlers[endpoint] = () => Response.json({ error: 'Синтетический отказ' }, { status: 503 });
      },
    });

    await h.flushPromises();
    await h.flushPromises();
    assert.match(h.wrapper.text(), /Синтетический отказ/);
    assert.equal(h.wrapper.find('[data-ui-loading]').exists(), false);
    assert.equal(h.wrapper.find('[data-ui-skeleton]').exists(), false);
  });
}

for (const kind of ['ssh', 'db']) {
  test(`LOAD-ERROR-RETRY-${kind}: ошибка списка видна без каркаса, обновление доступно`, async (t) => {
    const h = await mountInfrastructure(t, kind);

    h.store.loading = false;
    h.store.error = 'Синтетический отказ';
    await h.wrapper.vm.$nextTick();
    assert.match(h.wrapper.text(), /Синтетический отказ/);
    assert.equal(h.wrapper.find('[data-ui-skeleton]').exists(), false);

    const refresh = h.wrapper.findAll('button').find((button) =>
      /Обновить/.test(button.attributes('aria-label') || button.text()));

    assert.ok(refresh, 'прежнее обновление доступно после отказа');
    await refresh.trigger('click');
    await h.wrapper.vm.$nextTick();
    assert.equal(h.calls.filter((name) => name === (kind === 'ssh' ? 'loadSsh' : 'loadDb')).length, 2);
    h.store.error = '';
    await h.resolve();
    assert.equal(h.wrapper.find(h.selector).exists(), true);
  });
}

test('LOAD-SURFACE-settings-fallback: незагруженный раздел объявляет форму без второй шапки', async (t) => {
  await installUiBrowser(t);

  const { reactive } = await import('../../web/node_modules/vue/index.mjs');
  const { mount } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const state = reactive({
    pageId: 'automation.chats',
    query: '',
    navigationError: '',
    dynamicFields: [],
  });
  const pages = reactive({});

  globalThis.__loadingSettingsFallback = { state, pages };
  t.after(() => delete globalThis.__loadingSettingsFallback);

  const component = await compileVue(webFile('src/views/settings/SettingsWorkspace.vue'), { stubs: {
    '../../stores/settings.ts': `export const useSettingsStore = () =>
      globalThis.__loadingSettingsFallback.state;`,
    './pageComponents.ts': `export const SETTINGS_PAGE_COMPONENTS =
      globalThis.__loadingSettingsFallback.pages;`,
    './SettingsNavigation.vue': 'export default { render: () => null };',
  } });
  const wrapper = mount(component);

  t.after(() => wrapper.unmount());

  const bricks = wrapper.findAll('[data-ui-skeleton]').length;
  const title = wrapper.get('#settings-page-title').element;

  assert.match(wrapper.get('[role="status"]').text(), /Раздел загружается/);
  pages['automation.chats'] = { render: () => null };
  await wrapper.vm.$nextTick();
  assert.equal(wrapper.get('#settings-page-title').element === title, true);
  assert.equal(wrapper.find('[data-ui-loading]').exists(), false);
  assert.ok(bricks > 0, 'fallback содержит общую форму из UiSkeleton');
});

test('LOAD-KEEP-schema-retry: ошибка схемы снимает каркас, прежняя кнопка перечитывает', async (t) => {
  const h = await mountInfrastructure(t, 'db', true);

  h.store.sessions = [{
    id: 'fixture-session',
    label: 'Синтетическая сессия',
    engine: 'postgres',
    role: 'read',
    projectId: 'fixture',
  }];
  h.wrapper.vm.selectedSessionId = 'fixture-session';
  await h.flush();
  h.schema.reject(new Error('Синтетический отказ схемы'));
  await h.flush();
  assert.match(h.wrapper.text(), /Синтетический отказ схемы/);
  assert.equal(h.wrapper.find('[data-ui-loading]').exists(), false);
  assert.equal(h.wrapper.find('[data-ui-skeleton]').exists(), false);
  h.resetSchema();
  await h.wrapper.get('button[aria-label="Обновить схему"]').trigger('click');
  assert.equal(h.calls.filter((name) => name === 'loadDbSchema').length, 2);
  h.store.schemas['fixture-session'] = { rows: [{ name: 'fixture_table' }] };
  h.schema.resolve();
  await h.flush();
  assert.match(h.wrapper.get('[data-db-schema]').text(), /fixture_table/);
  assert.equal(h.wrapper.find('[data-ui-loading]').exists(), false);
});

for (const modal of [false, true]) {
  test(`LOAD-KEEP-document-resolve-error-${modal}: отказ ссылки снимает каркас`, async (t) => {
    const h = await mountResolvingDocument(t, modal);

    h.pending.reject(new Error('Синтетический отказ ссылки'));
    await h.wrapper.vm.$nextTick();

    const { flushPromises } = await import(
      '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
    );

    await flushPromises();
    await flushPromises();
    assert.match(h.wrapper.text(), /Синтетический отказ ссылки/);
    assert.equal(h.wrapper.find('[data-ui-loading]').exists(), false);
    assert.equal(h.wrapper.find('[data-ui-skeleton]').exists(), false);
    assert.deepEqual(h.calls.map(([method]) => method), ['POST']);
  });
}
