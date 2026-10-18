import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SETTINGS_GROUPS,
  SETTINGS_PAGES,
  equalFieldAddress,
  resolveFieldAddress,
  resolveSettingsPage,
} from '../../web/src/features/settings/catalog.ts';

const EXPECTED_PAGES = [
  ['interface', ['behavior', 'notifications', 'shortcuts']],
  ['agents', ['providers', 'models']],
  ['automation', ['chats', 'context', 'launch', 'monitoring', 'arbiter']],
  ['speech', ['dictation', 'video', 'language', 'models', 'advanced']],
  ['connections', ['b24', 'mobile']],
  ['plugins', ['installed', 'install']],
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
  assert.equal(resolveSettingsPage({ storage }), 'speech.language');
  assert.equal(resolveSettingsPage(), 'interface.behavior');

  const bothKeys = storageFixture({
    'grigdesk-settings-page': 'speech.video',
    'grigdesk-settings-tab': 'providers',
  });

  assert.equal(resolveSettingsPage({ storage: bothKeys }), 'speech.video');
  assert.deepEqual(bothKeys.removed, []);

  const oldTabs = {
    app: 'interface.behavior',
    speech: 'speech.dictation',
    b24: 'connections.b24',
    providers: 'agents.providers',
    runs: 'automation.chats',
    plugins: 'plugins.installed',
    server: 'system.startup',
    access: 'connections.mobile',
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
  const storage = storageFixture({ 'grigdesk-settings-page': 'connections.b24' });

  assert.equal(
    resolveSettingsPage({
      pageId: 'missing',
      queryPage: '../evil.vue',
      storage,
    }),
    'connections.b24',
  );
  assert.equal(resolveSettingsPage({ pageId: {}, queryPage: 'speech.video' }), 'speech.video');
  assert.equal(storage.records.get('grigdesk-settings-page'), 'connections.b24');
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
