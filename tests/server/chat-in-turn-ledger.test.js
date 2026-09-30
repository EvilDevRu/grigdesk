// Durable журнал уточнений: приём, идентичность, восстановление и уборка.
//
// Проверяем именно обещания раздела 6.4 плана: запись переживает процесс, повтор с тем же
// id не создаёт второе сообщение, чужой чат не читает запись по совпавшему id, а мёртвый
// запуск получает честный исход без запуска агента.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ChatInTurnLedger } from '../../server/src/lib/chat/inTurnLedger.ts';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-in-turn-ledger-'));
}

function record(overrides = {}) {
  return {
    chatKey: 'fixture-chat',
    messageId: 'fixture-message-0001',
    runId: 'fixture-run-0001',
    state: 'accepted',
    revision: 1,
    sequence: 1,
    text: 'Почему выбран первый файл?',
    fingerprint: 'fp-1',
    acceptedAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

test('CORE-07: два одинаковых текста с разными id сохраняются отдельно', async () => {
  const dir = await tmpDir();
  const ledger = new ChatInTurnLedger({ dir, now: () => 2000 });

  await ledger.put(record({ messageId: 'fixture-message-0001' }));
  await ledger.put(record({ messageId: 'fixture-message-0002', sequence: 2 }));

  assert.equal(ledger.byRun('fixture-run-0001').length, 2);
  assert.equal(ledger.get('fixture-chat', 'fixture-message-0001').text, 'Почему выбран первый файл?');
  assert.equal(ledger.get('fixture-chat', 'fixture-message-0002').text, 'Почему выбран первый файл?');
});

test('CORE-09/CORE-10: запись переживает новый процесс, чужой чат независим', async () => {
  const dir = await tmpDir();
  const first = new ChatInTurnLedger({ dir, now: () => 2000 });

  await first.put(record());
  await first.put(record({ chatKey: 'fixture-chat-2', runId: 'fixture-run-0002', fingerprint: 'fp-2' }));

  const second = new ChatInTurnLedger({ dir, now: () => 3000 });

  await second.load();

  assert.equal(second.get('fixture-chat', 'fixture-message-0001').runId, 'fixture-run-0001');
  assert.equal(second.get('fixture-chat-2', 'fixture-message-0001').runId, 'fixture-run-0002');
  assert.equal(second.get('fixture-chat', 'fixture-message-0002'), null);
});

test('CORE-13: поздний forwarded не откатывает consumed', async () => {
  const dir = await tmpDir();
  const ledger = new ChatInTurnLedger({ dir, now: () => 2000 });

  await ledger.put(record());
  await ledger.update('fixture-chat', 'fixture-message-0001', { state: 'delivering' });
  const consumed = await ledger.update('fixture-chat', 'fixture-message-0001', { state: 'consumed' });
  const late = await ledger.update('fixture-chat', 'fixture-message-0001', { state: 'forwarded' });

  assert.equal(consumed.state, 'consumed');
  assert.equal(late.state, 'consumed');
  assert.ok(late.revision >= consumed.revision, 'revision не убывает');
  assert.equal(consumed.sequence, 1, 'sequence фиксируется при первом появлении');
});

test('CORE-11: startup-проход переводит мёртвые запуски и не трогает живые', async () => {
  const dir = await tmpDir();
  const ledger = new ChatInTurnLedger({ dir, now: () => 2000 });

  await ledger.put(record({ messageId: 'fixture-message-0001' }));
  await ledger.put(record({ messageId: 'fixture-message-0002', sequence: 2, state: 'delivering' }));
  await ledger.put(record({ messageId: 'fixture-message-0003', sequence: 3, runId: 'fixture-run-live' }));

  const touched = await ledger.sweepDeadRuns(new Set(['fixture-run-live']));

  assert.equal(touched.length, 2);
  assert.equal(ledger.get('fixture-chat', 'fixture-message-0001').state, 'failed');
  assert.match(ledger.get('fixture-chat', 'fixture-message-0001').error, /не передано/i);
  assert.equal(ledger.get('fixture-chat', 'fixture-message-0002').state, 'unknown');
  assert.equal(ledger.get('fixture-chat', 'fixture-message-0003').state, 'accepted');
});

test('CORE-08: уборка не удаляет недосохранённое, сохранённое старше срока убирает', async () => {
  const dir = await tmpDir();
  let now = 10_000;
  const ledger = new ChatInTurnLedger({ dir, now: () => now, retentionMs: 1000 });

  await ledger.put(record({ messageId: 'fixture-message-0001', state: 'failed', updatedAt: 1000 }));
  await ledger.put(record({ messageId: 'fixture-message-0002', sequence: 2, state: 'unknown', updatedAt: 1000 }));
  await ledger.put(record({ messageId: 'fixture-message-0003', sequence: 3, state: 'failed', updatedAt: 1000 }));

  await ledger.markSavedToHistory('fixture-chat', 'fixture-message-0003');

  now = 20_000;
  await ledger.prune();

  assert.ok(ledger.get('fixture-chat', 'fixture-message-0001'), 'недоставленное без отметки истории остаётся');
  assert.ok(ledger.get('fixture-chat', 'fixture-message-0002'), 'неопределённое остаётся');
  assert.equal(ledger.get('fixture-chat', 'fixture-message-0003'), null, 'сохранённое и старое убрано');

  const files = await fs.readdir(path.join(dir, 'fixture-chat'));

  assert.deepEqual(files.sort(), ['fixture-message-0001.json', 'fixture-message-0002.json']);
});

test('CORE-10: небезопасный сегмент пути отклоняется до записи', async () => {
  const dir = await tmpDir();
  const ledger = new ChatInTurnLedger({ dir, now: () => 2000 });

  await assert.rejects(() => ledger.put(record({ chatKey: '..' })), /in_turn_bad_storage_segment/);
  await assert.rejects(() => ledger.put(record({ messageId: 'a/../../etc' })), /in_turn_bad_storage_segment/);
});
