import assert from 'node:assert/strict';
import test from 'node:test';

import { lexMarkdown, mdTokensToHtml, mdToHtml, mdToText } from '../../web/src/shared/md.ts';

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
  const browser = new Window({ url: 'http://grigdesk.test/' });
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

test('RMD-MD-01: разбиение сохраняет прежний контракт HTML', async () => {
  const source = [
    'Абзац **жирный**.', '', '- пункт', '', '| A | B |', '| --- | --- |', '| 1 | 2 |', '',
    '[план][p]', '', '[p]: https://example.com/plan', '', '<img src=x onerror="alert(1)">',
  ].join('\n');
  const golden = [
    '<p>Абзац <strong>жирный</strong>.</p>', '<ul>', '<li>пункт</li>', '</ul>',
    '<table>', '<thead>', '<tr>', '<th>A</th>', '<th>B</th>', '</tr>', '</thead>',
    '<tbody><tr>', '<td>1</td>', '<td>2</td>', '</tr>', '</tbody></table>',
    '<p><a href="https://example.com/plan" target="_blank" rel="noopener noreferrer">план</a></p>',
    '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;',
  ].join('\n');
  const html = mdTokensToHtml(lexMarkdown(source));

  assert.equal(html, golden);

  const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
  const browser = new Window();

  try {
    browser.document.body.innerHTML = html;
    assert.equal(browser.document.querySelector('strong')?.textContent, 'жирный');
    assert.equal(browser.document.querySelectorAll('li').length, 1);
    assert.equal(browser.document.querySelectorAll('td').length, 2);
    assert.equal(browser.document.querySelector('a')?.getAttribute('href'), 'https://example.com/plan');
    assert.equal(Boolean(browser.document.querySelector('img')), false);
  } finally {
    await browser.close();
  }
});

test('RMD-MD-02: ссылка-сноска из конца ответа работает в первом куске', () => {
  const tokens = lexMarkdown('См. [план][p]\n\n```ts\nx\n```\n\n[p]: https://example.com/plan');

  assert.match(mdTokensToHtml(tokens.slice(0, 1)), /<a href="https:\/\/example.com\/plan"/);
});

test('RMD-MD-03: опасный raw HTML в куске по-прежнему экранирован', () => {
  const html = mdTokensToHtml(lexMarkdown('<img src=x onerror="alert(1)">').slice(0, 1));

  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test('RMD-ALERT-01: [!NOTE] отдельной строкой — плашка с заголовком', () => {
  const html = mdToHtml('> [!NOTE]\n> Полезно знать');

  assert.match(html, /<blockquote class="md-alert md-alert--note">/);
  assert.match(html, /<p class="md-alert__title">Заметка<\/p>/);
  assert.match(html, /<p>Полезно знать<\/p>/);
  assert.doesNotMatch(html, /\[!NOTE\]/);
});

test('RMD-ALERT-02: маркер в своём абзаце и тип в нижнем регистре', () => {
  const html = mdToHtml('> [!warning]\n>\n> Осторожно');

  assert.match(html, /class="md-alert md-alert--warning"/);
  assert.match(html, /<p class="md-alert__title">Внимание<\/p>/);
  assert.match(html, /<p>Осторожно<\/p>/);
  assert.doesNotMatch(html, /\[!warning\]/);
});

test('RMD-ALERT-03: маркер с текстом и обычная цитата не трогаются', () => {
  for (const source of ['> [!TIP] сразу текст', '> обычная цитата']) {
    const html = mdToHtml(source);

    assert.match(html, /<blockquote>\n<p>/);
    assert.doesNotMatch(html, /md-alert/);
  }
});

test('RMD-ALERT-04: неизвестный тип не плашка', () => {
  assert.doesNotMatch(mdToHtml('> [!DANGER]\n> x'), /md-alert/);
});

test('RMD-ALERT-05: viewer сохраняет классы плашки и снимает чужие', async (t) => {
  const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
  const browser = new Window();

  t.after(() => browser.close());

  const html = mdToHtml('> [!TIP]\n> x\n\n<p class="evil md-alert__title">y</p>', {
    allowHtml: true,
    sanitizerDocument: browser.document,
  });

  assert.match(html, /class="md-alert md-alert--tip"/);
  assert.match(html, /<p class="md-alert__title">y<\/p>/);
  assert.doesNotMatch(html, /evil/);
});

test('RMD-ALERT-06: исходный маркер, структура тела и ссылки-сноски сохраняются', () => {
  for (const source of ['> \\[!NOTE]\n> x', '> `[!NOTE]`\n> x']) {
    assert.doesNotMatch(mdToHtml(source), /md-alert/);
  }

  const html = mdToHtml('> [!IMPORTANT]  \n> **важно** [план][p]\n>\n> - пункт' +
    '\n\n[p]: https://example.com/plan');

  assert.match(html, /<p class="md-alert__title">Важно<\/p>/);
  assert.match(html, /<strong>важно<\/strong>/);
  assert.match(html, /href="https:\/\/example.com\/plan"/);
  assert.match(html, /<ul>\n<li>пункт<\/li>/);
  assert.doesNotMatch(html, /\[!IMPORTANT\]/);
  assert.match(mdToHtml('> [!CAUTION]\n> x'), /md-alert--caution.*\n.*Осторожно/);
});
