import assert from 'node:assert/strict';
import test from 'node:test';

import { chatImageHref, chatWorkdirImageHref } from '../../web/src/views/chat/chatImages.ts';
import { mdToHtml } from '../../web/src/shared/md.ts';

test('CHAT-IMG-WEB-01: путь на диске уходит в маршрут разговора', () => {
  assert.equal(chatImageHref('/home/u/p/.state/artifacts/a.png', 'c1'),
    '/api/chat/c1/image?path=%2Fhome%2Fu%2Fp%2F.state%2Fartifacts%2Fa.png');
  assert.equal(chatImageHref('docs/a.webp', 'c1'), '/api/chat/c1/image?path=docs%2Fa.webp');
  assert.equal(chatImageHref('file:///home/u/a%20b.png', 'c1'),
    '/api/chat/c1/image?path=%2Fhome%2Fu%2Fa%20b.png');
});

test('CHAT-IMG-WEB-02: внешние и собственные адреса проходят', () => {
  for (const href of ['https://x/a.png', '/api/chat/attachment/a.png', '#a', '?a']) {
    assert.equal(chatImageHref(href, 'c1'), href);
  }
});

test('CHAT-IMG-WEB-03: не картинка или нет чата — пустая строка', () => {
  assert.equal(chatImageHref('/home/u/a.svg', 'c1'), '');
  assert.equal(chatImageHref('/home/u/a.md', 'c1'), '');
  assert.equal(chatImageHref('/home/u/a.png', ''), '');
});

test('CHAT-IMG-WEB-04: кодирование ровно один раз, file host/query/fragment и signed URL', () => {
  for (const source of ['/work/кадр с пробелом.png', '/work/%D0%BA%D0%B0%D0%B4%D1%80%20a.png']) {
    const result = chatImageHref(source, 'c1');

    assert.equal(new URL(result, 'https://test').searchParams.get('path'), '/work/кадр' +
      (source.includes('пробелом') ? ' с пробелом.png' : ' a.png'));
  }

  assert.equal(new URL(chatImageHref('a%2520b.png', 'c1'), 'https://test').searchParams.get('path'),
    'a%20b.png');
  assert.equal(chatImageHref('a%broken.png', 'c1'), '');

  for (const href of ['file://foreign-host/a.png', 'file:///a.png?x=1', 'file:///a.png#x']) {
    assert.equal(chatImageHref(href, 'c1'), '');
  }

  assert.equal(chatImageHref('file://localhost/a.png', 'c1'), '/api/chat/c1/image?path=%2Fa.png');

  const signed = 'https://x/a.png?signature=a%2Fb%2520&expires=123';

  assert.equal(chatImageHref(signed, 'c1'), signed);
});

test('CHAT-IMG-WEB-05: опасные scheme отбрасывает allowlist Markdown после resolver', () => {
  const urls = ['javascript:alert(1)', 'data:text/html,boom', 'vbscript:msgbox(1)', '//foreign/a.png'];

  for (const href of urls) {
    const html = mdToHtml(`![кадр](${href})`, { resolveImageHref: (url) => chatImageHref(url, 'c1') });

    assert.doesNotMatch(html, /<img/);
    assert.match(html, /кадр/);
  }
});

test('CHAT-IMG-WEB-06: путь инструмента даёт только маршрут рабочей папки', () => {
  assert.equal(chatWorkdirImageHref('/repo/.state/artifacts/a.png', 'c1'),
    '/api/chat/c1/image?path=%2Frepo%2F.state%2Fartifacts%2Fa.png');

  // Строка ленты не пропускает адрес как есть: внешний URL и готовый /api — не файлы папки.
  for (const file of ['https://x/a.png', '/api/chat/attachment/a.png', '/repo/logo.svg', '']) {
    assert.equal(chatWorkdirImageHref(file, 'c1'), '', file);
  }

  assert.equal(chatWorkdirImageHref('/repo/a.png', ''), '');
});
