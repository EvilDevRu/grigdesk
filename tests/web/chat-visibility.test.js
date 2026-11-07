// Проверяет реестр видимости чатов для пузыря компаньона и полной страницы.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createChatVisibilityRegistry } from '../../web/src/shared/chatVisibility.ts';

test('COMP-VIS-01: surface видит только свой exact chat id', () => {
  const registry = createChatVisibilityRegistry({ isDocumentVisible: () => true });
  const bubble = registry.register('companion', { chatId: 'companion-1', visible: true });

  assert.equal(registry.isVisible('companion-1'), true);
  assert.equal(registry.isVisible('other-chat'), false);

  bubble.update({ chatId: 'companion-2', visible: true });
  assert.equal(registry.isVisible('companion-1'), false);
  assert.equal(registry.isVisible('companion-2'), true);
});

test('COMP-VIS-02: collapsed/hidden document и disposer закрывают surface', () => {
  let documentVisible = true;
  const registry = createChatVisibilityRegistry({ isDocumentVisible: () => documentVisible });
  const page = registry.register('chats-page', { chatId: 'c1', visible: false });

  assert.equal(registry.isVisible('c1'), false);
  page.update({ chatId: 'c1', visible: true });
  assert.equal(registry.isVisible('c1'), true);
  documentVisible = false;
  assert.equal(registry.isVisible('c1'), false);
  documentVisible = true;
  page.dispose();
  assert.equal(registry.isVisible('c1'), false);
});

test('COMP-VIS-03: поздний disposer старого owner не удаляет новый surface', () => {
  const registry = createChatVisibilityRegistry({ isDocumentVisible: () => true });
  const oldPage = registry.register('chats-page', { chatId: 'old', visible: true });
  const newPage = registry.register('chats-page', { chatId: 'new', visible: true });

  oldPage.dispose();
  assert.equal(registry.isVisible('new'), true);
  assert.equal(registry.size(), 1);
  newPage.dispose();
  assert.equal(registry.size(), 0);
});
