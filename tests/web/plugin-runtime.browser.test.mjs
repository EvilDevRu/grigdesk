import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  browserContext, healthyCore, openModule, runtimeBrowser, sharedIdentity, sourceRoot,
} from './helpers/pluginRuntimeFixture.mjs';

test('PM-CONTEXT-BROWSER dev: настоящая панель с переводом, сессией и сохранением ввода', async (t) => {
  const f = await runtimeBrowser(t);

  await healthyCore(f.page);
  await browserContext(f);
  await sharedIdentity(f.page, { production: false });
});

for (const relative of ['web/src/ui.ts', 'web/src/components/primitives/UiButton.vue']) {
  test(`PM-HMR: ${relative} полностью перезагружает окно и сохраняет общую identity`, async (t) => {
    const f = await runtimeBrowser(t, { hmr: true });

    await openModule(f.page, f.origin);
    await sharedIdentity(f.page, { production: false });

    const navigation = f.page.waitForEvent('framenavigated', {
      predicate: (frame) => frame === f.page.mainFrame(),
      timeout: 10000,
    });

    f.server.watcher.emit('change', path.join(sourceRoot, relative));
    await navigation;
    assert.equal(f.page.url().includes('/ext/ui-module'), true);
    await f.page.evaluate(async () => {
      window.__pluginHost = await import('/__plugin_host_probe__.js');
      window.__pluginHost.mountCoreProbe();
    });
    await openModule(f.page, f.origin);
    await sharedIdentity(f.page, { production: false });
    await healthyCore(f.page);
  });
}

for (const width of [390, 1280]) {
  test(`PM-V1-BROWSER: actual ESM, общий Vue/UI, панель и slot без iframe при ${width}px`, async (t) => {
    const f = await runtimeBrowser(t, { width, v1: true });

    assert.equal(await f.page.evaluate(() => window.__pluginEntryExecutions ?? 0), 0);
    await openModule(f.page, f.origin);
    await sharedIdentity(f.page, { production: false });
    assert.equal(await f.page.locator('.tool-surface iframe').count(), 0);
    assert.equal(await f.page.evaluate(() => window.__pluginB1.starts), 1);
    await f.page.getByLabel('Ввод плагина').fill('Сохранённый ввод');
    await f.page.evaluate(() => {
      window.__closeV1Popup = window.__pluginHost.mountProviderPopup();
    });
    await f.page.getByText('Источник браузера', { exact: true }).waitFor({ timeout: 6000 });
    assert.equal(await f.page.evaluate(() => window.__pluginB1.starts), 1);
    assert.equal(await f.page.evaluate(() => window.__pluginEntryExecutions), 1);

    const icon = f.page.locator('img[src*="/api/plugins/ui-module/icon/"]').first();

    await icon.waitFor({ state: 'attached', timeout: 6000 });
    await icon.evaluate((image) => image.decode());
    assert.equal(await icon.evaluate((image) => image.complete && image.naturalWidth > 0), true);
    await f.page.evaluate(() => {
      const state = window.__pluginHost.fixtureState();

      state.plugins.list[0].placements[0].enabled = false;
    });
    await f.page.getByText('Источник браузера', { exact: true }).waitFor({ state: 'hidden' });
    assert.equal(await f.page.getByLabel('Ввод плагина').inputValue(), 'Сохранённый ввод');
    assert.equal(await f.page.evaluate(() => window.__pluginB1.cleanups), 0);
    await f.page.evaluate(() => window.__closeV1Popup());
    await healthyCore(f.page);
  });
}
