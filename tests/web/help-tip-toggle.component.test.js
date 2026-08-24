import assert from 'node:assert/strict';
import test from 'node:test';
import { compileVue, webFile } from './helpers/compile-vue.js';

process.env.NODE_ENV = 'test';

test('UiPopover закрепляет интерактивное содержимое и закрывается явным action', async () => {
  const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
  const browser = new Window({ url: 'http://cockpit.test/#/chats' });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    location: browser.location,
    localStorage: browser.localStorage,
    Node: browser.Node,
    Element: browser.Element,
    HTMLElement: browser.HTMLElement,
    SVGElement: browser.SVGElement,
    Event: browser.Event,
    CustomEvent: browser.CustomEvent,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    requestAnimationFrame: (callback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
  })) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  browser.document.body.innerHTML = '<div id="mount"></div><button id="outside">мимо</button>';

  const [{ h, nextTick }, { mount }, UiPopover] = await Promise.all([
    import('../../web/node_modules/vue/index.mjs'),
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/components/overlays/UiPopover.vue')),
  ]);
  const wrapper = mount(UiPopover, {
    attachTo: browser.document.querySelector('#mount'),
    props: {
      triggerMode: 'both',
      focusPolicy: 'none',
    },
    slots: {
      trigger: () => h('button', { class: 'prov' }, 'AI'),
      default: ({ close }) => h(
        'button',
        { class: 'go', onClick: () => close('action') },
        'Настройки',
      ),
    },
    global: { stubs: { transition: true } },
  });

  try {
    assert.equal(Boolean(browser.document.querySelector('.ui-popover')), false);
    await wrapper.find('.prov').trigger('click');
    const tip = browser.document.querySelector('.ui-popover');

    // DOM-объекты happy-dom нельзя отдавать assert-форматтеру при несовпадении:
    // разворачивание их дерева способно съесть весь heap. Сравниваем логическое значение.
    assert.equal(browser.document.body.contains(tip), true);
    assert.equal(tip?.getAttribute('role'), 'dialog');

    await wrapper.find('.prov').trigger('mouseleave');
    assert.ok(browser.document.querySelector('.ui-popover'), 'закреплённая панель погасла от mouseleave');

    tip.dispatchEvent(new browser.Event('pointerdown', { bubbles: true }));
    await nextTick();
    assert.ok(browser.document.querySelector('.ui-popover'), 'клик внутри ошибочно признан внешним');

    browser.document.querySelector('.go').dispatchEvent(new browser.Event('click', { bubbles: true }));
    await nextTick();
    assert.equal(
      Boolean(browser.document.querySelector('.ui-popover')),
      false,
      'action не закрыл popover',
    );

    await wrapper.find('.prov').trigger('click');
    browser.document.querySelector('#outside')
      .dispatchEvent(new browser.Event('pointerdown', { bubbles: true }));
    await nextTick();
    assert.equal(
      Boolean(browser.document.querySelector('.ui-popover')),
      false,
      'outside click не закрыл popover',
    );
  } finally {
    wrapper.unmount();
    browser.close();
  }
});
