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
import { manifestV1, png } from '../helpers/pluginV1.js';
import { normalizePluginCategory } from '../../shared/plugins/pluginsContracts.ts';

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
      ssh: ['dock', 40],
      db: ['dock', 50],
      docker: ['dock', 60],
      showcase: ['tools', 50],
      studio3d: ['dock', 30],
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
    {
      path: '/legacy',
      label: 'Legacy',
      group: 'rail',
      order: 7,
    },
  );
  assert.match(warnings[0], /future.*rail/);
  assert.equal(normalizePluginNav(null, 'x'), null);
  assert.deepEqual(
    normalizePluginNav({ path: '/no-order', order: null }, 'Без порядка'),
    {
      path: '/no-order',
      label: 'Без порядка',
      group: 'rail',
    },
  );
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
      ssh: 'dev',
      db: 'dev',
      docker: 'dev',
      showcase: 'knowledge',
      studio3d: 'dev',
      'usage-forecast': 'dev',
    },
  );
  assert.deepEqual(
    SYSTEM.filter((plugin) => normalizePluginCategory(plugin.category) !== plugin.category),
    [],
    'категория системного манифеста обязана быть из общего контракта',
  );

  const dir = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-plugin-category-'));
  try {
    const manifests = {
      helper: { id: 'helper', name: 'Помощник', category: 'dev' },
      alerts: { id: 'alerts', name: 'Сигналы', category: 'notifications' },
      plain: { id: 'plain', name: 'Без категории' },
    };

    for (const [id, manifest] of Object.entries(manifests)) {
      const pluginDir = path.join(dir, id);
      await mkdir(pluginDir);
      await mkdir(path.join(pluginDir, 'assets'));
      await writeFile(path.join(pluginDir, 'assets/icon.png'), png);
      await writeFile(path.join(pluginDir, 'plugin.json'), JSON.stringify(manifestV1({
        entrypoints: {},
        contributes: {},
        ...manifest,
      })));
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
