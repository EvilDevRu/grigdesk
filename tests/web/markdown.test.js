import assert from 'node:assert/strict';
import test from 'node:test';

import { mdToHtml } from '../../web/src/shared/md.js';

test('GFM рендерит ссылки, списки, таблицы и inline code', () => {
  const html = mdToHtml([
    '**Важно**: [`ChatSession.vue`](/home/evildev/Workspace/cockpit/web/src/views/chat/ChatSession.vue:60)',
    '',
    '1. первый',
    '2. второй',
    '',
    '| Модель | Статус |',
    '| --- | --- |',
    '| GPT | работает |',
  ].join('\n'));

  assert.match(html, /<strong>Важно<\/strong>/);
  assert.match(html, /<a href="\/home\/evildev\/Workspace\/cockpit\/web\/src\/views\/chat\/ChatSession\.vue:60"/);
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
