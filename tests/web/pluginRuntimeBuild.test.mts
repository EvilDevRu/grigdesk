import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import test, { after } from 'node:test';
import {
  browserContext,
  buildRuntime,
  expectPanelMessage,
  expectedUiExports,
  healthyCore,
  runtimeBrowser,
  runtimeMap,
  sharedControls,
} from './helpers/pluginRuntimeFixture.mjs';

const builtPromise = buildRuntime();

after(async () => {
  const built = await builtPromise.catch(() => null);

  if (built) {
    await rm(built.directory, { recursive: true, force: true });
  }
});

test('PM-BUILD: настоящий HTML, hashed фасады, полный UI и единственные исходные singleton-модули',
  async () => {
    const built = await builtPromise;
    const map = runtimeMap(built);
    const facade = built.output.find((item) => './' + item.fileName === map.imports['@grigdesk/ui']);

    assert.ok(facade && facade.type === 'chunk');
    assert.deepEqual([...facade.exports].sort(), await expectedUiExports());

    const owners = new Map<string, Set<string>>();

    for (const item of built.output) {
      if (item.type !== 'chunk') {
        continue;
      }

      for (const id of Object.keys(item.modules)) {
        const normalized = id.split('?')[0];

        assert.ok(normalized);

        const isVue = /\/node_modules\/(?:vue|@vue\/[^/]+)\//.test(normalized);
        const isService = /\/web\/src\/services\/(?:dialogs|tooltips|layers\/stack)\.ts$/
          .test(normalized);

        if (!isVue && !isService) {
          continue;
        }

        const chunks = owners.get(normalized) ?? new Set<string>();

        chunks.add(item.fileName);
        owners.set(normalized, chunks);
      }
    }

    assert.ok([...owners.keys()].some((id) => id.includes('/node_modules/vue/')));
    assert.ok([...owners.keys()].some((id) => id.includes('services/dialogs')));
    assert.ok([...owners.keys()].some((id) => id.includes('layers/stack')));
    assert.ok([...owners.keys()].some((id) => id.includes('tooltips')));
    assert.deepEqual([...owners].filter(([, chunks]) => chunks.size !== 1), []);
  });

test('PM-SHARED: production === Vue/UI, рецепт автора, диалоги/tooltip/Escape/CSS', async (t) => {
  const built = await builtPromise;

  runtimeMap(built);

  const f = await runtimeBrowser(t, { built });

  await healthyCore(f.page);
  await sharedControls(f);
  await healthyCore(f.page);
});

for (const variant of ['missing-map', 'invalid-json', 'missing-target', 'wrong-identity']) {
  test(`PM-FALLBACK: ${variant}, ядро до и после отказа карты работает`, async (t) => {
    const built = await builtPromise;

    runtimeMap(built);

    const f = await runtimeBrowser(t, { built, variant });

    await healthyCore(f.page);
    await f.page.goto(f.origin + '#/ext/ui-module');
    await expectPanelMessage(f.page, 'core.pluginModuleUnsupported');
    await expectPanelMessage(f.page, 'core.pluginModuleUnsupported', 'en');
    assert.equal(await f.page.evaluate('window.__pluginEntryExecutions || 0'), 0);
    await healthyCore(f.page);
  });
}

for (const width of [390, 899, 900, 1280]) {
  test(`PM-CONTEXT-BROWSER: сессия/язык/ввод/SSE при ${width}px`, async (t) => {
    const built = await builtPromise;

    runtimeMap(built);

    const f = await runtimeBrowser(t, { built, width });

    await browserContext(f);
    assert.equal(await f.page.locator('.tool-rail').count() > 0, width >= 900);
  });
}

for (const [file, key] of [
  ['missing.js', 'core.pluginModuleLoadFailed'],
  ['broken.js', 'core.pluginModuleRenderFailed'],
]) {
  test(`PM-ERROR-BROWSER: ${file}, ошибка внутри панели и здоровое окно`, async (t) => {
    const built = await builtPromise;

    runtimeMap(built);

    const f = await runtimeBrowser(t, { built, entry: `/api/ext/ui-module/module/${file}` });

    await f.page.goto(f.origin + '#/ext/ui-module');
    await expectPanelMessage(f.page, key);
    await expectPanelMessage(f.page, key, 'en');
    await healthyCore(f.page);
  });
}
