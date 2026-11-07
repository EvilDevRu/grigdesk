process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { compileVue } from './helpers/compile-vue.js';
import { createUiBrowser } from './helpers/ui-components.js';

let browser;
let component;
let mount;
let nextTick;

before(async () => {
  browser = await createUiBrowser();
  component = await compileVue(
    fileURLToPath(new URL('./fixtures/ui/TooltipHostFixture.vue', import.meta.url)),
  );
  ({ mount } = await import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'));
  ({ nextTick } = await import('../../web/node_modules/vue/index.mjs'));
  Object.defineProperty(browser.HTMLElement.prototype, 'offsetWidth', { get: () => 80 });
  Object.defineProperty(browser.HTMLElement.prototype, 'offsetHeight', { get: () => 30 });
});

after(async () => {
  await browser.close();
});

beforeEach((t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
});

function setup(t, props = {}) {
  const wrapper = mount(component, {
    props: { text: 'Справка', ...props },
    attachTo: browser.document.querySelector('#mount'),
  });

  t.after(() => wrapper.unmount());

  return wrapper;
}

/**
 * Подставляем геометрию до наведения, поскольку happy-dom не измеряет раскладку.
 * Два nextTick дожидаются появления поверхности и записи вычисленной позиции.
 */
async function show(t, wrapper, selector = '[data-test="target"]') {
  const target = browser.document.querySelector(selector);

  target.getBoundingClientRect = () => ({
    left: 100,
    top: 100,
    right: 140,
    bottom: 120,
    width: 40,
    height: 20,
  });
  target.dispatchEvent(new browser.PointerEvent('pointerenter', { pointerType: 'mouse' }));
  t.mock.timers.tick(300);
  await nextTick();
  await nextTick();
}

function surface() {
  return browser.document.querySelector('#ui-tooltip-host');
}

test('TIP-HOST-01: единая поверхность и рассчитанные координаты', async (t) => {
  const wrapper = setup(t);

  await show(t, wrapper);
  assert.equal(browser.document.querySelectorAll('#ui-tooltip-host.ui-tooltip.ui-tooltip--plain').length, 1);
  assert.equal(surface()?.getAttribute('role'), 'tooltip');
  assert.equal(surface()?.textContent, 'Справка');
  assert.equal(surface()?.getAttribute('data-ui-layer'), 'tooltip');
  assert.match(surface()?.getAttribute('style') ?? '', /--ui-layer-z/);
  assert.match(surface()?.getAttribute('style') ?? '', /left: 80px/);
  assert.match(surface()?.getAttribute('style') ?? '', /top: 61px/);
});

test('TIP-HOST-02: обновление сохраняет перевод строки', async (t) => {
  const wrapper = setup(t);

  await show(t, wrapper);
  await wrapper.setProps({ text: 'Первая\nВторая' });
  assert.equal(surface()?.textContent, 'Первая\nВторая');
});

test('TIP-HOST-03: диалог остаётся верхним, два Escape закрывают по одному', async (t) => {
  const wrapper = setup(t, { dialogOpen: true });

  await nextTick();
  await show(t, wrapper, '[data-test="in-dialog"]');
  assert.equal(surface()?.textContent, 'В диалоге');
  assert.equal(browser.document.querySelector('[data-test="top"]').textContent, 'true');
  browser.document.body.dispatchEvent(new browser.KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
  }));
  await nextTick();
  assert.equal(Boolean(surface()), false);
  assert.equal(Boolean(browser.document.querySelector('.ui-dialog')), true);
  browser.document.body.dispatchEvent(new browser.KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
  }));
  await nextTick();
  assert.equal(Boolean(browser.document.querySelector('.ui-dialog')), false);
});

test('TIP-HOST-04: отсоединённая цель и blur закрывают поверхность', async (t) => {
  const wrapper = setup(t);

  await show(t, wrapper);
  wrapper.get('[data-test="target"]').element.remove();
  browser.dispatchEvent(new browser.Event('scroll'));
  await nextTick();
  assert.equal(Boolean(surface()), false);
  wrapper.unmount();

  const second = setup(t);

  await show(t, second);
  browser.dispatchEvent(new browser.Event('blur'));
  await nextTick();
  assert.equal(Boolean(surface()), false);
});

test('TIP-HOST-05: повторный монтаж не воскрешает ожидание, новый показ холодный', async (t) => {
  const wrapper = setup(t);
  const target = wrapper.get('[data-test="target"]');

  target.element.getBoundingClientRect = () => ({
    left: 100,
    top: 100,
    right: 140,
    bottom: 120,
    width: 40,
    height: 20,
  });
  await target.trigger('pointerenter', { pointerType: 'mouse' });
  t.mock.timers.tick(100);
  await wrapper.setProps({ hostEnabled: false });
  t.mock.timers.tick(400);
  await wrapper.setProps({ hostEnabled: true });
  await nextTick();
  assert.equal(Boolean(surface()), false);
  await target.trigger('pointerleave');
  await target.trigger('pointerenter', { pointerType: 'mouse' });
  t.mock.timers.tick(299);
  await nextTick();
  assert.equal(Boolean(surface()), false);
  t.mock.timers.tick(1);
  await nextTick();
  await nextTick();
  assert.equal(surface()?.textContent, 'Справка');
});
