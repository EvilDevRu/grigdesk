import assert from 'node:assert/strict';
import test from 'node:test';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';
import { settingsResource } from './helpers/settings-session.js';

process.env.NODE_ENV = 'test';

test('Оболочка настроек на настоящем UiDialog', async (t) => {
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

  /**
   * Каждый сценарий получает новую Pinia и монтирует настоящие hosts в одном document.
   * Ресурс синтетический; модель сессии и модальные примитивы не подменяются.
   */
  async function scenarioFixture(scenario, options = {}) {
    const wrapper = mount(Harness, {
      attachTo: doc.querySelector('#mount'),
      global: {
        plugins: [createPinia()],
        stubs: { transition: false },
      },
    });

    scenario.after(async () => {
      wrapper.unmount();
      await flushPromises();
    });

    const settings = wrapper.vm.settings;

    settings.setAuthenticated(true);
    settings.requestOpen({ source: 'button' });
    await flushPromises();

    assert.equal(Boolean(doc.querySelector('[data-role="settings-modal"]')), true);

    const resource = settingsResource('test', { value: 'исходное' }, options);

    settings.registerResource(resource.adapter, resource.fields);
    await settings.loadResource('test');

    return {
      wrapper,
      settings,
      resource,
    };
  }

  /**
   * Действие выбирается по видимой подписи или доступному имени иконки.
   * Проверяется только скаляр наличия, DOM не попадает в форматтер assert.
   */
  async function click(label) {
    const button = [...doc.querySelectorAll('button')].find((node) =>
      node.textContent.trim() === label || node.getAttribute('aria-label') === label);

    assert.equal(Boolean(button), true, `Есть кнопка ${label}`);
    await new DOMWrapper(button).trigger('click');
    await flushPromises();
  }

  async function escape() {
    doc.activeElement.dispatchEvent(new browser.KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    }));
    await flushPromises();
  }

  /**
   * Настоящий Transition снимает DOM после кадров анимации, а не в следующем Promise.
   * Ожидание ограничено и проверяет конечный DOM без подмены модального окружения.
   */
  async function waitForRemoval(selector) {
    for (let attempt = 0; attempt < 100 && doc.querySelector(selector); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.equal(Boolean(doc.querySelector(selector)), false);
  }

  await t.test('MD01: повторный open не создаёт вторую форму и не теряет ввод', async (scenario) => {
    const { settings } = await scenarioFixture(scenario);

    settings.setField('test', 'value', 'правка');
    settings.requestOpen({ source: 'shortcut' });
    await flushPromises();

    assert.equal(doc.querySelectorAll('[data-role="settings-modal"]').length, 1);
    assert.equal(settings.getValue('test', 'value'), 'правка');
  });

  await t.test('MD02: backdrop не закрывает, крестик и Escape закрывают чистую форму', async (scenario) => {
    const { settings } = await scenarioFixture(scenario);
    const overlay = doc.querySelector('[data-role="settings-modal"]').parentElement;

    await new DOMWrapper(overlay).trigger('click');

    assert.equal(settings.isOpen, true);
    await click('Закрыть настройки');

    assert.equal(settings.isOpen, false);

    settings.requestOpen({ source: 'button' });
    await flushPromises();
    await escape();

    assert.equal(settings.isOpen, false);
  });

  for (const [choice, closes, writes] of [
    ['Продолжить редактирование', false, 0],
    ['Не сохранять', true, 0],
    ['Применить и закрыть', true, 1],
  ]) {
    await t.test(`MD03: dirty-close — ${choice}`, async (scenario) => {
      const { settings, resource } = await scenarioFixture(scenario);

      settings.setField('test', 'value', 'правка');
      await click('Закрыть настройки');

      assert.equal(doc.querySelectorAll('[data-role="settings-close-choice"] button').length, 3);
      await click(choice);

      assert.equal(settings.isOpen, !closes);
      assert.equal(resource.calls.writes.length, writes);
    });
  }

  for (const [choice, runs, writes] of [
    ['Продолжить редактирование', 0, 0],
    ['Не сохранять', 1, 0],
    ['Применить и закрыть', 1, 1],
    ['Escape', 0, 0],
  ]) {
    await t.test(`W1: отложенное действие через диалог — ${choice}`, async (scenario) => {
      const gate = Promise.withResolvers();
      const { settings, resource } = await scenarioFixture(scenario, {
        write: async () => {
          await gate.promise;

          return {
            status: 'success',
            fields: [{
              key: 'value',
              status: 'success',
              serverValue: 'правка',
            }],
          };
        },
      });
      let ran = 0;

      settings.setField('test', 'value', 'правка');

      const transition = settings.requestAction(async () => {
        ran += 1;

        return true;
      });

      await flushPromises();
      assert.equal(settings.closeChoiceOpen, true);

      if (choice === 'Escape') {
        await escape();
      } else {
        await click(choice);
      }

      if (writes) {
        assert.equal(ran, 0, 'Действие ждёт подтверждения записи');
        await settings.chooseClose('continue');
      }

      gate.resolve();
      await flushPromises();

      const outcome = await Promise.race([
        transition,
        new Promise((resolve) => setTimeout(() => resolve('pending'), 250)),
      ]);

      assert.equal(resource.calls.writes.length, writes);
      assert.equal(ran, runs, 'Действие выполняется ровно один раз');
      assert.equal(settings.isOpen, runs === 0);
      assert.equal(settings.closeChoiceOpen, false);
      assert.equal(outcome, runs === 1);
    });
  }

  await t.test('W2: отказ проверки виден, действие завершается без зависания', async (scenario) => {
    const { settings } = await scenarioFixture(scenario, {
      validate() {
        throw new Error('Исполнитель больше недоступен');
      },
    });
    let ran = 0;

    settings.setField('test', 'value', 'правка');

    const transition = settings.requestAction(async () => {
      ran += 1;

      return true;
    });

    await flushPromises();
    await click('Применить и закрыть');

    const outcome = await Promise.race([
      transition,
      new Promise((resolve) => setTimeout(() => resolve('pending'), 250)),
    ]);

    assert.equal(outcome, false);
    assert.equal(ran, 0);
    assert.equal(settings.isOpen, true);
    assert.match(doc.body.textContent, /Исполнитель больше недоступен/);

    const next = settings.requestAction(async () => true);

    assert.equal(settings.closeChoiceOpen, true, 'Неудачный выбор освободил pendingAction');
    await flushPromises();
    await click('Продолжить редактирование');
    assert.equal(await next, false);
  });

  await t.test('MD04 (guard): вложенный QR получает первый Escape и сохраняет фокус', async (scenario) => {
    const { settings } = await scenarioFixture(scenario);

    await click('Открыть QR');

    const focused = doc.activeElement;

    settings.requestOpen({ source: 'shortcut' });
    await flushPromises();

    assert.equal(doc.activeElement === focused, true);
    await escape();

    assert.equal(settings.isOpen, true);
    await waitForRemoval('[aria-label="QR-проверка"]');
  });

  await t.test('MD05 (guard): Tab удержан, закрытие возвращает фокус триггеру', async (scenario) => {
    const { settings } = await scenarioFixture(scenario);

    settings.cancel();
    await flushPromises();

    const trigger = doc.querySelector('#fixture-open');

    trigger.focus();
    await new DOMWrapper(trigger).trigger('click');
    await flushPromises();

    const surface = doc.querySelector('[data-role="settings-modal"]');
    const buttons = [...surface.querySelectorAll('button:not([disabled])')];

    buttons.at(-1).focus();
    await new DOMWrapper(buttons.at(-1)).trigger('keydown', { key: 'Tab' });

    assert.equal(doc.activeElement === buttons[0], true, JSON.stringify({
      active: doc.activeElement?.getAttribute('aria-label') || doc.activeElement?.textContent?.slice(0, 80),
      first: buttons[0]?.getAttribute('aria-label') || buttons[0]?.textContent,
      inert: Boolean(surface.closest('[inert]')),
    }));
    await new DOMWrapper(buttons[0]).trigger('keydown', { key: 'Tab', shiftKey: true });

    assert.equal(doc.activeElement === buttons.at(-1), true);
    settings.cancel();
    await flushPromises();

    assert.equal(doc.activeElement === trigger, true);
  });

  await t.test('MD06: pending Apply не закрывается и не дублируется', async (scenario) => {
    const pending = Promise.withResolvers();
    const { settings, resource } = await scenarioFixture(scenario, { write: () => pending.promise });

    settings.setField('test', 'value', 'правка');

    const applying = settings.apply();

    await flushPromises();
    settings.requestClose('escape');
    settings.requestClose('action');
    settings.apply();

    assert.equal(settings.isOpen, true);
    assert.equal(settings.closeChoiceOpen, false);
    assert.equal(resource.calls.writes.length, 1);

    pending.resolve({
      status: 'success',
      fields: [{
        key: 'value',
        status: 'success',
        serverValue: 'правка',
      }],
    });
    await applying;
  });

  await t.test('MD07: auth-lost очищает форму и секрет', async (scenario) => {
    const { settings } = await scenarioFixture(scenario, {
      fields: [{
        key: 'value',
        secret: true,
        address: { pageId: 'interface.behavior', fieldPath: ['value'] },
      }],
    });

    settings.setField('test', 'value', 'synthetic-secret');
    settings.dispose('auth-lost');
    await flushPromises();

    assert.equal(settings.isOpen, false);
    assert.equal(settings.getIntent('test', 'value'), undefined);
    await waitForRemoval('[data-role="settings-modal"]');
  });

  await t.test('MD08: shortcut/menu уважают чужой модал; button открывает', async (scenario) => {
    const { wrapper, settings } = await scenarioFixture(scenario);

    settings.cancel();
    wrapper.vm.other = true;
    await flushPromises();

    const focus = doc.activeElement;

    assert.equal(wrapper.vm.hasOpenModal(), true);
    assert.equal(settings.requestOpen({ source: 'shortcut' }), false);
    assert.equal(settings.requestOpen({ source: 'menu' }), false);
    assert.equal(doc.activeElement === focus, true);
    settings.requestOpen({ source: 'button' });
    await flushPromises();

    assert.equal(settings.isOpen, true);
  });

  await t.test('MD09: UI-контекст содержит только page/entity открытой формы', async (scenario) => {
    const { wrapper, settings } = await scenarioFixture(scenario);

    settings.requestOpen({
      source: 'button',
      pageId: 'interface.behavior',
      entityId: 'public-entity',
    });
    settings.setField('test', 'value', 'не для модели');
    await flushPromises();

    const captured = wrapper.vm.ui.capture();

    assert.deepEqual(captured.promptContext.details.settings, {
      page: 'interface.behavior',
      entity: 'public-entity',
    });
    settings.cancel();
    await flushPromises();

    assert.equal(Boolean(wrapper.vm.ui.capture().promptContext.details?.settings), false);
  });
  await t.test('MD10: частичный результат называет поля и нормализацию', async (scenario) => {
    const { settings } = await scenarioFixture(scenario, {
      write: async () => ({
        status: 'success',
        fields: [{
          key: 'value',
          status: 'success',
          serverValue: 'нормализовано',
        }],
      }),
    });
    const failed = settingsResource('failed', { other: false }, {
      write: async () => ({
        status: 'failed',
        fields: [],
        message: 'Отказ второй области',
      }),
    });

    settings.registerResource(failed.adapter, failed.fields);
    await settings.loadResource('failed');
    settings.setField('test', 'value', 'длинная правка');
    settings.setField('failed', 'other', true);
    await settings.apply();
    await flushPromises();
    assert.match(doc.querySelector('[data-settings-saved]')?.textContent ?? '',
      /value.*сохранено как.*нормализовано/);
    assert.match(doc.querySelector('[data-settings-remaining]')?.textContent ?? '', /other/);
    assert.equal(settings.isOpen, true);
  });

});
