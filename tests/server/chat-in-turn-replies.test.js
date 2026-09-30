// Видимые блоки ответа: идентичность, накопление дельт, завершение и обрезка.
//
// Блок — вторая половина обещания «ответ до финала»: он обязан существовать ровно один раз,
// не терять id при финальной очистке и переживать падение процесса.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ChatAssistantMessages } from '../../server/src/lib/chat/assistantMessages.ts';
import { ChatAssistantPublisher } from '../../server/src/lib/chat/assistantPublisher.ts';
import { IN_TURN_BLOCK_TEXT_LIMIT, utf8Bytes } from '../../shared/chatInTurnContracts.ts';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-in-turn-replies-'));
}

test('CORE-14: блок сохраняет assistantMessageId при завершении и очистке текста', async () => {
  const dir = await tmpDir();
  const messages = new ChatAssistantMessages({ dir, now: () => 1000 });

  await messages.begin({
    runId: 'fixture-run-0001',
    chatKey: 'fixture-chat',
    assistantMessageId: 'fixture-block-0001',
    sequence: 2,
  });
  messages.appendDelta('fixture-run-0001', 'fixture-block-0001', 'Ответ ');
  messages.appendDelta('fixture-run-0001', 'fixture-block-0001', 'по ходу работы');

  const live = messages.live('fixture-run-0001');

  assert.equal(live.length, 1);
  assert.equal(live[0].complete, false);
  assert.equal(live[0].text, 'Ответ по ходу работы');

  const done = await messages.complete('fixture-run-0001', 'fixture-block-0001', {
    text: 'Ответ по ходу работы',
  });

  assert.equal(done.assistantMessageId, 'fixture-block-0001');
  assert.equal(done.complete, true);
  assert.equal(done.revision, 2);
  assert.equal(messages.live('fixture-run-0001').length, 0);
});

test('CORE-14: два запуска с похожими id не склеиваются, порядок по sequence', async () => {
  const dir = await tmpDir();
  const messages = new ChatAssistantMessages({ dir, now: () => 1000 });

  await messages.begin({
    runId: 'fixture-run-0001',
    chatKey: 'fixture-chat',
    assistantMessageId: 'fixture-block-0001',
    sequence: 2,
  });
  await messages.begin({
    runId: 'fixture-run-0002',
    chatKey: 'fixture-chat',
    assistantMessageId: 'fixture-block-0001',
    sequence: 1,
  });
  await messages.begin({
    runId: 'fixture-run-0001',
    chatKey: 'fixture-chat',
    assistantMessageId: 'fixture-block-0002',
    sequence: 3,
  });

  const first = messages.byRun('fixture-run-0001');

  assert.deepEqual(first.map((block) => block.assistantMessageId), [
    'fixture-block-0001',
    'fixture-block-0002',
  ]);
  assert.equal(messages.byRun('fixture-run-0002').length, 1);
});

test('FLOW-08: слишком длинный блок обрезается с видимой меткой, id не меняется', async () => {
  const dir = await tmpDir();
  const messages = new ChatAssistantMessages({ dir, now: () => 1000 });

  await messages.begin({
    runId: 'fixture-run-0001',
    chatKey: 'fixture-chat',
    assistantMessageId: 'fixture-block-0001',
    sequence: 1,
  });
  messages.appendDelta('fixture-run-0001', 'fixture-block-0001', 'н'.repeat(IN_TURN_BLOCK_TEXT_LIMIT));
  messages.appendDelta('fixture-run-0001', 'fixture-block-0001', 'хвост ответа');

  const done = await messages.complete('fixture-run-0001', 'fixture-block-0001');

  assert.equal(done.truncated, true);
  assert.match(done.text, /сокращено/);
  assert.ok(utf8Bytes(done.text) <= IN_TURN_BLOCK_TEXT_LIMIT);
  assert.ok(done.text.endsWith('хвост ответа'), 'хвост ответа сохранён');
});

