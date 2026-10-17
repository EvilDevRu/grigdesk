import assert from 'node:assert/strict';
import test from 'node:test';

import { accessUnavailableHtml, accessUnavailableUrl } from '../../desktop/src/accessUnavailable.ts';

const origin = 'http://127.0.0.1:28140';

test('DW-U1: страница отказа объясняет повтор без скриптов и внешних ресурсов', () => {
  const html = accessUnavailableHtml(origin);

  assert.match(html, /Не удалось войти по локальному ключу\. Окно повторяет попытку само\./u);
  assert.match(html,
    /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">/u);
  assert.doesNotMatch(html, /<script/iu);
  assert.doesNotMatch(html, /<[^>]+(?:src|href)=/iu);
  assert.match(html, /<html lang="ru">/u);
});

test('DW-U2: адрес страницы экранируется, а сам документ закодирован', () => {
  const hostile = 'http://127.0.0.1:28140/"><img src=x onerror=alert(1)>';
  const html = accessUnavailableHtml(hostile);

  assert.equal(html.includes('<img'), false);
  assert.equal(html.includes('&lt;img'), true);
  assert.equal(html.includes('onerror=alert(1)&gt;'), true);

  const url = accessUnavailableUrl(origin);

  assert.match(url, /^data:text\/html;charset=utf-8;base64,/u);
  assert.equal(Buffer.from(url.split(',')[1], 'base64').toString('utf8'), accessUnavailableHtml(origin));
});

test('DW-U3: пустой адрес не ломает страницу', () => {
  const html = accessUnavailableHtml('');

  assert.match(html, /Не удалось войти по локальному ключу/u);
  assert.doesNotMatch(html, /<[^>]+(?:src|href)=/iu);
});
