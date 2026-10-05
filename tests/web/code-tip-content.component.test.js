process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { MARKDOWN_STUBS } from './helpers/rich-markdown.js';
import { createUiBrowser } from './helpers/ui-components.js';

let browser;
let component;
let mount;
let flushPromises;
let calls;

before(async () => {
  browser = await createUiBrowser();
  component = await compileVue(webFile('src/shared/markdown/CodeTipContent.vue'), {
    stubs: MARKDOWN_STUBS,
  });
  ({ mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  ));
});

after(async () => {
  delete globalThis.__mdHighlight;
  await browser.close();
});

/**
 * Каждый сценарий получает свой порт подсветки и прикреплённый компонент.
 * Размонтирование выполняется до следующего сценария в том же окне.
 */
function setup(t, props, highlight = async () => null) {
  calls = [];
  globalThis.__mdHighlight = (...args) => {
    calls.push(args);

    return highlight(...args);
  };

  const wrapper = mount(component, { props, attachTo: browser.document.querySelector('#mount') });

  t.after(() => wrapper.unmount());

  return wrapper;
}

test('TIP-CODE-01: простой текст без подсветки', (t) => {
  const wrapper = setup(t, { code: 'a\nb', lang: '' });

  assert.equal(wrapper.get('pre').text(), 'a\nb');
  assert.equal(wrapper.find('.code-tip__caption').exists(), false);
  assert.equal(wrapper.find('.code-tip__more').exists(), false);
  assert.equal(calls.length, 0);
});

test('TIP-CODE-02: отложенная подсветка получает видимый текст', async (t) => {
  let resolve;
  const wrapper = setup(t, { code: 'echo ok', lang: 'bash' }, () => new Promise((done) => {
    resolve = done;
  }));

  assert.equal(wrapper.get('pre').text(), 'echo ok');
  assert.deepEqual(calls, [['echo ok', 'bash']]);
  resolve([[{ content: 'echo ok', color: 'red' }]]);
  await flushPromises();
  assert.match(wrapper.get('.md-line span').attributes('style'), /red/);
});

test('TIP-CODE-03: ограничение строк и подпись', async (t) => {
  const wrapper = setup(t, {
    code: Array(30).fill('x').join('\n'),
    lang: 'bash',
    caption: 'Сборка',
  });

  await flushPromises();
  assert.equal(wrapper.findAll('.md-line').length, 24);
  assert.equal(calls[0][0], Array(24).fill('x').join('\n'));
  assert.equal(wrapper.get('.code-tip__caption').text(), 'Сборка');
  assert.equal(wrapper.get('.code-tip__more').text(),
    '… ещё 6 строк — раскрой шаг для сохранённого текста');
});

test('TIP-CODE-04: устаревшая подсветка и размонтирование', async (t) => {
  const pending = [];
  const wrapper = setup(t, { code: 'old', lang: 'bash' }, () => new Promise((resolve) => {
    pending.push(resolve);
  }));

  await wrapper.setProps({ code: 'new' });
  pending[0]([[{ content: 'obsolete', color: 'red' }]]);
  await flushPromises();
  assert.equal(wrapper.get('pre').text(), 'new');
  pending[1](null);
  await flushPromises();
  assert.equal(wrapper.get('pre').text(), 'new');
  await wrapper.setProps({ lang: 'js' });
  wrapper.unmount();
  pending[2]([[{ content: 'late', color: 'red' }]]);
  await flushPromises();
  assert.equal(Boolean(browser.document.querySelector('.code-tip')), false);
});

test('TIP-CODE-05: границы, завершающий перенос и склонение', async (t) => {
  const wrapper = setup(t, { code: Array(24).fill('x').join('\n'), lang: '' });

  assert.equal(wrapper.find('.code-tip__more').exists(), false);
  await wrapper.setProps({ code: Array(25).fill('x').join('\n') + '\n', maxLines: 0 });
  assert.equal(wrapper.findAll('.md-line').length, 24);
  assert.match(wrapper.get('.code-tip__more').text(), /1 строка —/);

  for (const [count, word] of [[2, 'строки'], [5, 'строк'], [11, 'строк'], [21, 'строка'], [22, 'строки']]) {
    await wrapper.setProps({ code: Array(24 + count).fill('x').join('\n') });
    assert.equal(wrapper.get('.code-tip__more').text(),
      `… ещё ${count} ${word} — раскрой шаг для сохранённого текста`);
  }
});
