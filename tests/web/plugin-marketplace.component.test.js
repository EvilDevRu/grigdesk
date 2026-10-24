import assert from 'node:assert/strict';
import test from 'node:test';

import { catalogFixture } from '../helpers/pluginCatalog.js';
import { moduleCatalogFixture, catalogResponse } from '../helpers/pluginCatalogModules.js';
import { webInstallInfo } from './helpers/pluginInstallFixtures.js';
import { settingsHarness } from './helpers/settings-harness.js';

test('CAT-UI1: поиск, safe README, выбор совместимой версии и install intent', async (t) => {
  const fixture = catalogFixture();
  const h = await settingsHarness(t, 'plugins.installed', 'PluginCatalogPanel', {
    prepare({ control }) {
      control.handlers['/api/plugin-catalog'] = () => new Response(JSON.stringify({
        state: 'fresh',
        applicationVersion: '1.0.0',
        fetchedAt: fixture.index.generatedAt,
        catalog: fixture.index,
      }));
      control.handlers['/api/plugin-catalog?refresh=1'] = control.handlers['/api/plugin-catalog'];
      control.handlers['/api/plugin-catalog/demo'] = () => new Response(JSON.stringify(fixture.detail));
    },
  });

  assert.equal(h.wrapper.findAll('[data-catalog-id]').length, 1);
  await h.wrapper.get('[data-catalog-search]').setValue('no-match');
  assert.equal(h.wrapper.findAll('[data-catalog-id]').length, 0);
  await h.wrapper.get('[data-catalog-search]').setValue('EXAMPLE');
  await h.wrapper.get('[data-catalog-id="demo"]').trigger('click');
  await h.flushPromises();
  assert.equal(h.wrapper.find('[data-catalog-readme] script').exists(), false);
  assert.match(h.wrapper.get('[data-catalog-readme]').text(), /<script>/u);
  await h.wrapper.get('[data-catalog-action]').trigger('click');
  await h.flushPromises();


  const [selection, installed] = h.wrapper.emitted('install')[0];

  assert.equal(selection.id, 'demo');
  assert.equal(selection.target.sha, fixture.version.sha);
  assert.equal(installed, null);
  assert.equal(h.writes().length, 0, 'просмотр и intent не выполняют install/apply сами');
});

test('CAT-UI2: filters пересекаются, stale не разрешает install, RU/EN переключаются', async (t) => {
  const fixture = catalogFixture();
  const h = await settingsHarness(t, 'plugins.installed', 'PluginCatalogPanel', {
    prepare({ control }) {
      control.handlers['/api/plugin-catalog'] = () => new Response(JSON.stringify({
        state: 'stale',
        applicationVersion: '1.0.0',
        fetchedAt: fixture.index.generatedAt,
        catalog: fixture.index,
      }));
      control.handlers['/api/plugin-catalog/demo'] = () => new Response(JSON.stringify(fixture.detail));
    },
  });

  await h.wrapper.get('select[aria-label="Происхождение"]').setValue('official');
  assert.equal(h.wrapper.findAll('[data-catalog-id]').length, 0);
  await h.wrapper.get('select[aria-label="Происхождение"]').setValue('community');
  await h.wrapper.get('select[aria-label="Категория плагина"]').setValue('work');
  assert.equal(h.wrapper.findAll('[data-catalog-id]').length, 0);
  await h.wrapper.get('select[aria-label="Категория плагина"]').setValue('dev');
  await h.wrapper.get('[data-catalog-id="demo"]').trigger('click');
  await h.flushPromises();
  assert.equal(h.wrapper.get('[data-catalog-action]').element.disabled, true);
  await h.module.setUiLocale('en');
  await h.flushPromises();
  assert.match(h.wrapper.get('[data-catalog-status]').text(), /saved catalog/u);
  await h.module.setUiLocale('ru');
});

