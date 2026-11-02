import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import ts from '../../web/node_modules/typescript/lib/typescript.js';
import { compileModule, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

let mount;
let flushPromises;
let asyncView;
let tools;
let settings;
const captures = [];
const keys = [
    'interface.behavior',
    'interface.notifications',
    'interface.shortcuts',
    'automation.chats',
    'automation.context',
    'automation.launch',
    'automation.monitoring',
    'automation.arbiter',
    'agents.models',
    'connections.devices',
    'connections.mobile',
    'connections.ssh',
    'connections.db',
    'connections.telegram',
    'connections.github',
    'automation.analysis',
    'automation.shelf',
    'automation.inbox',
    'speech.videoTasks',
    'interface.usageForecast',
    'tools.code',
    'tools.docker',
    'tools.studio3d',
    'tools.showcase',

    'system.startup',
    'system.updates',
    'system.processes',
    'plugins.installed',
    'agents.providers',
    'speech.dictation',
    'system.diagnostics',
];

before(async () => {
    await installUiBrowser({ after });
    ({
      mount,
      flushPromises
    } = await import(
        '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
    ));
    ({ asyncView } = await compileModule(webFile('src/shared/asyncView.ts')));
    globalThis.__loadingCapture = (_loader, loadingComponent) => {
        const token = { loadingComponent };

        captures.push(token);

        return token;
    };

    const capture = 'export const asyncView = globalThis.__loadingCapture;';
    const ready = 'export default { template: "<article data-ready-panel>Готово</article>" };';
    const stubs = {
      '../asyncView.ts': capture,
      '../../shared/asyncView.ts': capture
    };

    for (const relative of [
        '../../views/code/CodePanel.vue',
        '../../views/shelf/TaskShelfPanel.vue',
        '../../views/studio3d/Studio3dPanel.vue',
        '../../views/terminal/TerminalPanel.vue',
        '../../views/ssh/SshPanel.vue',
        '../../views/db/DbPanel.vue',
        '../../views/docker/DockerPanel.vue',
        '../../views/ext/PluginFramePanel.vue',
        '../../views/ext/PluginModulePanel.vue',
        './pages/PreferencesPage.vue',
        './pages/SpeechPage.vue',
        './pages/InterfacePage.vue',
        './pages/DevicesPage.vue',
        './pages/ConnectionsPage.vue',
        './pages/SystemPage.vue',
        './pages/ProcessesPage.vue',
        './pages/PluginWorkspacePage.vue',
        './pages/ProviderPage.vue',
        './pages/DiagnosticsPage.vue',
    ]) {
        stubs[relative] = ready;
    }

    tools = await compileModule(webFile('src/shared/tools/registry.ts'), { stubs });
    settings = await compileModule(webFile('src/views/settings/pageComponents.ts'), { stubs });
});
after(() => {
    delete globalThis.__loadingCapture;
});
/**
 * Меняется только отложенный chunk готовой панели: настоящий loading-компонент
 * проходит оба исхода asyncView, включая прежний экран отказа загрузки.
 */
async function checkLifecycle(t, entry, id) {
    const assigned = Boolean(entry?.loadingComponent);

    for (const outcome of ['resolve', 'reject']) {
        const result = Promise.withResolvers();
        const failures = [];
        const Pending = asyncView(() => result.promise, entry?.loadingComponent, (error) => {
            failures.push(error.message);
        });
        const wrapper = mount({ components: { Pending }, template: '<main><Pending /></main>' }, {
            global: { config: {
              errorHandler() {
                    },
              warnHandler() {
                    }
            } },
        });

        t.after(() => wrapper.unmount());

        if (assigned) {
        assert.equal(wrapper.findAll('[role="status"]').length, 1,
            `${id}: один статус объявляет ожидание chunk`);
        assert.ok(wrapper.get('[role="status"]').text().length > 0,
            `${id}: подпись загрузки доступна средствам чтения`);
        assert.ok(wrapper.findAll('[data-ui-skeleton]').length > 0, `${id}: свой каркас до chunk`);

        const names = {
            shelf: 'TaskShelfLoading',
            studio3d: 'Studio3dLoading',
            terminal: 'TerminalLoading',
            ssh: 'SshPanelLoading',
            db: 'DbPanelLoading',
            docker: 'DockerLoading',
            'external-frame': 'PluginPanelLoading',
            'external-module': 'PluginPanelLoading',
        };
        const expected = names[id] || 'SettingsLoading';
        const layout = wrapper.findComponent({ name: expected });

        assert.equal(layout.exists(), true, `${id}: назначена именно его раскладка ${expected}`);

        if (!names[id]) {
            assert.ok(
                Object.values(layout.props()).includes(id),
                `${id}: передан буквальный ключ страницы`
            );
        }

        if (id === 'studio3d' || id === 'docker') {
            assert.equal(layout.props('area'), id === 'studio3d' ? 'create' : 'panel');
        }


        } else {
            assert.equal(wrapper.find('[data-ui-loading]').exists(), true);
        }

        if (outcome === 'resolve') {
            result.resolve({ template: '<article data-ready-panel>Готовая панель</article>' });
        }
        else {
            result.reject(new Error('Синтетический отказ chunk'));
        }

        await flushPromises();
        await flushPromises();
        assert.equal(wrapper.find('[data-ui-skeleton]').exists(), false);
        assert.equal(wrapper.find('[data-ready-panel]').exists(), outcome === 'resolve');
        assert.equal(wrapper.find('[role="alert"]').exists(), outcome === 'reject');
        assert.deepEqual(failures, outcome === 'reject' ? ['Синтетический отказ chunk'] : []);
    }

    assert.ok(assigned, `${id}: назначен специальный лёгкий loadingComponent`);

}

for (const id of [
    'shelf',
    'studio3d',
    'terminal',
    'ssh',
    'db',
    'docker',
    'external-frame',
    'external-module',
]) {
    test(`LOAD-LAZY-tools-${id}: свой каркас, успех и отказ chunk`, async (t) => {
        const external = tools.pluginTools({
            webPages: [
                {
                    id: 'external-frame',
                src: '/fixture',
                label: 'Плагин',
                icon: '',
                order: 1
                }
            ],
            modulePages: [
                {
                    id: 'external-module',
                label: 'Модуль',
                icon: '',
                order: 2,
                descriptor: {}
                }
            ],
        });
        const entry = [...tools.TOOL_REGISTRY, ...external].find((item) => item.id === id);

        assert.ok(entry, `${id}: инструмент зарегистрирован`);
        await checkLifecycle(t, entry.component, id);
    });
}
for (const key of keys) {
    test(`LOAD-LAZY-settings-${key}: каркас страницы, успех и отказ chunk`, async (t) => {
        await checkLifecycle(t, settings.SETTINGS_PAGE_COMPONENTS[key], key);
    });
}
/**
 * Обход идёт по синхронным импортам настоящих loading-модулей до публичного UI.
 * Готовые панели, stores и тяжёлый runtime не должны попадать в основной пакет ради каркаса.
 */
async function checkGraph(filename, visited = new Set()) {
    if (visited.has(filename) || filename === webFile('src/ui.ts')) {
        return;
    }

    visited.add(filename);
    assert.ok(existsSync(filename), `лёгкий модуль существует: ${filename}`);

    const raw = await readFile(filename, 'utf8');
    const source = filename.endsWith('.vue')
        ? raw.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1] || ''
        : raw;
    const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);

    for (const node of ast.statements) {
        if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) {
            continue;
        }

        const specifier = node.moduleSpecifier?.text;

        if (!specifier || node.importClause?.isTypeOnly || node.isTypeOnly) {
            continue;
        }

        assert.doesNotMatch(
            specifier,
            /monaco|xterm|three|stores\/|apiClient|actions\//,
            `каркас не импортирует runtime продукта: ${specifier}`
        );

        if (!specifier.startsWith('.')) {
            continue;
        }

        const base = path.resolve(path.dirname(filename), specifier);
        const target = [base, `${base}.ts`, `${base}.js`].find((candidate) => existsSync(candidate));

        assert.ok(target, `разрешён синхронный импорт ${specifier}`);

        if (/\.(vue|ts|js)$/.test(target)) {
            assert.ok(
                !/\/(?:Code|Ssh|Db|Docker|Terminal|Studio3d)Panel\.vue$/.test(target),
                `готовая панель не входит в граф каркаса: ${specifier}`
            );
            await checkGraph(target, visited);
        }
    }
}

