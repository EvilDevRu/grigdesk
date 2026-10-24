import assert from 'node:assert/strict';
import test from 'node:test';
import { detachButton, hostFixture } from './helpers/tool-window-harness.js';
import { loadProductModule } from './helpers/compile-vue.js';
import { descriptor, pluginCard, registryModule } from './helpers/pluginModuleContract.js';

for (const mode of ['main', 'page']) {
  test(`PM-NEIGHBOR-DETACH: Code/iframe и исключения terminal/3D в ${mode}`, async (t) => {
    const host = await hostFixture(t, { mode });

    for (const id of ['code', 'example', 'terminal', 'studio3d']) {
      host.dock.open(id);
      await host.settle();
      assert.equal(Boolean(detachButton(host.wrapper)), mode === 'main'
        && !['terminal', 'studio3d'].includes(id), id);
    }
  });
}

for (const width of [899, 900, 1280]) {
  test(`PM-DOCK/PM-NO-DETACH: модуль /ext и один mount при ${width}px`, async (t) => {
    const host = await hostFixture(t, { width });

    if (width === 899) {
      const { usePluginsStore } = await loadProductModule('src/stores/plugins.ts');
      const { pluginTools } = await registryModule();
      const store = usePluginsStore(host.pinia);
      const webModule = JSON.parse(JSON.stringify(descriptor).replaceAll('ui-module', 'module-example'));

      store.list = [pluginCard({ id: 'module-example', webModule })];
      store.loaded = true;
      assert.equal(pluginTools(store)[0]?.id, 'module-example', 'Узкий маршрут получает модуль из каталога');
    }

    await host.router.push('/ext/module-example');
    await host.settle();
    assert.equal(host.wrapper.findAll('[data-panel="module-example"]').length, 1);
    assert.equal(host.mounts.filter((id) => id === 'module-example').length, 1);
    assert.equal(Boolean(detachButton(host.wrapper)), false, 'Модуль нельзя открепить');
    assert.equal(host.wrapper.findAll('.tool-rail').length > 0, width >= 900);

    if (width >= 900) {
      await host.router.push('/chats');
      host.dock.open('module-example');
      await host.settle();

      assert.equal(Boolean(detachButton(host.wrapper)), false, 'Модуль в доке нельзя открепить');

      const expand = host.wrapper.findAll('button').find((button) => /Во весь экран|Развернуть/.test(
        button.text() + ' ' + button.attributes('aria-label'),
      ));

      assert.ok(expand, 'У модульного инструмента есть действие развёртывания');
      await expand.trigger('click');
      await host.settle();
      assert.equal(host.wrapper.findAll('[data-panel="module-example"]').length, 1);
      assert.equal(host.mounts.filter((id) => id === 'module-example').length, 1);
    }
  });
}
