import assert from 'node:assert/strict';
import test from 'node:test';
import { serializeHistoryChat } from '../../server/src/lib/chat/historySerialization.ts';

test('порционный JSON сохраняет байты, порядок ключей, пропуски и контекст toJSON', async () => {
  const contextual = { toJSON: (key) => `ключ:${key}` };
  const chat = {
    id: 'serialization',
    revision: 7,
    title: 'Кавычки " и перенос\n🌍',
    optional: undefined,
    metadata: contextual,
    messages: [contextual, undefined, , {
      role: 'assistant',
      steps: [{ text: 'Сохранённый шаг', numbers: [NaN, Infinity, -0] }],
    }],
    archived: false,
  };
  const encoded = await serializeHistoryChat(chat);

  assert.equal(encoded.json, JSON.stringify(chat));
  assert.equal(encoded.withRevision(8), JSON.stringify({ ...chat, revision: 8 }));
  assert.equal(encoded.withRevision(9), JSON.stringify({ ...chat, revision: 9 }));
  assert.equal(encoded.json, JSON.stringify(chat));

  delete chat.revision;

  const withoutRevision = await serializeHistoryChat(chat);

  assert.equal(withoutRevision.withRevision(1), JSON.stringify({ ...chat, revision: 1 }));
});

test('повышение revision повторно не читает сообщения и шаги', async () => {
  let reads = 0;
  const chat = {
    id: 'one-traversal',
    revision: 1,
    messages: [{
      role: 'assistant',
      get steps() {
        reads += 1;

        return [{ text: 'Тело' }];
      },
    }],
  };
  const encoded = await serializeHistoryChat(chat);

  assert.equal(reads, 1);
  assert.equal(JSON.parse(encoded.withRevision(2)).revision, 2);
  assert.equal(JSON.parse(encoded.withRevision(3)).messages[0].steps[0].text, 'Тело');
  assert.equal(reads, 1);
});

test('большая история уступает event loop до завершения кодирования', async () => {
  const chat = {
    id: 'yielding-history',
    messages: Array.from({ length: 100 }, () => ({
      role: 'assistant',
      steps: Array.from({ length: 150 }, () => ({ text: 'о'.repeat(1000) })),
    })),
  };
  let yielded = false;
  const scheduled = new Promise((resolve) => setImmediate(() => {
    yielded = true;
    resolve();
  }));
  const encoded = await serializeHistoryChat(chat);

  assert.equal(yielded, true, 'Другая задача должна исполниться до конца большой истории');
  assert.equal(encoded.json, JSON.stringify(chat));
  await scheduled;
});