test('CAT-UI4: открытая fresh карточка заново проверяет индекс и блокирует offline install', async (t) => {
  const fixture = catalogFixture();
  const h = await settingsHarness(t, 'plugins.installed', 'PluginCatalogPanel', {
    /**
     * Первое чтение успешно, а явная перепроверка возвращает сохранённый снимок после отказа сети.
     * Фикстура держит различие между видимой карточкой и текущей доступностью каталога.
     */
    prepare({ control }) {
      const response = {
        state: 'fresh',
        applicationVersion: '1.0.0',
        fetchedAt: fixture.index.generatedAt,
        catalog: fixture.index,
      };

      control.handlers['/api/plugin-catalog'] = () => new Response(JSON.stringify(response));
      control.handlers['/api/plugin-catalog?refresh=1'] = () => new Response(JSON.stringify({
        ...response, state: 'stale',
      }));
      control.handlers['/api/plugin-catalog/demo'] = () => new Response(JSON.stringify(fixture.detail));
    },
  });

  await h.wrapper.get('[data-catalog-id="demo"]').trigger('click');
  await h.flushPromises();
  assert.equal(h.wrapper.get('[data-catalog-action]').element.disabled, false);
  await h.wrapper.get('[data-catalog-action]').trigger('click');
  await h.flushPromises();
  assert.equal(Boolean(h.wrapper.emitted('install')), false);
  assert.equal(h.wrapper.get('[data-catalog-action]').element.disabled, true);
  assert.equal(h.control.calls.some((call) => call.path === '/api/plugin-catalog?refresh=1'), true);
});

test('CAT-UI5: другой source конфликтует, совпавший показывает managed version', async (t) => {
  const fixture = catalogFixture();
  const { webInstallInfo } = await import('./helpers/pluginInstallFixtures.js');
  const h = await settingsHarness(t, 'plugins.installed', 'PluginCatalogPanel', {
    prepare({ control, plugins }) {
      plugins.list = [{
        id: 'demo',
        name: 'Demo',
        description: '',
        version: 'local',
        enabled: false,
        system: false,
        nav: null,
        settings: [],
        values: {},
        install: webInstallInfo({
          source: { kind: 'git', url: 'https://github.com/other/demo.git' },
          version: '1.0.0',
          tag: 'v1.0.0',
          sha: 'b'.repeat(40),
        }),
      }];
      control.handlers['/api/plugin-catalog'] = () => new Response(JSON.stringify({
        state: 'fresh',
        applicationVersion: '1.0.0',
        fetchedAt: fixture.index.generatedAt,
        catalog: fixture.index,
      }));
    },
  });

  assert.match(h.wrapper.get('[data-catalog-id="demo"]').text(), /другого или неизвестного источника/u);
  h.plugins.list[0].install.source = fixture.entry.source;
  await h.flushPromises();
  assert.match(h.wrapper.get('[data-catalog-id="demo"]').text(), /Установлен.*1\.0\.0/su);
});

test('CAT-UI3: Git в общей шапке не привязан к выбранному плагину; draft переживает вкладки', async (t) => {
  const h = await settingsHarness(t, 'plugins.installed', 'PluginWorkspacePage', {
    entityId: 'sample',
    stubs: { teleport: true },
  });

  await h.wrapper.get('[data-plugins-tab="installed"]').trigger('click');
  await h.flushPromises();


  const enabled = h.settings.getValue('pluginEnabled:sample', 'enabled');

  h.settings.setField('pluginEnabled:sample', 'enabled', !enabled);
  await h.wrapper.get('[data-plugins-tab="catalog"]').trigger('click');
  await h.wrapper.get('[data-plugins-tab="installed"]').trigger('click');
  await h.flushPromises();
  assert.equal(h.settings.getValue('pluginEnabled:sample', 'enabled'), !enabled);
  assert.equal(h.writes().length, 0);
  await h.wrapper.get('[data-install-git]').trigger('click');
  await h.flushPromises();
  assert.equal(h.settings.pageId, 'plugins.installed');
  assert.equal(h.wrapper.find('[data-role="plugin-install-dialog"]').exists(), true);
  assert.equal(h.wrapper.findComponent({ name: 'PluginInstallDialog' }).props('plugin'), null);
});

