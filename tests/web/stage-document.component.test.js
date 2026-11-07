import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { createUiBrowser } from './helpers/ui-components.js';

const FILE = 'src/views/pipeline/StageDocument.vue';

let browser;
let component;
let mount;
let flushPromises;

before(async () => {
  browser = await createUiBrowser();
  component = await compileVue(webFile(FILE));
  ({ mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  ));
});

after(() => browser?.close());

/**
 * Один document на файл нужен настоящему Teleport общего меню, который Vue запоминает при импорте.
 * Каждый сценарий монтирует отдельный читатель и освобождает его собственные слои после проверки.
 */
async function mountDocument(t, props) {
  const wrapper = mount(component, {
    attachTo: browser.document.querySelector('#mount'),
    props,
  });

  t.after(() => wrapper.unmount());
  await flushPromises();

  return {
    wrapper,
    browser,
    flushPromises,
  };
}

test('STAGE-DOC-01: оглавление различает повторы и не читает заголовки из примеров', async (t) => {
  const text = '# План\n\n## **Проверка**\n\nТекст.\n\n### Подробности\n\n'
    + '```md\n## Пример\n```\n\n> ## Цитата\n\n## Проверка\n\n<script>alert(1)</script>';
  const { wrapper, browser, flushPromises } = await mountDocument(t, { text });

  await flushPromises();

  await wrapper.get('.outline-trigger').trigger('click');
  await flushPromises();

  const entries = [...browser.document.querySelectorAll('.outline-entry')];
  const headings = wrapper.findAll('article > h2, article > h3');
  const ids = headings.map((heading) => heading.attributes('id'));

  assert.deepEqual(entries.map((entry) => entry.textContent.trim()), ['Проверка', 'Подробности', 'Проверка']);
  assert.equal(new Set(ids).size, 3);
  assert.equal(ids.every(Boolean), true);
  assert.equal(entries[1].classList.contains('is-nested'), true);
  assert.equal(wrapper.find('script').exists(), false);
});

test('STAGE-DOC-02: переход закрывает меню оглавления и переводит фокус к нужному разделу', async (t) => {
  const { wrapper, browser, flushPromises } = await mountDocument(t, {
    text: '## Начало\n\nПервый раздел.\n\n## Проверка\n\nПоследний раздел.',
  });

  await flushPromises();
  await wrapper.get('.outline-trigger').trigger('click');
  await flushPromises();

  const target = wrapper.findAll('article > h2')[1].element;
  let scrolled = false;

  target.scrollIntoView = () => {
    scrolled = true;
  };

  assert.equal(wrapper.get('.outline-trigger').attributes('aria-expanded'), 'true');
  browser.document.querySelectorAll('.document-outline button')[1].click();
  await flushPromises();

  assert.equal(scrolled, true);
  assert.equal(browser.document.activeElement === target, true);
  assert.equal(wrapper.get('.outline-trigger').attributes('aria-expanded'), 'false');
  assert.equal(browser.document.querySelector('.document-outline') === null, true);
  await wrapper.get('.outline-trigger').trigger('click');
  await flushPromises();

  const selected = browser.document.querySelector('.document-outline [aria-current="location"]');

  assert.equal(selected.textContent.includes('Проверка'), true);
});

test('STAGE-DOC-03: смена документа убирает прежнюю навигацию и сохраняет короткий текст', async (t) => {
  const { wrapper, flushPromises } = await mountDocument(t, {
    text: '## Первый\n\nТекст.\n\n## Второй\n\nЕщё текст.',
  });

  await flushPromises();
  assert.equal(wrapper.find('.outline-trigger').exists(), true);
  await wrapper.setProps({ text: 'Короткий документ без заголовков.' });
  await flushPromises();

  assert.equal(wrapper.find('.outline-trigger').exists(), false);
  assert.equal(wrapper.get('article').text(), 'Короткий документ без заголовков.');
  await wrapper.setProps({ text: '' });
  await flushPromises();

  assert.equal(wrapper.find('.outline-trigger').exists(), false);
  assert.equal(wrapper.get('article').text(), '');
});


test('STAGE-DOC-04: сворачивание документа сохраняет текст и контракт управляемого раскрытия', async (t) => {
  const { wrapper, flushPromises } = await mountDocument(t, {
    text: '## Начало\n\nТекст.\n\n## Проверка\n\nЕщё текст.',
    title: 'План реализации',
    open: false,
  });

  await flushPromises();
  assert.equal(wrapper.get('article').element.style.display, 'none');
  assert.equal(wrapper.find('.outline-trigger').exists(), false);
  await wrapper.get('.document-title').trigger('click');

  assert.deepEqual(wrapper.emitted('update:open'), [[true]]);
  await wrapper.setProps({ open: true });
  await flushPromises();

  assert.equal(wrapper.get('article').element.style.display, '');
  assert.equal(wrapper.get('article').text().includes('Ещё текст.'), true);
  assert.equal(wrapper.find('.outline-trigger').exists(), true);
});
