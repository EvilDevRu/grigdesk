// Проверяет, что канонические документы описывают компаньона и не возвращают удалённую панель чата.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);
const files = [
  'CLAUDE.md',
  'docs/cockpit/architecture.md',
  'docs/cockpit/chat-agents.md',
  'docs/cockpit/gotchas.md',
];

test('COMP-DOC-01: канон описывает companion и не возвращает legacy floating chat', async () => {
  const docs = (await Promise.all(files.map(async (file) => ({
    file,
    text: await readFile(new URL(file, root), 'utf8'),
  }))));
  const combined = docs.map(({ file, text }) => `\n# ${file}\n${text}`).join('');

  assert.doesNotMatch(combined, /\bChatPanel\b|\bChatTabs\b|cockpit-chat-panel-composer-h/);
  assert.match(combined, /CompanionHost/);
  assert.match(combined, /companionTurn/);
  assert.match(combined, /logicalIdentity/);
  assert.match(combined, /speechSynthesis/);
  assert.match(combined, /по умолчанию выключен/i);
  assert.match(combined, /routingScope/);
  assert.match(combined, /недоверенн/i);
});
