import assert from 'node:assert/strict';
import test from 'node:test';

import { chatActivity } from '../../server/src/lib/mobile/facade/chatActivity.ts';
import { chatPreview } from '../../server/src/lib/chat/chatPreview.ts';
import { chatSettings } from '../../server/src/lib/mobile/facade/chatControls.ts';
import { decodeContract } from '../../server/src/lib/mobile/contract.ts';
import { decodeContract as mobile } from '../../mobile/src/api/contract.ts';
import { decodeContract as baseline } from '../fixtures/mobile-contract/baseline/contract.ts';
import { readFile } from 'node:fs/promises';

test('Лента склеивает вызов, обновление и результат; неизвестное событие не пропадает', () => {
  const activity = chatActivity([
    {
      k: 'note',
      truncated: true,
      dropped: 7,
    },
    {
      k: 'tool',
      id: 'a',
      name: 'Bash',
      preview: 'npm test',
      at: 1,
    },
    {
      k: 'tool',
      id: 'a',
      preview: '',
      at: 2,
    },
    {
      k: 'think',
      text: 'Опубликованное резюме',
      at: 3,
    },
    {
      k: 'res',
      id: 'a',
      ok: false,
      text: 'Ошибка проверки',
      at: 4,
    },
    {
      k: 'custom',
      text: 'Новое событие',
      at: 5,
    },
    {
      k: 'text',
      text: 'Ответ в ленте',
      at: 6,
    },
  ], true);

  assert.equal(activity.omitted, 7);
  assert.equal(activity.items.length, 4);
  assert.equal(activity.items[0].text, 'npm test');
  assert.equal(activity.items[0].result, 'Ошибка проверки');
  assert.equal(activity.items[0].state, 'error');
  assert.equal(activity.items[2].text, 'Новое событие');
  assert.equal(chatActivity([{ k: 'text', text: 'Итог' }]).items.length, 0);
});

test('Лимит ленты учитывает JSON bytes и сообщает пропуск, длинные результаты имеют маркер', () => {
  const activity = chatActivity(Array.from({ length: 500 }, (_, index) => ({
    k: 'tool',
    id: String(index),
    name: 'Read',
    preview: '\u0000'.repeat(12000),
  })), true);

  assert.equal(activity.items.length + activity.omitted, 500);
  assert.ok(Buffer.byteLength(JSON.stringify(activity)) < 132 * 1024);
  assert.ok(activity.items.at(-1).text.endsWith('…'));
  assert.equal(activity.items.at(-1).id, '499');
  assert.deepEqual(mobile('chat-activity', activity), activity);
});

test('Превью не читает пустые хвосты, ограничено и различает реплику человека', () => {
  assert.equal(chatPreview({ messages: [] }), '');
  assert.equal(chatPreview({ messages: [
    { role: 'user', text: 'Проверь\n   планшет' },
    { role: 'assistant', text: '' },
  ] }), 'Ты: Проверь планшет');
  assert.equal(chatPreview({ messages: [{ role: 'assistant', text: 'x'.repeat(1000) }] }).length, 300);
});

test('Новые поля проходят сервер, приложение и неизменённый decoder v1', async () => {
  const sample = new URL('../fixtures/mobile-contract/v1/chat.json', import.meta.url);
  const chat = JSON.parse(await readFile(sample));

  chat.chat.provider = {
      id: 'codex',
      name: 'GPT',
      color: '#10a37f',
    };
  chat.chat.preview = 'Ответ';
  chat.chat.modelRef = { provider: 'codex', model: 'test-model' };
  chat.chat.unread = true;
  chat.chat.settings = chatSettings({
    modelRef: chat.chat.modelRef,
    contextTokens: 0,
    contextWindow: 100000,
    contextMetric: 'last-request-input',
  }, undefined, { chat: {} });
  chat.activity = chatActivity([{
      k: 'tool',
      id: 'a',
      name: 'Read',
      preview: 'README.md',
    }], true);
  chat.messages[1].activity = chatActivity([{ k: 'think', text: 'Опубликованное резюме' }]);

  for (const decode of [decodeContract, mobile, baseline]) {
    assert.deepEqual(decode('chat', chat), chat);
  }

  const hello = JSON.parse(await readFile(
    new URL('../fixtures/mobile-contract/v1/hello.json', import.meta.url),
  ));

  hello.features = ['chat-controls', 'attention'];

  for (const decode of [decodeContract, mobile, baseline]) {
    assert.deepEqual(decode('hello', hello), hello);
  }

  chat.chat.provider.color = 'url(https://example.invalid/image)';
  assert.throws(() => mobile('chat', chat));
});
