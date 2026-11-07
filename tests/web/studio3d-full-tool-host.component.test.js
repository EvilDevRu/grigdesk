// Приёмка source интеграции после удаления встроенного Studio3D.
// Настоящие HTTP loader/auth/SDK/IDB/ToolHost/UI; это не installed packaged или WebGL приёмка.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { studioBrowserFixture } from './helpers/studio3dPluginBackground.js';
import { webFile } from './helpers/compile-vue.js';
import {
  studioIntegrationTest, studioUntil, uploadStudioModel,
} from '../server/helpers/studio3dPluginFixture.js';

function integration(name, callback) {
  return studioIntegrationTest(test, name, callback, { timeout: 30000 });
}

/**
 * Проверяется настоящий принятый каталог без сортировки/фильтрации system записей.
 * Отсутствие builtin компонента подтверждается и реестром, и исходным import graph.
 */
async function assertOnlyExternal(f) {
  const rows = f.plugins.list.filter((row) => row.id === 'studio3d');

  assert.equal(rows.length, 1);
  assert.equal(Boolean(rows[0].system), false);
  assert.equal(rows[0].enabled, true);
  assert.equal(rows[0].entrypoints.web.background.endsWith('/background.js'), true);
  assert.equal(f.host.toolCatalog.TOOL_CATALOG.some((row) => row.id === 'studio3d'), false);
  assert.equal(f.host.toolRegistry.TOOL_REGISTRY.some((row) => row.id === 'studio3d'), false);

  const source = await readFile(webFile('src/shared/tools/registry.ts'), 'utf8');

  assert.doesNotMatch(source, /views\/studio3d\/Studio3dPanel\.vue/);
}

/**
 * Ожидание выполняет настоящую styles загрузку fixture и DOM tick перед assertion.
 * WebGL не эмулируется: тест принимает lifecycle/выбор, не качество рендера.
 */
async function waitDom(f, selector) {
  return studioUntil(async () => {
    await f.settle();

    return f.element.querySelector(selector);
  }, Boolean);
}

/**
 * Панель с mode=hidden остаётся в DOM широкого клиента, но не является открытой поверхностью.
 * Проверка отличает одновременно показанные экземпляры от сохранённого скрытого dock.
 */
function presentedPanels(f) {
  return f.element.querySelectorAll(
    '.tool-surface.is-page .studio-panel, .tool-surface.is-dock .studio-panel');
}

for (const [width, presentation] of [[1280, 'page'], [900, 'dock'], [899, 'page']]) {
  integration(`S3D-FULL-HOST ${width}/${presentation}: одна actual внешняя панель и сохранённый draft`,
    async (t) => {
      const f = await studioBrowserFixture(t, {
        fullHost: true,
        width,
        route: presentation === 'page' ? '/ext/studio3d' : '/chats',
      });

      await f.login();
      await f.ready();
      await assertOnlyExternal(f);
      assert.equal(f.counts().panel, 0);
      await f.mountHost();

      if (presentation === 'dock') {
        f.dock.open('studio3d');
      }

      const textarea = await waitDom(f, '.studio-panel textarea');
      const panel = f.element.querySelector('.studio-panel');

      textarea.value = 'Черновик настоящего внешнего ToolHost';
      textarea.dispatchEvent(new f.browser.Event('input', { bubbles: true }));
      await f.settle();
      assert.equal(presentedPanels(f).length, 1);
      assert.equal(f.element.querySelector('.plugin-module').classList.contains('is-compact'),
        presentation === 'dock' || width < 900);
      assert.equal(panel.classList.contains('is-page'), presentation === 'page');

      if (presentation === 'dock') {
        f.element.querySelector('[data-context="tool-dock-hide"]').click();
        await f.settle();
        assert.equal(presentedPanels(f).length, 0);
        assert.equal(f.element.querySelector('.studio-panel'), panel);

        const button = [...f.element.querySelectorAll('[data-context="tool-rail-item"]')]
          .find((item) => item.getAttribute('aria-label')?.startsWith('3D'));

        assert.ok(button);
        button.click();
        await waitDom(f, '.tool-surface.is-dock .studio-panel.is-active');
      } else {
        f.element.querySelector('.studio-panel [aria-label="Задачи"]').click();
        await f.settle();
        f.element.querySelector('.studio-panel [aria-label="Создать"]').click();
        await f.settle();
      }

      assert.equal(f.element.querySelector('.studio-panel'), panel);
      assert.equal(f.element.querySelector('.studio-panel textarea'), textarea);
      assert.equal(textarea.value, 'Черновик настоящего внешнего ToolHost');
      assert.equal(presentedPanels(f).length, 1);
      assert.deepEqual(f.counts(), { panel: 1, background: 1 });
      assert.equal(f.sources.filter((source) => !source.closed).length, 1);
      assert.equal(f.fake.requests.filter((row) => row.method === 'POST').length, 0);
    });
}