test('CAT-N2: live legacy navigation не открывает диалог; внешний source остаётся видимым', async (t) => {
  const h = await settingsHarness(t, 'plugins.installed', 'PluginWorkspacePage', { entityId: 'sample' });

  assert.equal(h.settings.selectPage('plugins.install', 'sample'), true);
  await h.flushPromises();
  assert.equal(h.settings.pageId, 'plugins.installed');
  assert.equal(h.wrapper.find('[data-role="plugin-install-dialog"]').exists(), false);


  const catalog = h.module.usePluginCatalogStore();

  catalog.snapshot = {
    state: 'fresh',
    applicationVersion: '1.0.0',
    fetchedAt: '2026-10-22T10:00:00.000Z',
    catalog: {
      schemaVersion: 1,
      generatedAt: '2026-10-22T10:00:00.000Z',
      plugins: []
    },
  };


  const sample = h.plugins.list.find((item) => item.id === 'sample');

  sample.system = false;
  sample.install = webInstallInfo({
    source: { kind: 'git', url: 'https://github.com/other/sample.git' },
  });
  await h.flushPromises();
  assert.match(h.wrapper.get('[data-installed-source="sample"]').text(), /Вне каталога/u);
  sample.install = null;
  await h.flushPromises();
  assert.match(h.wrapper.get('[data-installed-source="sample"]').text(), /источник не указан/u);
});

/**
 * Каталог отдаёт один индекс, а карточка берётся из изменяемой ссылки теста.
 * Так проверка перед установкой и явное обновление видят новую карточку того же снимка.
 */
function catalogHandlers(control, fixture, detail) {
  control.handlers['/api/plugin-catalog'] = () => new Response(JSON.stringify({
    state: 'fresh',
    applicationVersion: '1.0.0',
    fetchedAt: fixture.index.generatedAt,
    catalog: fixture.index,
  }));
  control.handlers['/api/plugin-catalog?refresh=1'] = control.handlers['/api/plugin-catalog'];
  control.handlers['/api/plugin-catalog/demo'] = () => new Response(JSON.stringify(detail()));
}

test('CAT-UI6: сменившийся SHA виден подписью; пропавшая версия возвращается к совместимой',
  async (t) => {
    const fixture = catalogFixture();
    const detail = structuredClone(fixture.detail);
    let served = detail;

    detail.plugin.versions = [fixture.version, {
      ...fixture.version,
      version: '1.0.0',
      tag: 'v1.0.0',
      sha: 'b'.repeat(40),
    }];

    const h = await settingsHarness(t, 'plugins.installed', 'PluginCatalogPanel', {
      prepare({ control }) {
        catalogHandlers(control, fixture, () => served);
      },
    });
    const refresh = () => h.wrapper.get('button[aria-label="Обновить каталог"]');

    await h.wrapper.get('[data-catalog-id="demo"]').trigger('click');
    await h.flushPromises();
    await h.wrapper.get('.catalog-card select').setValue('1.0.0');
    served = structuredClone(detail);
    served.plugin.versions[1].sha = 'c'.repeat(40);
    await h.wrapper.get('[data-catalog-action]').trigger('click');
    await h.flushPromises();
    assert.equal(h.wrapper.emitted('install'), undefined);
    assert.equal(h.wrapper.find('[data-catalog-version-changed]').exists(), true);
    served = structuredClone(fixture.detail);
    await refresh().trigger('click');
    await h.flushPromises();
    assert.equal(h.wrapper.find('[data-catalog-version-changed]').exists(), false);
    assert.equal(h.wrapper.get('.catalog-card select').element.value, '1.1.0');
    assert.doesNotMatch(h.wrapper.get('.catalog-card').text(), /Нет подходящих версий/u);
    assert.equal(h.wrapper.get('[data-catalog-action]').attributes('disabled'), undefined);
  });

