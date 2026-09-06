// Проверяет, что канонические документы описывают компаньона и не возвращают удалённую панель чата.
import assert from 'node:assert/strict';
import test from 'node:test';

import { canonDocs, rootDoc } from './helpers/canon.mjs';

test('COMP-DOC-01: канон описывает companion и не возвращает legacy floating chat', async () => {
  const combined = `${await rootDoc('CLAUDE.md')}\n${await canonDocs()}`;

  assert.doesNotMatch(combined, /\bChatPanel\b|\bChatTabs\b|cockpit-chat-panel-composer-h/);
  assert.match(combined, /CompanionHost/);
  assert.match(combined, /companionTurn/);
  assert.match(combined, /logicalIdentity/);
  assert.match(combined, /speechSynthesis/);
  assert.match(combined, /по умолчанию выключен/i);
  assert.match(combined, /routingScope/);
  assert.match(combined, /недоверенн/i);
});
