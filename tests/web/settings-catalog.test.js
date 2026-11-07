import assert from 'node:assert/strict';
import test from 'node:test';

import { translator } from '../../shared/i18n/catalogs.ts';
import {
  SETTINGS_GROUPS,
  SETTINGS_PAGES,
  equalFieldAddress,
  getSettingsFields,
  getSettingsPages,
  resolveFieldAddress,
  resolveSettingsPage,
} from '../../web/src/features/settings/catalog.ts';

const EXPECTED_PAGES = [
  ['interface', ['behavior', 'notifications', 'shortcuts', 'usageForecast']],
  ['agents', ['providers', 'models']],
  ['automation', ['chats', 'context', 'launch', 'monitoring', 'arbiter', 'analysis', 'shelf', 'inbox']],
  ['speech', ['dictation', 'videoTasks']],
  ['connections', ['devices', 'ssh', 'db', 'telegram', 'github']],
  ['tools', ['code', 'docker', 'showcase', 'browser']],
  ['plugins', ['installed']],
  ['system', ['startup', 'updates', 'diagnostics', 'processes']],
];

/**
 * Хранилище фиксирует только публичные ключи навигации и их удаления.
 * Импорт каталога и выбор страницы не требуют браузерного окружения.
 */
function storageFixture(values = {}) {
  const records = new Map(Object.entries(values));
  const removed = [];

  return {
    records,
    removed,
    getItem: (key) => records.get(key) ?? null,
    setItem: (key, value) => records.set(key, value),
    removeItem(key) {
      removed.push(key);
      records.delete(key);
    },
  };
}

test('CAT01: группы и страницы уникальны, родитель существует, порядок закреплён', () => {
  assert.deepEqual(SETTINGS_GROUPS.map((group) => group.id), EXPECTED_PAGES.map(([group]) => group));
  assert.deepEqual(
    SETTINGS_PAGES.map((page) => page.id),
    EXPECTED_PAGES.flatMap(([group, pages]) => pages.map((page) => `${group}.${page}`)),
  );
  assert.equal(new Set(SETTINGS_GROUPS.map((group) => group.id)).size, SETTINGS_GROUPS.length);
  assert.equal(new Set(SETTINGS_PAGES.map((page) => page.id)).size, SETTINGS_PAGES.length);

  for (const page of SETTINGS_PAGES) {
    assert.equal(SETTINGS_GROUPS.some((group) => group.id === page.groupId), true);
    assert.equal(page.label.length > 0 && page.description.length > 0, true);
  }
});

test('CAT02: вызов, query, сохранённая страница, перенос вкладки и default', () => {
  const storage = storageFixture({ 'grigdesk-settings-page': 'speech.language' });
  const queryPage = new URLSearchParams('page=automation.context').get('page');

  assert.equal(resolveSettingsPage({
    pageId: 'agents.models',
    queryPage,
    storage,
  }), 'agents.models');
  assert.equal(resolveSettingsPage({ queryPage, storage }), 'automation.context');
  assert.equal(resolveSettingsPage({ storage }), 'speech.dictation');
  assert.equal(resolveSettingsPage(), 'interface.behavior');

  const bothKeys = storageFixture({
    'grigdesk-settings-page': 'speech.video',
    'grigdesk-settings-tab': 'providers',
  });

  assert.equal(resolveSettingsPage({ storage: bothKeys }), 'speech.dictation');
  assert.deepEqual(bothKeys.removed, []);

  const oldTabs = {
    app: 'interface.behavior',
    speech: 'speech.dictation',
    providers: 'agents.providers',
    runs: 'automation.chats',
    plugins: 'plugins.installed',
    server: 'system.startup',
    access: 'connections.devices',
  };

  for (const [tab, page] of Object.entries(oldTabs)) {
    const legacy = storageFixture({ 'grigdesk-settings-tab': tab });

    assert.equal(resolveSettingsPage({ storage: legacy }), page);
    assert.equal(legacy.records.get('grigdesk-settings-page'), page);
    assert.deepEqual(legacy.removed, ['grigdesk-settings-tab']);

    legacy.records.set('grigdesk-settings-tab', 'providers');

    assert.equal(resolveSettingsPage({ storage: legacy }), page);
    assert.deepEqual(legacy.removed, ['grigdesk-settings-tab']);
  }
});

