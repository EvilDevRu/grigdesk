process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { compileVue } from './helpers/compile-vue.js';
import { createUiBrowser } from './helpers/ui-components.js';

let browser;

before(async () => {
  browser = await createUiBrowser();
});

after(async () => {
  await browser.close();
});

test('TIP-LAYER-03: Tab замкнут при видимой справке, Escape закрывает по одному', async (t) => {
  const [component, { mount, flushPromises }] = await Promise.all([
    compileVue(fileURLToPath(new URL('./fixtures/ui/DialogTooltipFixture.vue', import.meta.url))),
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
  ]);
  const wrapper = mount(component, { attachTo: browser.document.querySelector('#mount') });

  t.after(() => wrapper.unmount());
  await flushPromises();

  const doc = browser.document;

  doc.querySelector('[data-first]').dispatchEvent(new browser.MouseEvent('mouseenter'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await flushPromises();
  assert.equal(Boolean(doc.querySelector('.ui-tooltip')), true);
  assert.equal(doc.querySelector('[data-top]').textContent, 'true');

  const last = doc.querySelector('[data-last]');

  last.focus();

  const tab = new browser.KeyboardEvent('keydown', {
    key: 'Tab',
    bubbles: true,
    cancelable: true,
  });

  last.dispatchEvent(tab);
  assert.equal(tab.defaultPrevented, true);
  assert.equal(doc.querySelector('.ui-dialog').contains(doc.activeElement), true);

  for (const surface of ['.ui-tooltip', '.ui-dialog']) {
    doc.body.dispatchEvent(new browser.KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    }));
    await flushPromises();
    assert.equal(Boolean(doc.querySelector(surface)), false);
  }
});
