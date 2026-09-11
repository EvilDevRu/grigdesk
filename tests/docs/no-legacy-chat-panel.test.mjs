// Проверяет, что канонические документы не возвращают удалённые поверхности чата: ни legacy
// плавающую панель, ни компактного компаньона, — но по-прежнему описывают server-owned
// identity companion-чата, которой пользуется Telegram-пульт.
import assert from 'node:assert/strict';
import test from 'node:test';

import { canonDocs, rootDoc } from './helpers/canon.mjs';

test('COMP-DOC-01: канон не возвращает legacy floating chat и компактного компаньона', async () => {
  const combined = `${await rootDoc('CLAUDE.md')}\n${await canonDocs()}`;

  assert.doesNotMatch(combined, /\bChatPanel\b|\bChatTabs\b|cockpit-chat-panel-composer-h/);
  assert.doesNotMatch(combined, /CompanionHost|CompanionBubble|speechSynthesis/);
  assert.match(combined, /logicalIdentity/);
  assert.match(combined, /companion:global/);
  assert.match(combined, /больше нет/i);
  assert.match(combined, /недоверенн/i);
});