test('LOAD-LAZY-tools: синхронный граф каркасов не загружает готовые инструменты', async () => {
    const filename = webFile('src/shared/tools/panelLoading.ts');

    assert.ok(existsSync(filename), 'синхронный реестр лёгких каркасов создан');
    await checkGraph(filename);
});
test('LOAD-LAZY-settings: граф каркасов настроек не зависит от stores и API', async () => {
    const filename = webFile('src/views/settings/SettingsLoading.vue');

    assert.ok(existsSync(filename), 'лёгкий каркас настроек создан');
    await checkGraph(filename);
});

const { captureSettingsModal } = await import('./fixtures/loading/settingsModal.mjs');
const { settingsHarness } = await import('./helpers/settings-harness.js');

test('LOAD-LAZY-settings-modal: настоящий диалог сменяет каркас без второго overlay', async (t) => {
  const Loading = await captureSettingsModal(t, mount, flushPromises);

  for (const outcome of ['resolve', 'reject']) {
    const h = await settingsHarness(t, 'interface.behavior', 'SettingsModal');

    h.wrapper.unmount();
    assert.equal(h.settings.requestOpen({ pageId: 'interface.behavior' }), true);
    assert.ok(h.module.SettingsModal, 'готовый SettingsModal экспортируется фикстурой');

    const pending = Promise.withResolvers();
    const errors = [];
    const renderErrors = [];
    const Pending = asyncView(() => pending.promise, Loading, (error) => errors.push(error.message));
    const wrapper = mount({ components: { Pending }, template: '<main><Pending /></main>' }, { global: {
      stubs: { teleport: true },
      config: {
        errorHandler(error) {
          renderErrors.push(error.message);
        },
        warnHandler() {}
      },
    } });

    t.after(() => wrapper.unmount());
    await flushPromises();
    assert.equal(wrapper.findAll('[role="dialog"]').length, Loading ? 1 : 0);

    if (Loading) {
      assert.ok(wrapper.findAll('[data-ui-skeleton]').length > 0);
    }

    if (outcome === 'resolve') {
      pending.resolve(h.module.SettingsModal);
    } else {
      pending.reject(new Error('Синтетический отказ SettingsModal chunk'));
    }

    await flushPromises();
    await flushPromises();
    assert.deepEqual(renderErrors, outcome === 'reject'
      ? ['Синтетический отказ SettingsModal chunk'] : [], 'ожидался только контролируемый отказ chunk');
    assert.equal(wrapper.find('[data-ui-skeleton]').exists(), false);
    assert.equal(wrapper.findAll('[role="dialog"]').length, outcome === 'resolve' ? 1 : 0);
    assert.equal(wrapper.find('[data-role="settings-modal"]').exists(), outcome === 'resolve');
    assert.equal(wrapper.find('[role="alert"]').exists(), outcome === 'reject');
    assert.equal(errors.length, outcome === 'reject' ? 1 : 0);
    wrapper.unmount();
  }

  assert.ok(Loading, 'App назначает отдельный SettingsModalLoading');
});
