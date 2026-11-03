import assert from 'node:assert/strict';
import test from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { createUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

let browser;

test.before(async () => {
  browser = await createUiBrowser();
});
test.after(() => browser?.close());

/**
 * Монтирует настоящий значок, подменяя только native-порт и условие desktop.
 * Перевод, SVG и жизненный цикл компонента остаются продуктовыми.
 */
async function mountIndicator(t, { mode = 'main', matches = true } = {}) {
  let updates;
  let started = 0;
  let stopped = 0;
  const media = new browser.EventTarget();
  const previous = browser.matchMedia;

  media.matches = matches;
  browser.matchMedia = () => media;
  browser.document.body.innerHTML = '<div id="mount"></div>';
  globalThis.__keyboardLayoutTest = {
    mode,
    observe(_window, publish) {
      started += 1;
      updates = publish;

      return () => {
        stopped += 1;
      };
    },
  };

  const component = await compileVue(webFile('src/views/chat/ChatKeyboardLayout.vue'), {
    stubs: {
      '../../shared/desktopSettings.ts':
        'export const currentDesktopMode = () => globalThis.__keyboardLayoutTest.mode;',
      '../../shared/keyboardLayout.ts':
        'export const observeKeyboardLayout = (...args) => globalThis.__keyboardLayoutTest.observe(...args);',
      '../../ui': [
        'export { t } from "./src/services/locale.ts";',
        'export { vTooltip } from "./src/services/tooltipDirective.ts";',
      ].join('\n'),
    },
  });
  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const wrapper = mount(component, { attachTo: browser.document.querySelector('#mount') });

  t.after(() => {
    wrapper.unmount();
    browser.matchMedia = previous;
    delete globalThis.__keyboardLayoutTest;
  });
  await flushPromises();

  return {
    wrapper,
    media,
    flushPromises,
    counts: () => ({ started, stopped }),
    update: (value) => updates(value),
  };
}

test('монохромная клавиша показывает раскладку и доступную подпись, ошибка даёт вопрос', async (t) => {
  const box = await mountIndicator(t);

  assert.equal(box.wrapper.text(), '?');
  box.update({ code: 'us', variant: '' });
  await box.flushPromises();
  assert.equal(box.wrapper.text(), 'EN');
  assert.equal(box.wrapper.attributes('aria-label'), 'Раскладка клавиатуры: EN');
  box.update({ code: 'ru', variant: '' });
  await box.flushPromises();
  assert.equal(box.wrapper.text(), 'RU');
  assert.equal(box.wrapper.get('rect').attributes('stroke'), 'currentColor');
  assert.equal(box.wrapper.get('text').attributes('fill'), 'currentColor');
  assert.equal(box.wrapper.find('button').exists(), false);
  box.update(null);
  await box.flushPromises();
  assert.equal(box.wrapper.text(), '?');
  assert.equal(box.wrapper.attributes('aria-label'), 'Раскладка клавиатуры недоступна');
});

test('узкий или сенсорный экран и обычная страница не показывают значок и не запускают опрос', async (t) => {
  for (const options of [{ matches: false }, { mode: 'page' }]) {
    await t.test(JSON.stringify(options), async (t) => {
      const box = await mountIndicator(t, options);

      assert.equal(box.wrapper.find('[data-role="chat-keyboard-layout"]').exists(), false);
      assert.deepEqual(box.counts(), { started: 0, stopped: 0 });
    });
  }
});

test('смена режима и размонтирование освобождают опрос', async (t) => {
  const box = await mountIndicator(t);

  assert.deepEqual(box.counts(), { started: 1, stopped: 0 });
  box.media.matches = false;
  box.media.dispatchEvent(new browser.Event('change'));
  await box.flushPromises();
  assert.equal(box.wrapper.find('[data-role="chat-keyboard-layout"]').exists(), false);
  assert.deepEqual(box.counts(), { started: 1, stopped: 1 });
  box.media.matches = true;
  box.media.dispatchEvent(new browser.Event('change'));
  await box.flushPromises();
  assert.equal(box.wrapper.text(), '?');
  assert.deepEqual(box.counts(), { started: 2, stopped: 1 });
  box.wrapper.unmount();
  assert.deepEqual(box.counts(), { started: 2, stopped: 2 });
});
