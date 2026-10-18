import assert from 'node:assert/strict';
import test from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

test('плитки топбара: стык, переключение, клавиатура и короткий экран', async (t) => {
  const browser = await installUiBrowser(t);
  const viewport = new browser.EventTarget();

  Object.assign(viewport, {
    width: 0,
    height: 0,
    offsetTop: 0,
    offsetLeft: 0,
  });
  Object.defineProperty(browser, 'visualViewport', { configurable: true, value: viewport });

  const [{ h, nextTick }, { mount }, UiTopbarPanel] = await Promise.all([
    import('../../web/node_modules/vue/index.mjs'),
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/components/overlays/UiTopbarPanel.vue')),
  ]);

  /**
   * Два настоящих компонента делят один реестр открытой плитки.
   * Содержимое с кнопкой позволяет проверить перенос и восстановление фокуса.
   */
  function panel(id) {
    return h(UiTopbarPanel, { title: id }, {
      trigger: () => h('button', { id }, id),
      default: ({ close }) => h('button', {
        class: 'panel-action',
        onClick: () => close('action'),
      }, 'Готово'),
    });
  }

  const wrapper = mount({
    render: () => h('header', { 'data-ui-topbar': '' }, [panel('one'), panel('two')]),
  }, {
    attachTo: browser.document.querySelector('#mount'),
    global: { stubs: { transition: true } },
  });

  t.after(() => wrapper.unmount());

  wrapper.element.getBoundingClientRect = () => ({
    top: 0,
    bottom: 36,
    height: 36,
    width: 1000,
  });

  for (const [index, id] of ['one', 'two'].entries()) {
    wrapper.get(`#${id}`).element.getBoundingClientRect = () => ({
      top: 6,
      bottom: 30,
      height: 24,
      left: 500 + index * 60,
      right: 550 + index * 60,
      width: 50,
    });
  }

  await wrapper.get('#one').trigger('mouseenter');
  await nextTick();

  let surface = browser.document.querySelector('.ui-topbar-panel');

  assert.equal(Boolean(surface), true);
  assert.equal(surface.style.top, '35px');
  assert.equal(surface.getAttribute('aria-label'), 'one');
  assert.equal(wrapper.get('#one').element.style.getPropertyValue('--ui-topbar-trigger-top'), '-6px');
  assert.equal(wrapper.get('#one').element.style.getPropertyValue('--ui-topbar-trigger-height'), '36px');

  Object.defineProperty(surface, 'offsetWidth', { configurable: true, value: 352 });
  Object.defineProperty(surface, 'offsetHeight', { configurable: true, value: 900 });
  browser.innerHeight = 180;
  browser.dispatchEvent(new browser.Event('resize'));
  await nextTick();

  assert.equal(surface.style.top, '35px', 'длинная плитка должна оставаться под топбаром');
  assert.equal(surface.style.left, '198px');
  assert.equal(surface.style.maxHeight, '137px');

  Object.assign(viewport, {
    width: 390,
    height: 100,
    offsetTop: 10,
    offsetLeft: 0,
  });
  viewport.dispatchEvent(new browser.Event('resize'));
  await nextTick();

  assert.equal(surface.style.maxHeight, '67px', 'клавиатура ограничивает плитку без resize окна');
  assert.equal(surface.style.left, '30px');

  viewport.offsetTop = 50;
  viewport.dispatchEvent(new browser.Event('scroll'));
  await nextTick();

  assert.equal(surface.style.top, '50px', 'плитка остаётся внутри сдвинутой видимой области');

  await wrapper.get('#one').trigger('mouseleave');
  await wrapper.get('#two').trigger('mouseenter');
  await nextTick();

  assert.equal(browser.document.querySelectorAll('.ui-topbar-panel').length, 1);
  assert.equal(wrapper.get('#one').attributes('aria-expanded'), 'false');
  assert.equal(wrapper.get('#two').attributes('aria-expanded'), 'true');

  browser.document.dispatchEvent(new browser.KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
  }));
  await nextTick();
  await nextTick();

  assert.equal(browser.document.querySelectorAll('.ui-topbar-panel').length, 0);
  assert.equal(browser.document.activeElement?.id, 'two');
  assert.equal(
    wrapper.get('#two').attributes('aria-expanded'),
    'false',
    'возврат фокуса не открывает плитку',
  );

  await wrapper.get('#one').trigger('keydown', { key: 'ArrowDown' });
  await nextTick();
  await nextTick();

  assert.equal(browser.document.activeElement?.className, 'panel-action');
  browser.document.activeElement.click();
  await nextTick();
  await nextTick();

  assert.equal(browser.document.querySelectorAll('.ui-topbar-panel').length, 0);
  assert.equal(browser.document.activeElement?.id, 'one');

  await wrapper.get('#one').trigger('click');
  surface = browser.document.querySelector('.ui-topbar-panel');
  surface.dispatchEvent(new browser.Event('pointerdown', { bubbles: true }));
  await nextTick();
  assert.equal(browser.document.querySelectorAll('.ui-topbar-panel').length, 1);

  browser.document.body.dispatchEvent(new browser.Event('pointerdown', { bubbles: true }));
  await nextTick();
  assert.equal(browser.document.querySelectorAll('.ui-topbar-panel').length, 0);
});
