import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import type { Window as HappyDomWindow } from '../../web/node_modules/happy-dom/lib/index.js';
import { installChatComposerFocusDebug } from '../../web/src/shared/chatComposerFocusDebug.ts';
import { createUiBrowser } from './helpers/ui-components.js';

interface FocusDebugWindow extends HappyDomWindow {
  __grigDeskLog?: { mark(text: string): unknown };
}

/**
 * Настоящие focus-события DOM отделены от сервера: журнал собирает только текст отметок.
 * Часы управляемы, чтобы проверить паузу и снятие подписок без ожидания минуты.
 */
async function fixture(t: TestContext) {
  const browser: FocusDebugWindow = await createUiBrowser();
  const element = browser.document.createElement('textarea');
  const target = browser.document.createElement('button');
  const marks: string[] = [];
  let time = 1000;

  element.value = 'Приватный текст сообщения';
  target.textContent = 'Секретная подпись';
  browser.document.body.append(element, target);
  browser.__grigDeskLog = { mark: (text: string) => marks.push(text) };

  const warn = console.warn;

  console.warn = () => {};

  const dispose = installChatComposerFocusDebug(element as unknown as HTMLTextAreaElement, () => time);

  t.after(() => {
    dispose();
    console.warn = warn;
    browser.close();
  });

  return {
    browser,
    element,
    target,
    marks,
    dispose,
    advance: (ms: number) => {
      time += ms;
    },
    type: () => {
      element.focus();
      element.dispatchEvent(new browser.Event('input', { bubbles: true }));
    },
  };
}

test('неожиданный программный focus сохраняет цель без текста сообщения', async (t) => {
  const h = await fixture(t);

  h.type();
  h.target.focus();
  h.browser.dispatchEvent(new h.browser.Event('blur'));
  await Promise.resolve();

  assert.equal(h.marks.length, 1);
  assert.match(h.marks[0]!, /AGENT-DBG chat-composer-focus/);
  assert.match(h.marks[0]!, /"active":"BUTTON"/);
  assert.doesNotMatch(h.marks[0]!, /Приватный|Секретная/);

  h.type();
  h.target.focus();
  await Promise.resolve();
  assert.equal(h.marks.length, 1, 'повтор ограничен минутой');

  h.advance(60_001);
  h.type();
  h.browser.dispatchEvent(new h.browser.Event('blur'));
  await Promise.resolve();
  assert.match(h.marks[1]!, /"cause":"window"/);
});

test('явный клик и Tab не считаются сбоем ввода', async (t) => {
  const h = await fixture(t);

  h.type();
  h.target.dispatchEvent(new h.browser.Event('pointerdown', { bubbles: true }));
  h.target.focus();
  await Promise.resolve();

  h.type();
  h.element.dispatchEvent(new h.browser.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  h.target.focus();
  await Promise.resolve();

  assert.equal(h.marks.length, 0);
});

test('давний набор и dispose не оставляют активной диагностики', async (t) => {
  const h = await fixture(t);

  h.type();
  h.advance(3001);
  h.target.focus();
  await Promise.resolve();
  assert.equal(h.marks.length, 0);

  h.type();
  h.target.focus();
  h.dispose();
  await Promise.resolve();
  assert.equal(h.marks.length, 0, 'dispose отменяет и отложенную отметку');

  h.type();
  h.target.focus();
  await Promise.resolve();
  assert.equal(h.marks.length, 0);
});
