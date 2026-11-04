import assert from 'node:assert/strict';
import test from 'node:test';
import { mountMarkdown } from './helpers/rich-markdown.js';

const article = {
  id: 'overview',
  file: 'README.md',
  title: 'Начало',
  section: 'Основы',

  keywords: ['папка'],
  routes: [],
  markdown: '# Начало\n[Чаты](chats.md)\n<script>unsafe()</script>'
};
const chats = {
  ...article,
  id: 'chats',
  file: 'chats.md',
  title: 'Рабочая папка',
  markdown: '# Рабочая папка\nВыберите папку.'
};
const bundle = {
  format: 1,
  version: '0.1.0',
  commit: 'a'.repeat(40),
  revision: 'b'.repeat(64),

  locale: 'ru',
  articles: [article, chats]
};

test('HELP-C1: реальные поиск, дерево, безопасный Markdown и навигация', async (t) => {
  const h = await mountMarkdown(t, 'src/features/help/HelpBrowser.vue', {
    bundle,
    status: 'ready',
    articleId: 'overview'
  });

  assert.match(h.wrapper.text(), /Начало/u);
  assert.equal(h.wrapper.find('script').exists(), false);

  const link = h.wrapper.find('article a[href="#/help/chats"]');

  assert.equal(link.exists(), true);
  await link.trigger('click');
  assert.deepEqual(h.wrapper.emitted('navigate')[0], ['chats', '']);
  await h.wrapper.get('input[type="search"]').setValue('рабочая папка');
  assert.equal(h.wrapper.findAll('.help-index-item').length, 1);
  await h.wrapper.get('input[type="search"]').setValue('неттакойтемы');
  assert.match(h.wrapper.get('nav').text(), /ничего не найдено/iu);
  await h.wrapper.setProps({
    status: 'error',
    error: 'helpUnavailable',
    bundle: null
  });
  assert.equal(h.wrapper.find('article').exists(), false);
  await h.wrapper.get('button').trigger('click');
  assert.equal(h.wrapper.emitted('retry').length, 1);
});
test('HELP-C2: неизвестная статья не подставляет чужое содержимое', async (t) => {
  const h = await mountMarkdown(t, 'src/features/help/HelpBrowser.vue', {
    bundle,
    status: 'ready',
    articleId: 'missing'
  });

  assert.match(h.wrapper.text(), /Статья не найдена/u);
  assert.equal(h.wrapper.find('.rich-md').exists(), false);

  const back = h.wrapper.get('article button');

  assert.equal(back.text(), 'Оглавление');
  await back.trigger('click');
  assert.deepEqual(h.wrapper.emitted('navigate')[0], ['overview', '']);
});


test('HELP-C3: переход к статье возвращает её начало, фрагмент выбирает свой заголовок', async (t) => {
  const h = await mountMarkdown(t, 'src/features/help/HelpBrowser.vue', {
    bundle,
    status: 'ready',
    articleId: 'overview',
  });

  await h.flushPromises();

  const prototype = h.browser.HTMLElement.prototype;
  const original = prototype.scrollIntoView;
  const headings = [];

  prototype.scrollIntoView = function () {
    headings.push(this.id);
  };
  t.after(() => {
    prototype.scrollIntoView = original;
  });
  await h.wrapper.setProps({ articleId: 'chats' });
  await h.flushPromises();
  assert.equal(headings.at(-1), 'рабочая-папка');
  await h.wrapper.setProps({ articleId: 'overview', fragment: 'начало' });
  await h.flushPromises();
  assert.equal(headings.at(-1), 'начало');
});

test('HELP-C4: reader связывает оглавления, сворачивает каталог и сохраняет поиск', async (t) => {
  const h = await mountMarkdown(t, 'src/features/help/HelpBrowser.vue', {
    bundle: {
      ...bundle,
      articles: [{
        ...article,
        markdown: '# Начало\n## Проверка\nШаг один.\n## Проверка\nШаг два.',
      }, chats],
    },
    status: 'ready',
    articleId: 'overview',
    embedded: true,
  });

  await h.flushPromises();

  assert.equal(h.wrapper.find('.help-brand').exists(), false);
  assert.equal(h.wrapper.get('.help-index-item[aria-current="page"]').text(), 'Начало');
  assert.deepEqual(h.wrapper.findAll('.help-outline a').map((link) => link.attributes('href')), [
    '#/help/overview#проверка',
    '#/help/overview#проверка-1',
  ]);
  await h.wrapper.findAll('.help-outline a')[1].trigger('click');
  assert.deepEqual(h.wrapper.emitted('navigate')[0], ['overview', 'проверка-1']);

  const toggle = h.wrapper.get('button[aria-controls]');
  const controlledId = toggle.attributes('aria-controls');

  assert.equal(h.wrapper.get('.help-index-panel').attributes('id'), controlledId);
  await toggle.trigger('click');
  assert.equal(toggle.attributes('aria-expanded'), 'true');
  await h.wrapper.get('input[type="search"]').setValue('рабочая');
  await h.wrapper.get('.help-index-item').trigger('click', { ctrlKey: true });
  assert.equal(h.wrapper.emitted('navigate').length, 1);
  await h.wrapper.get('.help-index-item').trigger('click');
  assert.deepEqual(h.wrapper.emitted('navigate')[1], ['chats', '']);
  assert.equal(toggle.attributes('aria-expanded'), 'false');
  assert.equal(h.wrapper.get('input[type="search"]').element.value, 'рабочая');

  await h.wrapper.setProps({ status: 'loading' });
  await h.flushPromises();
  assert.equal(h.wrapper.find('.help-outline').exists(), false);
  await h.wrapper.setProps({ status: 'ready' });
  await h.flushPromises();
  assert.equal(h.wrapper.findAll('.help-outline a').length, 2);
});
