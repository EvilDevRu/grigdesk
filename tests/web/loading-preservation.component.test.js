import assert from 'node:assert/strict';
import test from 'node:test';
import { mountChannelView } from './helpers/channel-views.js';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';
import { modelDto } from './helpers/studio3d-fixtures.js';

const REF = '[1,"item","github","fixture","issue"]';
const SNAPSHOT = {
    items: [
        {
            ref: REF,
            revision: `v1_${'a'.repeat(43)}`,
            channel: {
              id: 'github',
              label: 'GitHub'
            },
            source: {
              title: 'Синтетическое обращение',
              url: 'https://example.test/issue'
            },
            project: 'fixture',
            kind: 'bug',
            status: 'new',
            decision: null,
            firstAt: 100,
            lastAt: 100,
            cold: true,
            autoTask: {
              enabled: false,
              readyAtMs: 100
            },
            title: 'Сохранённое обращение',
            description: 'Синтетические данные',
            truncated: false,
            messages: [
                {
                messageRef: '[1,"message","github","fixture","repo","issue:1"]',
                occurredAt: 100,
                editedAt: null,
                author: { name: 'Синтетический автор' },
                text: 'Новое сообщение',
                attachments: [],
                decision: null,
            }
            ],
            attachments: [],
        }
    ],
    channels: [],
    errors: [],
    truncated: false,
    worker: {
        running: true,
        readiness: 'ready',
        lastReason: '',
        lastError: null
    },
};

test('LOAD-KEEP-data-inbox: повторное чтение сохраняет показанное обращение и шапку', async (t) => {
    const pending = Promise.withResolvers();
    let calls = 0;
    const h = await mountChannelView(t, 'inbox', {
        api: {
            get: async () => {
                calls += 1;

                return calls === 1 ? structuredClone(SNAPSHOT) : pending.promise;
            },
        },
    });
    const heading = h.wrapper.get('h1').element;
    const item = h.wrapper.get('[data-status="new"]').element;

    await h.wrapper.findAll('button').find((button) => button.text() === 'Обновить').trigger('click');
    await h.settle();
    assert.equal(calls, 2, 'обновление действительно началось');
    assert.equal(h.wrapper.get('[data-status="new"]').element === item, true);
    assert.equal(h.wrapper.get('h1').element === heading, true);
    assert.equal(h.wrapper.find('[data-ui-skeleton]').exists(), false);
    pending.resolve(structuredClone(SNAPSHOT));
    await h.settle();
});
test('LOAD-KEEP-inline-github: обновление правил остаётся маленьким индикатором', async (t) => {
    const pending = Promise.withResolvers();
    let ruleCalls = 0;
    const h = await mountChannelView(t, 'github', {
        expose: ['loadRules'],
        api: {
            /**
             * Изолирует два подтверждённых GET GitHub без реального репозитория.
             * Только второй ответ списка правил удерживается управляемым Promise.
             */
            async get(url) {
                if (url === '/api/github/status') {
                    return {
                        configured: true,
                        state: 'connected',
                        repositoryId: 'fixture',
                        fullName: 'fixture/repo',
                        connectedAt: 100,
                        connection: 'connected',
                        reason: null,
                        cleanupPending: false,
                    };
                }

                assert.equal(url, '/api/github/rules');
                ruleCalls += 1;

                return ruleCalls === 1 ? { rules: [] } : pending.promise;
            },
        },
    });
    const heading = h.wrapper.get('h1').element;

    const reading = h.wrapper.vm.loadRules();

    await h.settle();

    const inline = h.wrapper.find('[data-ui-loading][data-variant="inline"]');

    assert.equal(ruleCalls, 2);
    assert.equal(inline.exists(), true);
    assert.equal(inline.find('.ui-spinner').exists(), true);
    assert.equal(inline.find('[data-ui-skeleton]').exists(), false);
    assert.equal(h.wrapper.get('h1').element === heading, true);
    pending.resolve({ rules: [] });
    await reading;
    await h.settle();
});
test('LOAD-KEEP-inline-studio3d: обновление сохраняет настоящую карточку модели', async (t) => {
    await installUiBrowser(t);

    const { reactive, nextTick } = await import('../../web/node_modules/vue/index.mjs');
    const { mount } = await import(
        '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
    );
    const state = reactive({
        query: '',
        filters: {},
        models: [modelDto({ name: 'Сохранённый куб' })],
        total: 1,
        broken: [],
        busy: 0,
        state: { providers: [] },
        search() {
        },
        loadModels() {
        },
    });

    globalThis.__loadingKeepLibrary = state;

    const component = await compileVue(webFile('src/views/studio3d/LibraryPanel.vue'), {
        stubs: {
            '../../stores/studio3d.ts': (
                'export const useStudio3dStore = () => globalThis.__loadingKeepLibrary;'
            ),
            '../../shared/projectsApi.ts': 'export const projectsApi = { list: async () => [] };',
        },
    });
    const wrapper = mount(component);
    const card = wrapper.get('[data-context="studio-model-card"]').element;

    t.after(() => {
        wrapper.unmount();
        delete globalThis.__loadingKeepLibrary;
    });
    state.busy = 1;
    await nextTick();
    assert.equal(wrapper.get('[data-context="studio-model-card"]').element === card, true);
    assert.match(wrapper.text(), /Сохранённый куб/);
    assert.equal(wrapper.find('[data-ui-skeleton]').exists(), false);
    assert.equal(
        wrapper.find('[data-ui-loading][data-variant="inline"] .ui-spinner').exists(),
        true
    );
    state.busy = 0;
    await nextTick();
    assert.equal(wrapper.find('[data-ui-loading]').exists(), false);
});