integration('S3D-FULL-HOST actual query model/version получает ровно enqueue/consume и прежний Root',
  async (t) => {
    const f = await studioBrowserFixture(t, {
      fullHost: true,
      width: 900,
      route: '/chats',
    });

    await f.login();
    await f.ready();
    await assertOnlyExternal(f);
    await f.mountHost();
    f.dock.open('studio3d');

    const textarea = await waitDom(f, '.studio-panel textarea');
    const panel = f.element.querySelector('.studio-panel');
    const uploaded = await uploadStudioModel(f);

    assert.equal(uploaded.statusCode, 200, uploaded.body);

    const created = await f.call('POST', '/models', {
      libraryId: f.libraryId,
      uploadId: uploaded.json().uploadId,
      name: 'Модель β для настоящего ToolHost',
    });

    assert.equal(created.statusCode, 200, created.body);

    const model = created.json();
    const queued = [];
    const consumed = [];
    const enqueue = f.dock.enqueue.bind(f.dock);
    const consume = f.dock.consume.bind(f.dock);

    t.mock.method(f.dock, 'enqueue', (id, payload) => {
      queued.push([id, payload]);

      return enqueue(id, payload);
    });
    t.mock.method(f.dock, 'consume', (id, value) => {
      consumed.push([id, value]);

      return consume(id, value);
    });
    await f.router.push({
      path: '/ext/studio3d',
      query: { model: model.model.id, version: model.version.id },
    });

    const session = await f.product.session(f.panelContexts.at(-1));

    await studioUntil(async () => {
      await f.settle();

      return session.store.detail;
    }, (value) => value?.model.id === model.model.id);
    assert.equal(session.store.selectedVersion, model.version.id);
    assert.deepEqual(queued, [['studio3d', {
      type: 'open',
      params: { model: model.model.id, version: model.version.id },
    }]]);
    assert.equal(consumed.length, 1);
    assert.equal(consumed[0][0], 'studio3d');
    assert.equal(Number.isSafeInteger(consumed[0][1]), true);
    assert.equal(f.dock.intents.studio3d, undefined);
    assert.deepEqual(f.router.currentRoute.value.query, {});
    assert.equal(f.element.querySelector('.studio-panel'), panel);
    assert.equal(f.element.querySelector('.studio-panel textarea'), textarea);
    assert.equal(presentedPanels(f).length, 1);
    await f.router.replace('/ext/studio3d');
    await f.settle();
    assert.equal(queued.length, 1);
    assert.equal(consumed.length, 1);
    assert.deepEqual(f.counts(), { panel: 1, background: 1 });
    assert.equal(f.fake.requests.filter((row) => row.method === 'POST').length, 0);
  });

