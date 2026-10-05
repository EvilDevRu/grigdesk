process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';

import { vTooltip } from '../../web/src/services/tooltipDirective.ts';
import { currentTooltip, resetTooltips } from '../../web/src/services/tooltips.ts';
import { createUiBrowser } from './helpers/ui-components.js';

let browser;
let h;
let ref;
let withDirectives;
let nextTick;
let mount;

before(async () => {
  browser = await createUiBrowser();
  ({
    h,
    ref,
    withDirectives,
    nextTick,
  } = await import('../../web/node_modules/vue/index.mjs'));
  ({ mount } = await import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'));
});

after(async () => {
  await browser.close();
});

beforeEach((t) => {
  resetTooltips();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
});

afterEach(resetTooltips);

/**
 * Рендер применяет настоящую директиву к присоединённой кнопке.
 * Реактивное значение позволяет проверить updated без подмены lifecycle Vue.
 */
function setup(t, initial, attrs = {}, modifiers = {}) {
  const text = ref(initial);
  const wrapper = mount({
    render: () => withDirectives(h('button', { type: 'button', ...attrs }, 'x'),
      [[vTooltip, text.value, '', modifiers]]),
  }, { attachTo: browser.document.querySelector('#mount') });

  t.after(() => wrapper.unmount());

  return {
    wrapper,
    text,
    el: wrapper.element,
  };
}

function pointer(el, type, pointerType = 'mouse') {
  el.dispatchEvent(new browser.PointerEvent(type, { pointerType, bubbles: true }));
}

test('TIP-DIR-01: нормализация текста и атрибуты', (t) => {
  for (const [value, expected] of [
    ['  Справка  ', 'Справка'], ['', null], ['  ', null], [null, null],
    [undefined, null], [false, null], [0, '0'], [42, '42'],
  ]) {
    const { el } = setup(t, value);

    assert.equal(el.getAttribute('data-ui-tooltip'), expected);
    assert.equal(el.getAttribute('aria-description'), expected);
  }
});

test('TIP-DIR-02: имя не дублируется, чужое описание сохраняется', (t) => {
  const same = setup(t, 'Имя', { 'aria-label': 'Имя' });
  const custom = setup(t, 'Справка', { 'aria-description': 'Описание поля' });

  assert.equal(same.el.getAttribute('aria-description'), null);
  assert.equal(custom.el.getAttribute('aria-description'), 'Описание поля');
  custom.wrapper.unmount();
  assert.equal(custom.el.getAttribute('aria-description'), 'Описание поля');
});

test('TIP-DIR-03: мышь открывает, касание нет', (t) => {
  const { el } = setup(t, 'Справка');

  pointer(el, 'pointerenter', 'touch');
  t.mock.timers.tick(300);
  assert.equal(Boolean(currentTooltip()), false);
  pointer(el, 'pointerenter');
  t.mock.timers.tick(300);
  assert.equal(currentTooltip()?.text, 'Справка');
});

test('TIP-DIR-04: нажатие подавляет фокус до ухода курсора', (t) => {
  const { el } = setup(t, 'Справка');

  pointer(el, 'pointerenter');
  t.mock.timers.tick(300);
  pointer(el, 'pointerdown');
  assert.equal(Boolean(currentTooltip()), false);
  el.focus();
  t.mock.timers.tick(300);
  assert.equal(Boolean(currentTooltip()), false);
  pointer(el, 'pointerleave');
  pointer(el, 'pointerenter');
  t.mock.timers.tick(300);
  assert.equal(currentTooltip()?.text, 'Справка');
});

test('TIP-DIR-05: фокус внутренней цели не активирует внешнюю', (t) => {
  const { el } = setup(t, 'Справка');

  el.focus();
  t.mock.timers.tick(300);
  assert.equal(currentTooltip()?.text, 'Справка');
  el.blur();
  t.mock.timers.tick(80);
  assert.equal(Boolean(currentTooltip()), false);
  resetTooltips();

  const wrapper = mount({
    render: () => withDirectives(h('div', [
      withDirectives(h('button', 'Внутренняя'), [[vTooltip, 'Внутренняя']]),
    ]), [[vTooltip, 'Внешняя']]),
  }, { attachTo: browser.document.querySelector('#mount') });

  t.after(() => wrapper.unmount());
  wrapper.get('button').element.focus();
  t.mock.timers.tick(300);
  assert.equal(currentTooltip()?.text, 'Внутренняя');
  wrapper.get('button').element.blur();
  t.mock.timers.tick(80);
  assert.equal(Boolean(currentTooltip()), false);
});

test('TIP-DIR-06: updated меняет справку и атрибуты', async (t) => {
  const { el, text } = setup(t, 'Старая');

  pointer(el, 'pointerenter');
  t.mock.timers.tick(300);
  text.value = 'Новая';
  await nextTick();
  assert.equal(currentTooltip()?.text, 'Новая');
  assert.equal(el.getAttribute('data-ui-tooltip'), 'Новая');
  assert.equal(el.getAttribute('aria-description'), 'Новая');
  text.value = '';
  await nextTick();
  assert.equal(Boolean(currentTooltip()), false);
  assert.equal(el.hasAttribute('data-ui-tooltip'), false);
  assert.equal(el.hasAttribute('aria-description'), false);
});

test('TIP-DIR-07: unmount забывает цель и снимает своё, right задаёт сторону', (t) => {
  const { el, wrapper } = setup(t, 'Справка', {}, { right: true });

  pointer(el, 'pointerenter');
  t.mock.timers.tick(300);
  assert.equal(currentTooltip()?.placement, 'right');
  el.setAttribute('aria-description', 'Внешнее обновление');
  wrapper.unmount();
  assert.equal(Boolean(currentTooltip()), false);
  assert.equal(el.getAttribute('data-ui-tooltip'), null);
  assert.equal(el.getAttribute('aria-description'), 'Внешнее обновление');
  pointer(el, 'pointerenter');
  t.mock.timers.tick(300);
  assert.equal(Boolean(currentTooltip()), false);
});
