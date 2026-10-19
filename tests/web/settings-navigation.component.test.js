import assert from 'node:assert/strict';
import test from 'node:test';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';
import { settingsResource } from './helpers/settings-session.js';

test('Дерево, поиск и адрес поля настроек', async (t) => {
  const browser = await installUiBrowser(t);
  const [{ createPinia }, { mount, flushPromises, DOMWrapper }, Harness] = await Promise.all([
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('../tests/web/helpers/SettingsModalHarness.vue'), {
      stubs: {
        './pageComponents.ts': `
          import Page from '../tests/web/helpers/SettingsPageFixture.vue';
          export const __esModule = true;
          export const SETTINGS_PAGE_COMPONENTS = { 'interface.behavior': Page };
        `,
      },
    }),
  ]);
  const doc = browser.document;
  const wrapper = mount(Harness, {
    attachTo: doc.querySelector('#mount'),
    global: {
      plugins: [createPinia()],
      stubs: { transition: false },
    },
  });

  t.after(() => wrapper.unmount());

  const settings = wrapper.vm.settings;
  const resource = settingsResource('test', { value: 'исходное' });

  resource.fields[0].address.entityId = 'test/a';
  resource.fields[0].address.tabId = 'parameters';

  settings.setAuthenticated(true);
  settings.requestOpen({ pageId: 'interface.behavior' });
  settings.registerResource(resource.adapter, resource.fields);
  await settings.loadResource('test');
  await flushPromises();

  /**
   * Клавиша отправляется выбранному узлу настоящего дерева, затем проверяется фокус.
   * Навигационные клавиши не должны менять выбранную страницу сессии.
   */
  async function key(id, value) {
    const node = doc.querySelector(`[data-settings-node="${id}"]`);

    assert.equal(Boolean(node), true, id);
    node.focus();
    await new DOMWrapper(node).trigger('keydown', { key: value });
    await flushPromises();
  }

  await t.test('NV01a–e: tree, roving tabindex и отдельный выбор страницы', async () => {
    assert.equal(Boolean(doc.querySelector('[role="tree"][aria-label="Разделы настроек"]')), true);
    assert.equal(doc.querySelectorAll('[role="treeitem"][tabindex="0"]').length, 1);
    assert.equal(doc.querySelector('[data-settings-node="interface.behavior"]')
      .getAttribute('aria-selected'), 'true');
    await key('interface.behavior', 'ArrowDown');

    assert.equal(doc.activeElement.getAttribute('data-settings-node'), 'interface.notifications');
    assert.equal(settings.pageId, 'interface.behavior');
    await key('interface.notifications', 'ArrowUp');
    await key('interface.behavior', 'ArrowLeft');

    assert.equal(doc.activeElement.getAttribute('data-settings-node'), 'interface');
    await key('interface', 'ArrowLeft');

    assert.equal(doc.querySelector('[data-settings-node="interface"]')
      .getAttribute('aria-expanded'), 'false');
    await key('interface', 'ArrowRight');
    await key('interface', 'ArrowRight');

    assert.equal(doc.activeElement.getAttribute('data-settings-node'), 'interface.behavior');
    await key('interface.behavior', 'End');

    assert.equal(doc.activeElement.getAttribute('data-settings-node'), 'system');
    await key('system', 'Home');

    assert.equal(doc.activeElement.getAttribute('data-settings-node'), 'interface');
    await key('interface.notifications', 'Enter');

    assert.equal(settings.pageId, 'interface.notifications');
    await key('interface.behavior', ' ');

    assert.equal(settings.pageId, 'interface.behavior');
    assert.equal(doc.querySelectorAll('[role="treeitem"][tabindex="0"]').length, 1);
  });

  await t.test('SE03/NV02: переходы сохраняют dirty и маркеры страницы и группы', async () => {
    settings.setField('test', 'value', 'правка');
    settings.selectPage('interface.notifications');
    await flushPromises();

    assert.equal(settings.getValue('test', 'value'), 'правка');
    assert.equal(doc.querySelector('[data-settings-node="interface.behavior"]')
      .getAttribute('data-dirty'), 'true');
    assert.equal(doc.querySelector('[data-settings-node="interface"]').getAttribute('data-dirty'), 'true');
  });

  await t.test('SE02: результат открывает поле, фокусирует и очищает revealTarget', async () => {
    const address = resource.fields[0].address;

    settings.setDynamicFields('fixture', [{
      address,
      label: 'Тестовое поле',
      description: 'Описание',
    }]);
    settings.query = 'Тестовое поле';
    await flushPromises();

    const result = [...doc.querySelectorAll('[data-settings-result]')].find((node) =>
      node.textContent.includes('Тестовое поле'));

    assert.equal(Boolean(result), true);
    await new DOMWrapper(result).trigger('click');
    await flushPromises();

    assert.equal(settings.pageId, address.pageId);
    assert.equal(settings.entityId, 'test/a');
    assert.equal(settings.tabId, 'parameters');
    assert.equal(settings.revealTarget, null);
    assert.equal(doc.activeElement.getAttribute('aria-label'), 'Тестовое поле');
    assert.equal(Boolean(doc.querySelector('[data-settings-field][data-revealed="true"]')), true);
    assert.equal(settings.getValue('test', 'value'), 'правка');
    assert.equal(resource.calls.reads.length, 1);
  });

  await t.test('SE07: исчезнувшая entity даёт объяснение; очистка возвращает дерево', async () => {
    const address = {
      pageId: 'agents.providers',
      entityId: 'удалён',
      tabId: 'parameters',
      fieldPath: ['ключ'],
    };

    settings.setDynamicFields('fixture', [{
      address,
      label: 'Исчезнувшее поле',
      description: '',
    }]);
    settings.query = 'Исчезнувшее поле';
    await flushPromises();

    const result = doc.querySelector('[data-settings-result]');

    settings.setDynamicFields('fixture', []);
    await new DOMWrapper(result).trigger('click');
    await flushPromises();

    assert.match(settings.navigationError, /больше недоступ/);
    assert.equal(settings.pageId, 'agents.providers');

    settings.query = '';
    await flushPromises();

    assert.equal(Boolean(doc.querySelector('[role="tree"]')), true);
    assert.equal(doc.querySelectorAll('[data-settings-result]').length, 0);
  });
});