for (const width of [899, 900]) {
  integration(`S3D-FULL-HOST ${width}: default/custom/off native keydown адресует studio3d`, async (t) => {
    const f = await studioBrowserFixture(t, {
      fullHost: true,
      width,
      route: '/chats',
    });

    await f.login();
    await f.ready();
    await assertOnlyExternal(f);
    await f.mountHost();
    assert.equal(f.counts().panel, 0);
    assert.equal(f.hotkeys.toolByCombo['Ctrl+Shift+Digit7'], 'studio3d');

    const press = async (code) => {
      document.dispatchEvent(new f.browser.KeyboardEvent('keydown', {
        key: code === 'KeyY' ? 'Y' : '7',
        code,
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }));
      await f.settle();
    };
    const close = async () => {
      await f.router.push('/chats');
      f.dock.close();
      await f.settle();
    };

    await press('Digit7');
    await waitDom(f, '.studio-panel textarea');
    assert.equal(presentedPanels(f).length, 1);
    assert.deepEqual(f.counts(), { panel: 1, background: 1 });
    await close();
    assert.equal(f.hotkeys.replaceOverrides({ studio3d: 'Ctrl+Shift+KeyY' }).ok, true);

    const imports = f.counts().panel;

    await press('Digit7');
    assert.equal(f.counts().panel, imports);
    assert.equal(presentedPanels(f).length, 0);
    await press('KeyY');
    await waitDom(f, '.studio-panel textarea');
    assert.equal(presentedPanels(f).length, 1);
    await close();
    assert.equal(f.hotkeys.replaceOverrides({ studio3d: '' }).ok, true);

    const disabledImports = f.counts().panel;

    await press('Digit7');
    await press('KeyY');
    assert.equal(f.counts().panel, disabledImports);
    assert.equal(presentedPanels(f).length, 0);
    assert.equal(f.router.currentRoute.value.path, '/chats');
    assert.equal(f.dock.isOpen, false);
    assert.equal(f.fake.requests.filter((row) => row.method === 'POST').length, 0);
  });

  integration(`S3D-FULL-HOST ${width}: настоящий no-package missing сохраняет query и импортирует P0`,
    async (t) => {
      const f = await studioBrowserFixture(t, {
        fullHost: true,
        noPackage: true,
        width,
        route: '/ext/studio3d?tab=models&model=old-model&version=v1',
      });

      await f.login();
      f.dock.open('studio3d');
      f.dock.expandedPreferences.studio3d = true;
      await f.mountHost();
      await waitDom(f, '[data-plugin-route-state="missing"]');
      assert.equal(f.plugins.list.some((row) => row.id === 'studio3d'), false);
      assert.equal(f.host.toolCatalog.TOOL_CATALOG.some((row) => row.id === 'studio3d'), false);
      assert.equal(f.host.toolRegistry.TOOL_REGISTRY.some((row) => row.id === 'studio3d'), false);
      assert.equal(f.dock.activeTool, 'studio3d');
      assert.equal(f.dock.expandedPreferences.studio3d, true);
      assert.deepEqual(f.router.currentRoute.value.query,
        {
          tab: 'models',
          model: 'old-model',
          version: 'v1',
        });
      assert.equal(f.element.querySelector('.studio-panel'), null);
      assert.deepEqual(f.counts(), { panel: 0, background: 0 });
      f.dock.open('terminal');
      await f.settle();
      assert.equal(f.element.querySelector('.tool-surface.is-dock'), null);
      assert.match(f.element.querySelector('[data-plugin-route-state="missing"]').textContent,
        /не установлен/);
      f.element.querySelector('[data-plugin-route-action]').click();
      await f.settle();
      assert.equal(f.settings.pageId, 'plugins.installed');
      assert.equal(f.settings.entityId, 'studio3d');
      assert.deepEqual(f.counts(), { panel: 0, background: 0 });
      assert.equal(f.requests.some((row) => row.path.startsWith('/api/ext/studio3d/')), false);
      assert.equal(f.fake.requests.filter((row) => row.method === 'POST').length, 0);
    });
}
