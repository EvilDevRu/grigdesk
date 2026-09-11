import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  NAV_GROUPS,
  SYSTEM,
  normalizePluginNav,
  scanUserPlugins,
  settingsValues,
} from '../../server/src/lib/pluginsRegistry.ts';
import { normalizePluginCategory } from '../../shared/pluginsContracts.ts';

test('системные инструменты имеют явные group/order, а неизвестная группа нормализуется в rail', () => {
  assert.deepEqual(NAV_GROUPS, ['rail', 'tools', 'dock']);
  const placement = Object.fromEntries(
    SYSTEM.filter((plugin) => plugin.nav).map((plugin) => [plugin.id, plugin.nav]),
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(placement).map(([id, nav]) => [id, [nav.group, nav.order]])),
    {
      video: ['tools', 10],
      code: ['dock', 10],
      shelf: ['dock', 20],
      inbox: ['rail', 30],
      telegram: ['tools', 20],
      github: ['tools', 30],
      knowledge: ['tools', 40],
      ssh: ['dock', 40],
      db: ['dock', 50],
      docker: ['dock', 60],
      showcase: ['tools', 50],
    },
  );

  const inbox = SYSTEM.find((plugin) => plugin.id === 'inbox');
  const code = SYSTEM.find((plugin) => plugin.id === 'code');
  const telegram = SYSTEM.find((plugin) => plugin.id === 'telegram');
  const github = SYSTEM.find((plugin) => plugin.id === 'github');
  assert.equal(inbox.defaultEnabled, true);
  assert.deepEqual(
    inbox.settings.map((setting) => setting.key),
    ['triageModel', 'attachPhotos', 'attachVideos'],
  );
  assert.deepEqual(
    code.settings.map((setting) => [
      setting.key,
      setting.type,
      setting.default,
      setting.requiresCapability || null,
    ]),
    [['commitMessageModel', 'model', null, 'untrustedText']],
  );
  // Умолчания загрузки — часть контракта: фотографии в задаче полезны, видео
  // раздувает портал и уже пересказано транскриптом.
  assert.deepEqual(
    inbox.settings.filter((setting) => setting.type === 'checkbox')
      .map((setting) => [setting.key, setting.default]),
    [['attachPhotos', true], ['attachVideos', false]],
  );
  assert.deepEqual(telegram.settings, []);
  assert.equal(github.defaultEnabled, false);

  const warnings = [];
  assert.deepEqual(
    normalizePluginNav({ path: '/legacy', label: 'Legacy', group: 'future', order: 7 }, 'fallback', (m) => warnings.push(m)),
    { path: '/legacy', label: 'Legacy', icon: 'plugin', group: 'rail', order: 7 },
  );
  assert.match(warnings[0], /future.*rail/);
  assert.equal(normalizePluginNav(null, 'x'), null);
  assert.deepEqual(
    normalizePluginNav({ path: '/no-order', order: null }, 'Без порядка'),
    { path: '/no-order', label: 'Без порядка', icon: 'plugin', group: 'rail' },
  );
});

test('Знания объявлены включённым системным плагином без собственных настроек', () => {
  const knowledge = SYSTEM.find((plugin) => plugin.id === 'knowledge');

  assert.deepEqual(knowledge && {
    system: knowledge.system,
    defaultEnabled: knowledge.defaultEnabled,
    nav: knowledge.nav,
    settings: knowledge.settings,
  }, {
    system: true,
    defaultEnabled: true,
    nav: {
      path: '/knowledge',
      label: 'Знания',
      icon: 'knowledge',
      group: 'tools',
      order: 40,
    },
    settings: [],
  });
});

test('Триаж объявлен включённым системным плагином с моделью и выключенным авторазбором', () => {
  const analysis = SYSTEM.find((plugin) => plugin.id === 'analysis');

  assert.deepEqual({
    system: analysis?.system,
    defaultEnabled: analysis?.defaultEnabled,
    settings: analysis?.settings?.map((setting) => [
      setting.key,
      setting.type,
      setting.default,
      setting.requiresCapability || null,
    ]),
    values: analysis ? settingsValues({}, analysis) : null,
  }, {
    system: true,
    defaultEnabled: true,
    settings: [
      ['triageModel', 'model', null, 'scopedWorkspace'],
      ['autoArbitrate', 'checkbox', false, null],
    ],
    values: {
      triageModel: null,
      autoArbitrate: false,
    },
  });
});

test('Полка включена по умолчанию и объявляет обе работающие настройки', () => {
  const shelf = SYSTEM.find((plugin) => plugin.id === 'shelf');

  assert.deepEqual({
    defaultEnabled: shelf?.defaultEnabled,
    nav: shelf?.nav,
    settings: shelf?.settings?.map((setting) => [
      setting.key,
      setting.type,
      setting.default,
    ]),
    values: shelf ? settingsValues({}, shelf) : null,
  }, {
    defaultEnabled: true,
    nav: {
      path: '/shelf',
      label: 'Полка',
      icon: 'shelf',
      group: 'dock',
      order: 20,
    },
    settings: [
      ['browserNotifications', 'checkbox', true],
      ['autoAddOnAnalysis', 'checkbox', true],
    ],
    values: {
      browserNotifications: true,
      autoAddOnAnalysis: true,
    },
  });
});

