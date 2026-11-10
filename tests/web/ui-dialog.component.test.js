import assert from 'node:assert/strict';
import test from 'node:test';
import { compileModule, compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

test('UiDialog централизует workspace layer, edge-to-edge body и Escape', async (t) => {
  const browser = await installUiBrowser(t);
  const [{ h, nextTick }, { mount, flushPromises }, facade] = await Promise.all([
    import('../../web/node_modules/vue/index.mjs'),
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileModule(webFile('src/ui.ts')),
  ]);
  const { UiDialog, hasOpenModal } = facade;
  const updates = [];
  const closes = [];
  let wrapper;

  assert.equal(hasOpenModal(), false);

  wrapper = mount(UiDialog, {
    attachTo: browser.document.querySelector('#mount'),
    props: {
      open: true,
      layer: 'diff-workspace',
      size: 'workspace',
      label: 'Диф задачи',
      bodyInset: false,
      'onUpdate:open': (value) => {
        updates.push(value);

        return wrapper.setProps({ open: value });
      },
      onClose: (reason) => {
        closes.push(reason);
      },
    },
    slots: {
      default: () => h('button', { type: 'button' }, 'Действие'),
    },
  });

  t.after(() => wrapper.unmount());
  await nextTick();
  await flushPromises();

  const overlay = browser.document.querySelector('.ui-dialog-overlay');
  const surface = browser.document.querySelector('.ui-dialog');

  assert.ok(overlay);
  assert.ok(surface);
  assert.equal(overlay.dataset.uiLayer, 'diff-workspace');
  assert.equal(surface.dataset.bodyInset, 'false');
  assert.equal(surface.getAttribute('aria-label'), 'Диф задачи');
  assert.equal(browser.document.body.classList.contains('ui-modal-scroll-lock'), true);
  assert.equal(hasOpenModal(), true);

  await wrapper.setProps({ mobileSheet: true });
  assert.equal(overlay.hasAttribute('data-mobile-sheet'), true);
  assert.equal(overlay.hasAttribute('data-mobile-fullscreen'), false);

  const escape = new browser.KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
  });

  browser.document.body.dispatchEvent(escape);
  await nextTick();
  await flushPromises();

  assert.equal(escape.defaultPrevented, true);
  assert.deepEqual(updates, [false]);
  assert.deepEqual(closes, ['escape']);
  assert.equal(browser.document.body.classList.contains('ui-modal-scroll-lock'), false);
  assert.equal(hasOpenModal(), false);

  await new Promise((resolve) => setTimeout(resolve, 50));
  await nextTick();

  assert.equal(Boolean(browser.document.querySelector('.ui-dialog-overlay')), false);
  await checkPromptFields(browser, t);
});

/**
 * Настоящий host разделяет DOM с проверкой UiDialog, как в приложении.
 * Подменяем только очередь запросов, чтобы наблюдать результат ввода и отмены.
 */
async function checkPromptFields(browser, t) {
  const results = [];

  globalThis.__layoutDialogs = { controller: null, results };

  const Host = await compileVue(webFile('src/components/overlays/UiDialogHost.vue'), {
    stubs: {
      '../../services/dialogs': `
        export const registerDialogHost = (controller) => {
          globalThis.__layoutDialogs.controller = controller;
          return () => {};
        };
        export const completeDialogRequest = (id, value) => {
          globalThis.__layoutDialogs.results.push([id, value]);
          globalThis.__layoutDialogs.controller.hide(id);
          return true;
        };
      `,
    },
  });
  const { mount, flushPromises, DOMWrapper } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const wrapper = mount(Host, { attachTo: browser.document.querySelector('#mount') });

  t.after(() => {
    wrapper.unmount();
    delete globalThis.__layoutDialogs;
  });

  const controller = globalThis.__layoutDialogs.controller;

  controller.show({
    id: 1,
    kind: 'prompt',
    options: {
      title: 'Название',
      multiline: false,
      value: 'Первое',
    },
  });
  await flushPromises();

  const input = browser.document.querySelector('input');

  assert.ok(input);
  assert.equal(Boolean(browser.document.querySelector('textarea')), false);
  await new DOMWrapper(input).setValue('Новое название');
  await new DOMWrapper(input).trigger('keydown', { key: 'Enter', isComposing: true });
  assert.equal(results.length, 0, 'IME не подтверждает незавершённое слово');
  await new DOMWrapper(input).trigger('keydown', { key: 'Enter' });
  await flushPromises();
  assert.deepEqual(results, [[1, 'Новое название']]);

  controller.show({
    id: 2,
    kind: 'prompt',
    options: {
      title: 'Пояснение',
      value: 'Строка 1\nСтрока 2',
    },
  });
  await flushPromises();

  const textarea = browser.document.querySelector('textarea');

  assert.ok(textarea);
  assert.equal(textarea.value, 'Строка 1\nСтрока 2');
  await new DOMWrapper(textarea).trigger('keydown', { key: 'Enter', shiftKey: true });
  assert.equal(results.length, 1, 'Shift+Enter оставляет многострочный ввод открытым');

  const cancel = [...browser.document.querySelectorAll('button')]
    .find((button) => button.textContent.trim() === 'Отмена');

  assert.ok(cancel);
  await new DOMWrapper(cancel).trigger('click');
  await flushPromises();
  assert.deepEqual(results.at(-1), [2, null]);

  for (const id of [3, 4]) {
    controller.show({
      id,
      kind: 'confirm',
      text: 'Будет удалена программа. Авторизация, настройки и история сохранятся.',
      options: {
        title: 'Удалить программу',
        details: {
          label: 'Подробности',
          text: '/fixture/long/path\nbackup-fixture\nfixture uninstall',
        },
      },
    });
    await flushPromises();

    const disclosure = browser.document.querySelector('button[aria-expanded]');

    assert.ok(disclosure);
    assert.equal(disclosure.getAttribute('aria-expanded'), 'false');
    assert.equal(browser.document.querySelector('.ui-dialog-host__code') === null, true);
    await new DOMWrapper(disclosure).trigger('keydown', { key: 'Enter' });
    assert.equal(results.length, 2, 'Enter на раскрытии не подтверждает удаление');
    await new DOMWrapper(disclosure).trigger('click');
    await flushPromises();
    assert.equal(disclosure.getAttribute('aria-expanded'), 'true');
    assert.match(browser.document.querySelector('.ui-dialog-host__code').textContent, /fixture uninstall/u);

    if (id === 3) {
      controller.hide(id);
    } else {
      await new DOMWrapper(disclosure).trigger('click');
      await flushPromises();
      assert.equal(disclosure.getAttribute('aria-expanded'), 'false');
      assert.equal(results.length, 2, 'Раскрытие не запускает операцию');
      controller.hide(id);
    }
  }
}