const { mountInfrastructure } = await import('./fixtures/loading/infrastructure.mjs');

for (const kind of ['ssh', 'db']) {
    test(`LOAD-KEEP-data-${kind}: готовый список не заменяется каркасом при обновлении`, async (t) => {
        const h = await mountInfrastructure(t, kind, true);
        const row = h.wrapper.get(h.selector).element;
        const calls = [...h.calls];

        await h.refreshing(true);
        assert.equal(h.wrapper.get(h.selector).element === row, true);
        assert.equal(h.wrapper.find('[data-ui-skeleton]').exists(), false);
        assert.equal(h.wrapper.find('[data-ui-loading]').exists(), false);
        assert.deepEqual(h.calls, calls, 'смена визуального состояния не запускает загрузку');
        await h.refreshing(false);
        assert.equal(h.wrapper.get(h.selector).element === row, true);
    });
}

const { settingsHarness } = await import('./helpers/settings-harness.js');
const { catalogFixture } = await import('../helpers/pluginCatalog.js');

test('LOAD-KEEP-inline-catalog: обновление индекса сохраняет видимую запись и spinner', async (t) => {
  const fixture = catalogFixture();
  const pending = Promise.withResolvers();
  const h = await settingsHarness(t, 'plugins.installed', 'PluginCatalogPanel', {
    prepare({ control }) {
      control.handlers['/api/plugin-catalog'] = () => Response.json({
        state: 'fresh',
        applicationVersion: '1.0.0',
        fetchedAt: fixture.index.generatedAt,
        catalog: fixture.index,
      });
      control.handlers['/api/plugin-catalog?refresh=1'] = () => pending.promise;
    },
  });
  const row = h.wrapper.get('[data-catalog-id="demo"]').element;

  await h.wrapper.get('button[aria-label="Обновить каталог"]').trigger('click');
  await h.flushPromises();
  assert.equal(h.wrapper.find('[data-variant="inline"] .ui-spinner').exists(), true);
  assert.equal(h.wrapper.find('[data-ui-skeleton]').exists(), false);
  assert.ok(h.wrapper.get('[data-catalog-id="demo"]').element === row);
  pending.resolve(Response.json({
    state: 'fresh',
    applicationVersion: '1.0.0',
    fetchedAt: fixture.index.generatedAt,
    catalog: fixture.index,
  }));
  await h.flushPromises();
  assert.equal(h.wrapper.find('[data-ui-loading]').exists(), false);
});

const { mountLoadingToolWindow } = await import('./fixtures/loading/toolWindow.mjs');
const { mountLoadingTask } = await import('./fixtures/loading/task.mjs');

test('LOAD-KEEP-host-tool-window: шапка сохраняется, init даёт один mount и один import', async (t) => {
  const h = await mountLoadingToolWindow(t);
  const header = h.wrapper.get('.tool-window-titlebar').element;

  assert.equal(h.control.mounts, 0);
  await h.control.options.importState({ search: 'Синтетическая строка' });
  await h.flushPromises();
  assert.equal(h.control.mounts, 1);
  assert.deepEqual(h.control.imports, [{ search: 'Синтетическая строка' }]);
  assert.ok(h.wrapper.get('.tool-window-titlebar').element === header);
  assert.equal(h.wrapper.findAll('[data-window-ready]').length, 1);
});

test('LOAD-KEEP-host-task: ожидание комментариев не пересоздаёт готовый композер', async (t) => {
  const h = await mountLoadingTask(t, 'comments');
  const composer = h.wrapper.get('[data-role="task-comment"]').element;
  const header = h.wrapper.get('.mhead').element;

  h.comments.resolve({ comments: [] });
  await h.flush();
  await h.flush();
  assert.ok(h.wrapper.get('[data-role="task-comment"]').element === composer);
  assert.ok(h.wrapper.get('.mhead').element === header);
  assert.equal(h.wrapper.findAll('[data-role="task-comment"]').length, 1);
  assert.equal(h.calls.filter((url) => url === '/api/tracker/task/42/comments').length, 1);
});