test('Сохранённые настройки полки перекрывают значения по умолчанию', () => {
  const shelf = SYSTEM.find((plugin) => plugin.id === 'shelf');

  assert.deepEqual(shelf ? settingsValues({
    pluginSettings: {
      shelf: {
        browserNotifications: false,
        autoAddOnAnalysis: false,
      },
    },
  }, shelf) : null, {
    browserNotifications: false,
    autoAddOnAnalysis: false,
  });
});

test('Inbox не импортирует и не использует Telegram-owned модель как fallback', () => {
  const inbox = SYSTEM.find((plugin) => plugin.id === 'inbox');
  const oldModel = { provider: 'codex', model: 'old-model' };
  const defaults = { attachPhotos: true, attachVideos: false };
  assert.deepEqual(settingsValues({
    pluginSettings: { telegram: { triageModel: oldModel } },
  }, inbox), { triageModel: null, ...defaults });

  const currentModel = { provider: 'codex', model: 'current-model' };
  assert.deepEqual(settingsValues({
    pluginSettings: {
      telegram: { triageModel: oldModel },
      inbox: { triageModel: currentModel },
    },
  }, inbox), { triageModel: currentModel, ...defaults });
});

test('user plugin scanner протаскивает nav.group/order и оставляет legacy manifest в rail', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cockpit-plugin-nav-'));
  try {
    const manifests = {
      modern: {
        id: 'modern', name: 'Современный', nav: { path: '/modern', label: 'Modern', icon: 'plugin', group: 'tools', order: 17 },
      },
      legacy: {
        id: 'legacy', name: 'Старый', nav: { path: '/legacy', label: 'Legacy' },
      },
    };
    for (const [id, manifest] of Object.entries(manifests)) {
      const pluginDir = path.join(dir, id);
      await mkdir(pluginDir);
      await writeFile(path.join(pluginDir, 'plugin.json'), JSON.stringify(manifest));
    }
    const warnings = [];
    const plugins = await scanUserPlugins(dir, { warn: (meta, message) => warnings.push({ meta, message }) });
    const byId = Object.fromEntries(plugins.map((plugin) => [plugin.id, plugin]));

    assert.deepEqual(byId.modern.nav, {
      path: '/modern', label: 'Modern', icon: 'plugin', group: 'tools', order: 17,
    });
    assert.deepEqual(byId.legacy.nav, {
      path: '/legacy', label: 'Legacy', icon: 'plugin', group: 'rail',
    });
    assert.ok(warnings.some((entry) => entry.meta.plugin === 'legacy' && /не задан.*rail/.test(entry.message)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('каждый системный плагин объявляет род работы, а чужая категория уходит в «Прочее»', async () => {
  // Категория режет экран настроек по роду работы. Системный модуль без неё попал бы
  // в «Прочее» вместе со сторонними — это и проверяем, а не просто наличие поля.
  assert.deepEqual(
    Object.fromEntries(SYSTEM.map((plugin) => [plugin.id, plugin.category])),
    {
      video: 'work',
      code: 'dev',
      analysis: 'work',
      shelf: 'work',
      inbox: 'work',
      telegram: 'work',
      github: 'work',
      knowledge: 'knowledge',
      ssh: 'dev',
      db: 'dev',
      docker: 'dev',
      showcase: 'knowledge',
    },
  );
  assert.deepEqual(
    SYSTEM.filter((plugin) => normalizePluginCategory(plugin.category) !== plugin.category),
    [],
    'категория системного манифеста обязана быть из общего контракта',
  );

  const dir = await mkdtemp(path.join(os.tmpdir(), 'cockpit-plugin-category-'));
  try {
    const manifests = {
      helper: { id: 'helper', name: 'Помощник', category: 'dev' },
      alerts: { id: 'alerts', name: 'Сигналы', category: 'notifications' },
      plain: { id: 'plain', name: 'Без категории' },
    };
    for (const [id, manifest] of Object.entries(manifests)) {
      const pluginDir = path.join(dir, id);
      await mkdir(pluginDir);
      await writeFile(path.join(pluginDir, 'plugin.json'), JSON.stringify(manifest));
    }
    const warnings = [];
    const plugins = await scanUserPlugins(dir, { warn: (meta, message) => warnings.push({ meta, message }) });
    const byId = Object.fromEntries(plugins.map((plugin) => [plugin.id, plugin]));

    assert.deepEqual(
      [byId.helper.category, byId.alerts.category, byId.plain.category],
      ['dev', 'other', 'other'],
    );
    // Молчаливая подмена оставила бы автора плагина искать группу, которой нет.
    assert.ok(
      warnings.some((entry) => entry.meta.plugin === 'alerts' && /notifications.*Прочее/.test(entry.message)),
      'подмену заявленной категории надо объяснить в журнале',
    );
    assert.equal(
      warnings.some((entry) => entry.meta.plugin === 'plain' && /категор|category/i.test(entry.message)),
      false,
      'манифест без категории — обычное дело, ругаться не на что',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
