import assert from 'node:assert/strict';
import test from 'node:test';

import { mdToHtml, mdToText } from '../../web/src/shared/md.ts';

test('GFM рендерит ссылки, списки, таблицы и inline code', () => {
  const html = mdToHtml([
    '**Важно**: [`ChatSession.vue`](/home/user/Workspace/project/web/src/views/chat/ChatSession.vue:60)',
    '',
    '1. первый',
    '2. второй',
    '',
    '| Модель | Статус |',
    '| --- | --- |',
    '| GPT | работает |',
  ].join('\n'));

  assert.match(html, /<strong>Важно<\/strong>/);
  assert.match(html, /<a href="\/home\/user\/Workspace\/project\/web\/src\/views\/chat\/ChatSession\.vue:60"/);
  assert.match(html, /<code>ChatSession\.vue<\/code>/);
  assert.match(html, /<ol>/);
  assert.match(html, /<table>/);
});

test('raw HTML и опасные URL не попадают в v-html', () => {
  const html = mdToHtml([
    '<img src=x onerror="alert(1)">',
    '[опасная ссылка](javascript:alert(1))',
    '![опасная картинка](data:text/html,boom)',
  ].join('\n\n'));

  assert.doesNotMatch(html, /<img\b/i);
  assert.doesNotMatch(html, /<a\b/i);
  assert.doesNotMatch(html, /javascript:/i);
  assert.doesNotMatch(html, /data:text\/html/i);
  assert.match(html, /&lt;img/);
});

test('обычная внешняя ссылка защищена от доступа к opener', () => {
  const html = mdToHtml('[OpenAI](https://openai.com)');
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test('viewer документов показывает разрешённый HTML и удаляет исполняемые атрибуты', async () => {
  const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
  const browser = new Window({ url: 'http://cockpit.test/' });
  const html = mdToHtml([
    '<p align="center"><strong>Заголовок</strong><br><script>alert(1)</script></p>',
    '<img src="assets/logo.png" width="88" onerror="alert(2)">',
  ].join('\n'), {
    allowHtml: true,
    sanitizerDocument: browser.document,
    resolveImageHref: (href) => `/api/documents/asset?path=${encodeURIComponent(href)}`,
  });

  assert.match(html, /<p align="center"><strong>Заголовок<\/strong><br>/);
  assert.match(html, /src="\/api\/documents\/asset\?path=assets%2Flogo\.png"/);
  assert.match(html, /width="88"/);
  assert.doesNotMatch(html, /<script\b|onerror=/i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('превью превращает Markdown в чистый однострочный текст', () => {
  const text = mdToText([
    '**Технический план**: [`ChatSession.vue`](/home/user/ChatSession.vue:60)',
    '',
    '- первый пункт',
    '- второй `пункт`',
    '',
    '![схема](https://example.com/diagram.png)',
  ].join('\n'));

  assert.equal(
    text,
    'Технический план: ChatSession.vue первый пункт второй пункт схема',
  );
});

test('превью сохраняет текст блоков кода и схлопывает переносы', () => {
  const text = mdToText('Ответ:\n\n```js\nconst value = 1;\n```');
  assert.equal(text, 'Ответ: const value = 1;');
});