test('CAT03: неизвестный адрес и отказ storage дают следующий безопасный вариант', () => {
  const storage = storageFixture({ 'grigdesk-settings-page': 'connections.devices' });

  assert.equal(
    resolveSettingsPage({
      pageId: 'missing',
      queryPage: '../evil.vue',
      storage,
    }),
    'connections.devices',
  );
  assert.equal(resolveSettingsPage({ pageId: {}, queryPage: 'speech.video' }), 'speech.dictation');
  assert.equal(storage.records.get('grigdesk-settings-page'), 'connections.devices');
  assert.equal(resolveSettingsPage({ storage: storageFixture({ 'grigdesk-settings-page': '{' }) }),
    'interface.behavior');

  const broken = {
    getItem() {
      throw new Error('Хранилище недоступно');
    },
    setItem() {
      throw new Error('Хранилище недоступно');
    },
    removeItem() {
      throw new Error('Хранилище недоступно');
    },
  };
  const readOnly = {
    ...broken,
    getItem: (key) => key === 'grigdesk-settings-tab' ? 'plugins' : null,
  };

  assert.equal(resolveSettingsPage({ storage: broken }), 'interface.behavior');
  assert.equal(resolveSettingsPage({ storage: readOnly }), 'plugins.installed');
  assert.equal(resolveSettingsPage({ storage: storageFixture({ 'grigdesk-settings-tab': 'unknown' }) }),
    'interface.behavior');
});

test('Речь: старые ссылки, сохранённые страницы и адреса полей ведут на единую страницу', () => {
  for (const pageId of ['speech.video', 'speech.language', 'speech.models', 'speech.advanced']) {
    const storage = storageFixture({ 'grigdesk-settings-page': pageId });

    assert.equal(resolveSettingsPage({ pageId }), 'speech.dictation');
    assert.equal(resolveSettingsPage({ queryPage: pageId }), 'speech.dictation');
    assert.equal(resolveSettingsPage({ storage }), 'speech.dictation');
    assert.deepEqual(resolveFieldAddress({ pageId, fieldPath: ['language'] }), {
      pageId: 'speech.dictation',
      fieldPath: ['language'],
    });
  }

  assert.equal(resolveSettingsPage({ pageId: 'speech.videoTasks' }), 'speech.videoTasks');
});

test('CAT04: адрес сравнивается по сегментам без разбора точек и слешей', () => {
  const address = {
    pageId: 'agents.providers',
    entityId: 'a/b',
    tabId: 'parameters',
    fieldPath: ['x.y', 'z/w'],
  };
  const resolved = resolveFieldAddress(address);

  assert.deepEqual(resolved, address);
  assert.equal(resolved === address, false);
  assert.equal(resolved?.fieldPath === address.fieldPath, false);
  assert.equal(equalFieldAddress(address, structuredClone(address)), true);
  assert.equal(equalFieldAddress(address, { ...address, entityId: 'a' }), false);
  assert.equal(equalFieldAddress(address, { ...address, tabId: 'overview' }), false);
  assert.equal(equalFieldAddress(address, { ...address, fieldPath: ['x', 'y.z/w'] }), false);
  assert.equal(equalFieldAddress(address, null), false);
  assert.equal(resolveFieldAddress({ ...address, pageId: 'missing' }), null);
});

test('CAT05 (guard): реестр содержит только публичные метаданные', () => {
  for (const group of SETTINGS_GROUPS) {
    assert.deepEqual(Object.keys(group).sort(), ['id', 'label']);
  }

  for (const page of SETTINGS_PAGES) {
    assert.deepEqual(Object.keys(page).sort(), ['description', 'groupId', 'id', 'label']);
    assert.equal(Object.values(page).every((value) => typeof value === 'string'), true);
  }
});

test('PHONE-14: поиск находит раздел доступа без удалённых полей привязки', async () => {
  const { searchSettings } = await import('../../web/src/features/settings/search.ts');

  assert.ok(SETTINGS_PAGES.some((page) => page.id === 'connections.devices'));

  for (const locale of ['ru', 'en']) {
    const page = getSettingsPages(locale).find((item) => item.id === 'connections.devices');

    assert.ok(page);
    assert.ok(searchSettings(page.label, [], locale).some((result) =>
      result.pageId === page.id && result.address === undefined));
    assert.deepEqual(getSettingsFields(locale).filter((field) => field.resourceId === 'devicePairing'), []);

    for (const key of ['settings.deviceName', 'settings.machineAddress']) {
      const results = searchSettings(translator.t(locale, key), [], locale);

      assert.equal(results.some((result) => result.address?.pageId === page.id
        && ['name', 'address'].includes(result.address.fieldPath[0])), false);
    }
  }
});