test('CORE-12: завершённый блок переживает новый процесс, незавершённый не объявляется полным', async () => {
  const dir = await tmpDir();
  const first = new ChatAssistantMessages({ dir, now: () => 1000 });

  await first.begin({
    runId: 'fixture-run-0001',
    chatKey: 'fixture-chat',
    assistantMessageId: 'fixture-block-0001',
    sequence: 1,
  });
  first.appendDelta('fixture-run-0001', 'fixture-block-0001', 'Готовый текст');
  await first.complete('fixture-run-0001', 'fixture-block-0001');
  await first.begin({
    runId: 'fixture-run-0001',
    chatKey: 'fixture-chat',
    assistantMessageId: 'fixture-block-0002',
    sequence: 2,
  });
  first.appendDelta('fixture-run-0001', 'fixture-block-0002', 'Оборванный');

  const second = new ChatAssistantMessages({ dir, now: () => 2000 });

  await second.load();

  assert.equal(second.get('fixture-run-0001', 'fixture-block-0001').text, 'Готовый текст');
  assert.equal(second.get('fixture-run-0001', 'fixture-block-0001').complete, true);
  assert.equal(second.get('fixture-run-0001', 'fixture-block-0002').complete, false);
  assert.equal(second.live('fixture-run-0001')[0].assistantMessageId, 'fixture-block-0002');
});

test('abandon оставляет оборванный блок видимым и завершает его без потери id', async () => {
  const dir = await tmpDir();
  const messages = new ChatAssistantMessages({ dir, now: () => 1000 });

  await messages.begin({
    runId: 'fixture-run-0001',
    chatKey: 'fixture-chat',
    assistantMessageId: 'fixture-block-0001',
    sequence: 1,
  });
  messages.appendDelta('fixture-run-0001', 'fixture-block-0001', 'Половина отв');

  const abandoned = await messages.abandon('fixture-run-0001', 'fixture-block-0001');

  assert.equal(abandoned.complete, false, 'оборванный блок не объявляется полным');
  assert.equal(abandoned.text, 'Половина отв');
  assert.equal(messages.get('fixture-run-0001', 'fixture-block-0001').text, 'Половина отв');
  assert.equal(messages.byRun('fixture-run-0001')[0].assistantMessageId, 'fixture-block-0001');
});

test('финал ждёт запись блока, даже если адаптер не ждёт callback', async (t) => {
  const dir = await tmpDir();
  const messages = new ChatAssistantMessages({ dir });
  const published = [];
  const publisher = new ChatAssistantPublisher({
    messages,
    nextSequence: () => 3,
    onMessage: (block) => published.push(block),
  });

  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  void publisher.publish('fixture-run-0001', 'fixture-chat', {
    assistantMessageId: 'fixture-block-0001',
    text: 'Ответ до финала',
    sourceRevision: 1,
    complete: true,
  });
  await publisher.flush('fixture-run-0001');

  const restored = new ChatAssistantMessages({ dir });

  await restored.load();

  const block = restored.get('fixture-run-0001', 'fixture-block-0001');

  assert.equal(block?.complete, true);
  assert.equal(block?.text, 'Ответ до финала');
  assert.equal(block?.sequence, 3);
  assert.deepEqual(published, [block]);
});

test('ошибка завершившейся записи доходит до финала только своего запуска', async (t) => {
  const dir = await tmpDir();
  const file = path.join(dir, 'not-a-directory');

  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(file, 'Каталог недоступен');

  const publisher = new ChatAssistantPublisher({
    messages: new ChatAssistantMessages({ dir: file }),
    nextSequence: () => 1,
    onMessage: () => assert.fail('Незаписанный блок не должен публиковаться'),
  });
  const writing = publisher.publish('fixture-run-0001', 'fixture-chat', {
    assistantMessageId: 'fixture-block-0001',
    text: 'Ответ',
    sourceRevision: 1,
    complete: true,
  });

  await assert.rejects(writing, { code: 'ENOTDIR' });
  await publisher.flush('fixture-run-0002');
  await assert.rejects(publisher.flush('fixture-run-0001'), { code: 'ENOTDIR' });
  await publisher.flush('fixture-run-0001');
});
