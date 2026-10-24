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