test('CAT-UI7: «Открыть задание установки» не наследует прежний выбор каталога', async (t) => {
  const fixture = catalogFixture();
  const h = await settingsHarness(t, 'plugins.installed', 'PluginWorkspacePage', {
    stubs: { teleport: true },
    prepare({ control }) {
      catalogHandlers(control, fixture, () => fixture.detail);
    },
  });
  const dialog = () => h.wrapper.findComponent({ name: 'PluginInstallDialog' });

  await h.wrapper.get('[data-plugins-tab="catalog"]').trigger('click');
  await h.wrapper.get('[data-catalog-id="demo"]').trigger('click');
  await h.flushPromises();
  await h.wrapper.get('[data-catalog-action]').trigger('click');
  await h.flushPromises();
  assert.equal(dialog().props('catalogSelection').id, 'demo');
  dialog().vm.$emit('update:open', false);
  await h.flushPromises();
  assert.equal(dialog().exists(), false);
  h.module.usePluginInstallStore().recoveryError = {
    code: 'recovery_required',
    message: 'Нужно восстановление',
  };
  await h.flushPromises();
  await h.wrapper.get('[data-install-job]').trigger('click');
  await h.flushPromises();
  assert.equal(dialog().props('catalogSelection'), null);
  assert.equal(dialog().props('plugin'), null);
  assert.equal(dialog().props('mode'), 'install');
});

test('CAT-UI8: версия ниже установленной называет установленную, а не выбранную', async (t) => {
  const fixture = catalogFixture();
  const { webInstallInfo } = await import('./helpers/pluginInstallFixtures.js');
  const detail = structuredClone(fixture.detail);

  detail.plugin.versions = [fixture.version, {
    ...fixture.version,
    version: '1.0.0',
    tag: 'v1.0.0',
    sha: 'b'.repeat(40),
  }];

  const h = await settingsHarness(t, 'plugins.installed', 'PluginCatalogPanel', {
    prepare({ control, plugins }) {
      plugins.list = [{
        id: 'demo',
        name: 'Demo',
        description: '',
        version: '1.1.0',
        enabled: false,
        system: false,
        nav: null,
        settings: [],
        values: {},
        install: webInstallInfo({
          source: fixture.entry.source,
          version: fixture.version.version,
          tag: fixture.version.tag,
          sha: fixture.version.sha,
        }),
      }];
      catalogHandlers(control, fixture, () => detail);
    },
  });
  const button = () => h.wrapper.get('[data-catalog-action]');

  await h.wrapper.get('[data-catalog-id="demo"]').trigger('click');
  await h.flushPromises();
  assert.equal(button().text(), 'Установлен');
  await h.wrapper.get('.catalog-card select').setValue('1.0.0');
  assert.equal(button().text(), 'Установлена версия 1.1.0');
  assert.equal(button().attributes('disabled'), '');
});


test('CAT-UI-API2: modern карточка создаёт точный install intent без автоматического apply', async (t) => {
  const { modern } = moduleCatalogFixture();
  const h = await settingsHarness(t, 'plugins.installed', 'PluginCatalogPanel', {
    prepare({ control }) {
      control.handlers['/api/plugin-catalog?api=2'] = () => Response.json(catalogResponse(modern));
      control.handlers['/api/plugin-catalog?api=2&refresh=1'] = () => Response.json(catalogResponse(modern));
      control.handlers['/api/plugin-catalog/demo?api=2'] = () => Response.json(modern.detail);
    },
  });

  assert.equal(h.wrapper.findAll('[data-catalog-id]').length, 2);
  await h.wrapper.get('[data-catalog-id="demo"]').trigger('click');
  await h.flushPromises();
  assert.equal(h.wrapper.get('[data-catalog-action]').element.disabled, false);
  await h.wrapper.get('[data-catalog-action]').trigger('click');
  await h.flushPromises();

  const [selection, installed] = h.wrapper.emitted('install')[0];

  assert.deepEqual(selection, {
    id: 'demo',
    source: modern.entry.source,
    target: modern.version,
  });
  assert.equal(installed, null);
  assert.equal(h.writes().length, 0);
});