test('PHONE-14: старые ID ведут в единый раздел', () => {
  const canonical = 'connections.devices';

  for (const alias of ['connections.mobile', 'access']) {
    assert.equal(resolveSettingsPage({ pageId: alias }), canonical);
    assert.equal(resolveSettingsPage({ queryPage: alias }), canonical);
    assert.equal(resolveSettingsPage({
      storage: storageFixture({ 'grigdesk-settings-page': alias }),
    }), canonical);
  }

  assert.equal(resolveSettingsPage({
    storage: storageFixture({ 'grigdesk-settings-tab': 'access' }),
  }), canonical);
  assert.equal(SETTINGS_PAGES.filter((page) => /^connections\.(mobile|devices)$/.test(page.id)).length, 1);
});

test('CAT-N1: старый install адрес переносится в общий раздел', () => {
  assert.equal(resolveSettingsPage({ pageId: 'plugins.install' }), 'plugins.installed');
  assert.equal(resolveSettingsPage({ queryPage: 'plugins.install' }), 'plugins.installed');
  assert.equal(resolveSettingsPage({ storage: storageFixture({
    'grigdesk-settings-page': 'plugins.install',
  }) }), 'plugins.installed');
  assert.deepEqual(SETTINGS_PAGES.filter((page) => page.groupId === 'plugins').map((page) => page.id),
    ['plugins.installed']);
});

test('CAT-N3: системные плагины разнесены по своим страницам каталога', async () => {
  const { SYSTEM_PLUGIN_PAGES, pluginSettingsPageId, pluginSettingsTarget, systemPluginOfPage } =
    await import('../../web/src/features/settings/pluginPages.ts');

  assert.deepEqual(SYSTEM_PLUGIN_PAGES, {
    ssh: 'connections.ssh',
    db: 'connections.db',
    telegram: 'connections.telegram',
    github: 'connections.github',
    analysis: 'automation.analysis',
    shelf: 'automation.shelf',
    inbox: 'automation.inbox',
    video: 'speech.videoTasks',
    'usage-forecast': 'interface.usageForecast',
    code: 'tools.code',
    docker: 'tools.docker',
    showcase: 'tools.showcase',
  });

  const groupOf = {
    ssh: 'connections',
    db: 'connections',
    telegram: 'connections',
    github: 'connections',
    analysis: 'automation',
    shelf: 'automation',
    inbox: 'automation',
    video: 'speech',
    'usage-forecast': 'interface',
    code: 'tools',
    docker: 'tools',
    showcase: 'tools',
  };

  for (const [pluginId, pageId] of Object.entries(SYSTEM_PLUGIN_PAGES)) {
    const page = SETTINGS_PAGES.find((item) => item.id === pageId);

    assert.equal(Boolean(page), true, `${pluginId}: страница ${pageId} объявлена`);
    assert.equal(page.groupId, groupOf[pluginId], `${pluginId}: группа страницы`);
    assert.equal(pluginSettingsPageId(pluginId, true), pageId);
    assert.equal(systemPluginOfPage(pageId), pluginId);
    assert.deepEqual(pluginSettingsTarget(pluginId, true), { pageId });

    for (const locale of ['ru', 'en']) {
      assert.equal(translator.t(locale, `settings.builtinPlugins.${pluginId}.name`),
        getSettingsPages(locale).find((item) => item.id === pageId).label,
        `${pluginId}: подпись страницы берётся из перевода плагина (${locale})`);
    }
  }

  assert.equal(pluginSettingsPageId('sample', false), 'plugins.installed');
  assert.deepEqual(pluginSettingsTarget('sample', false),
    {
      pageId: 'plugins.installed',
      entityId: 'sample'
    });
  assert.deepEqual(pluginSettingsTarget('unknown', true),
    {
      pageId: 'plugins.installed',
      entityId: 'unknown'
    });
  assert.deepEqual(pluginSettingsTarget('ssh', false),
    {
      pageId: 'plugins.installed',
      entityId: 'ssh'
    });

  for (const id of ['constructor', 'toString', '__proto__']) {
    assert.equal(pluginSettingsPageId(id, true), 'plugins.installed');
    assert.deepEqual(pluginSettingsTarget(id, true), {
      pageId: 'plugins.installed',
      entityId: id
    });
    assert.equal(systemPluginOfPage(id), null);
  }
});
