import assert from 'node:assert/strict';
import test from 'node:test';

import { mountMarkdown } from './helpers/rich-markdown.js';

const FILE = 'src/shared/markdown/RichMarkdown.vue';
const STUBS = {
  '../md.ts': [
    "export * from './src/shared/md.ts';",
    "import { mdTokensToHtml as render, lexMarkdown as lex } from './src/shared/md.ts';",
    'export const mdTokensToHtml = (...args) => {',
    '  globalThis.__mdRenders = (globalThis.__mdRenders || 0) + 1;',
    '  return render(...args);',
    '};',
    'export const lexMarkdown = (...args) => {',
    '  globalThis.__mdLexes = (globalThis.__mdLexes || 0) + 1;',
    '  return lex(...args);',
    '};',
  ].join('\n'),
};

/**
 * Счётчики измеряют реальные lexer/parser, включая карту ссылок-сносок.
 * Между тестами они сбрасываются вместе с глобальными портами компонентов.
 */
function resetCounts(t) {
  globalThis.__mdRenders = 0;
  globalThis.__mdLexes = 0;
  t.after(() => {
    delete globalThis.__mdRenders;
    delete globalThis.__mdLexes;
  });
}

test('RMD-RICH-01: куски по порядку, Markdown санитизирован', async (t) => {
  const text = 'Абзац\n\n<script>alert(1)</script>\n\n```ts\nx\n```\n\n' +
    '```mermaid\nflowchart TD\n A-->B\n```\n\nХвост';
  const { wrapper, flushPromises } = await mountMarkdown(t, FILE, { text });

  await flushPromises();
  assert.deepEqual([...wrapper.element.children].map((element) => element.classList[0]),
    ['md-html', 'md-fence', 'md-diagram', 'md-html']);
  assert.equal(wrapper.find('script').exists(), false);
  assert.match(wrapper.get('.md-html').html(), /&lt;script&gt;/);
});

test('RMD-RICH-02: дописывание не пересоздаёт готовый блок', async (t) => {
  const text = 'А\n\n```ts\nx\n```';
  const { wrapper, calls, flushPromises } = await mountMarkdown(t, FILE, { text });

  await flushPromises();
  wrapper.get('.md-fence').element.setAttribute('data-probe', 'kept');
  await wrapper.setProps({ text: text + '\n\nБ' });
  await flushPromises();
  assert.equal(wrapper.find('[data-probe="kept"]').exists(), true);
  assert.equal(calls.highlight.length, 1);
});

test('RMD-RICH-03: схема рисуется после закрытия блока', async (t) => {
  const partial = '```mermaid\nflowchart TD\n A-->';
  const { wrapper, calls, flushPromises } = await mountMarkdown(t, FILE, { text: partial });

  assert.equal(calls.mermaid.length, 0);
  await wrapper.setProps({ text: partial + 'B\n```' });
  await flushPromises();
  assert.equal(calls.mermaid.length, 1);
  assert.equal(wrapper.find('img').exists(), true);
});

test('RMD-RICH-04: реактивные ссылки не лексируют неизменённый текст', async (t) => {
  resetCounts(t);

  const { ref } = await import('../../web/node_modules/vue/index.mjs');
  const target = ref('#/code?path=first');
  const { wrapper, flushPromises } = await mountMarkdown(t, FILE, {
    text: '[Файл](/repo/file.ts)',
    resolveHref: () => target.value,
  }, { stubs: STUBS });

  assert.equal(globalThis.__mdRenders, 1);
  assert.equal(globalThis.__mdLexes, 1);
  await wrapper.setProps({ title: 'x' });
  assert.equal(globalThis.__mdRenders, 1);
  assert.equal(globalThis.__mdLexes, 1);
  target.value = '#/code?path=second';
  await flushPromises();
  assert.equal(wrapper.get('a').attributes('href'), '#/code?path=second');
  assert.equal(globalThis.__mdRenders, 2);
  assert.equal(globalThis.__mdLexes, 1);
});

test('RMD-RICH-05: резолвер картинок применяется, отказ оставляет подпись', async (t) => {
  const { wrapper } = await mountMarkdown(t, FILE, {
    text: '![кадр](/w/a.png)',
    resolveImageHref: (href) => '/api/x?p=' + encodeURIComponent(href),
  });

  assert.equal(wrapper.get('img').attributes('src'), '/api/x?p=%2Fw%2Fa.png');
  await wrapper.setProps({ resolveImageHref: () => '' });
  assert.equal(wrapper.find('img').exists(), false);
  assert.equal(wrapper.text(), 'кадр');
});

test('RMD-RICH-06: image error оставляет безопасный alt, поздняя ошибка не трогает новый узел', async (t) => {
  const { wrapper, browser } = await mountMarkdown(t, FILE, { text: '![кадр](/w/a.png)' });

  await wrapper.get('img').trigger('error');
  assert.equal(wrapper.find('img').exists(), false);
  assert.equal(wrapper.text(), 'кадр');
  await wrapper.setProps({ text: '![](/w/empty.png)' });
  await wrapper.get('img').trigger('error');
  assert.equal(wrapper.text(), 'Изображение недоступно');
  await wrapper.setProps({ text: '![<script>alert(1)</script>](/w/old.png)' });

  const oldImage = wrapper.get('img').element;

  oldImage.setAttribute('alt', '<script>alert(1)</script>');

  await wrapper.get('img').trigger('error');
  assert.equal(wrapper.find('script').exists(), false);
  assert.equal(wrapper.text(), '<script>alert(1)</script>');
  await wrapper.setProps({ text: '![новый кадр](/w/new.png)' });
  oldImage.dispatchEvent(new browser.Event('error', { bubbles: true }));
  assert.equal(wrapper.get('img').attributes('src'), '/w/new.png');
  assert.doesNotMatch(wrapper.html(), /onerror=/);
});

test('RMD-RICH-07: дописывание сохраняет раскрытие/вид схемы, сноска обновляет ссылку', async (t) => {
  const code = Array(30).fill('x').join('\n');
  const text = `[план][p]\n\n\`\`\`ts\n${code}\n\`\`\`\n\n` +
    '```mermaid\nflowchart TD\n A-->B\n```';
  const { wrapper, calls, flushPromises } = await mountMarkdown(t, FILE, { text });

  await flushPromises();
  await wrapper.get('[data-context="md-fence-expand"]').trigger('click');
  await wrapper.get('[data-context="md-diagram-code"]').trigger('click');

  const highlightsBeforeTail = calls.highlight.length;

  await wrapper.setProps({ text: text + '\n\nХвост\n\n[p]: https://example.com/plan' });
  await flushPromises();
  assert.equal(wrapper.find('.md-fence--collapsed').exists(), false);
  assert.equal(wrapper.find('img.md-diagram__image').exists(), false);
  assert.equal(wrapper.find('[data-context="md-diagram-show"]').exists(), true);
  assert.equal(wrapper.get('a').attributes('href'), 'https://example.com/plan');
  assert.equal(calls.highlight.length, highlightsBeforeTail);
  assert.equal(calls.mermaid.length, 1);
});
