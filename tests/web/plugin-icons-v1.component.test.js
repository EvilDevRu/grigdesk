import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { createUiBrowser } from './helpers/ui-components.js';
import { settingsHarness } from './helpers/settings-harness.js';
import { cardV1 } from './helpers/pluginV1.js';

// Vue запоминает document при первом импорте: Vite и mounted UI разделяют один DOM.
// Он устанавливается до загрузки browser-helper и закрывается после обоих сценариев.
const browser = await createUiBrowser();
const { runtimeBrowser } = await import('./helpers/pluginRuntimeFixture.mjs');

after(() => browser.close());

/**
 * Меняется декларация одной карточки в настоящем Pinia store окна.
 * Потребители должны показать тот же URL без повторной интерпретации nav.icon.
 */
async function movePlugin(page, group, digest = 'a') {
  await page.evaluate(({ group, digest }) => {
    const plugin = window.__pluginHost.fixtureState().plugins.list[0];

    plugin.nav.group = group;
    plugin.contributes.panels[0].group = group;
    plugin.icon = `/api/plugins/ui-module/icon/${digest.repeat(64)}`;
  }, { group, digest });
}

test('V1-ICON-SURFACES: рейка, сайдбар и меню показывают один файл и новый digest', async (t) => {
  const f = await runtimeBrowser(t, { v1: true });
  const src = cardV1().icon;
  const rail = f.page.locator('.tool-rail-item[aria-label^="Модуль проверки"] img');

  const present = await rail.waitFor({ timeout: 6000 }).then(() => true, () => false);

  assert.equal(present, true, 'рейка рисует img файловой иконки');
  assert.equal(await rail.getAttribute('src'), src);
  await movePlugin(f.page, 'rail');

  const sidebar = f.page.locator('.sidebar a[aria-label^="Модуль проверки"] img');

  await sidebar.waitFor({ timeout: 6000 });
  assert.equal(await sidebar.getAttribute('src'), src);
  await movePlugin(f.page, 'tools');
  await f.page.goto(f.origin + '#/tools');

  const grid = f.page.locator('.tools-grid a').filter({ hasText: 'Модуль проверки' }).locator('img');

  await grid.waitFor({ timeout: 6000 });
  assert.equal(await grid.getAttribute('src'), src);
  await movePlugin(f.page, 'tools', 'b');
  await f.page.waitForFunction(() => [...document.querySelectorAll('.tools-grid img')]
    .some((image) => image.getAttribute('src')?.endsWith('b'.repeat(64))));
  await grid.dispatchEvent('error');
  assert.equal(await f.page.locator('.tools-grid a').filter({ hasText: 'Модуль проверки' }).count(), 1);
});

test('V1-ICON-SURFACES: установленная выключенная карточка сохраняет файловую иконку', async (t) => {
  const card = cardV1({ enabled: false });
  const h = await settingsHarness(t, 'plugins.installed', 'PluginWorkspacePage', {
    browser,
    prepare({ plugins }) {
      plugins.list = [card];
    },
  });

  await h.wrapper.get('[data-plugins-tab="installed"]').trigger('click');
  await h.flushPromises();

  const images = h.wrapper.findAll('img').filter((image) => image.attributes('src') === card.icon);

  assert.ok(images.length > 0, 'список установленных рисует тот же файл выключенного плагина');
  await images[0].trigger('error');
  await h.flushPromises();
  assert.match(h.wrapper.text(), /Модуль проверки/u);
});
