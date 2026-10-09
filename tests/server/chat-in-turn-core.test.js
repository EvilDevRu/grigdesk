// Координатор уточнений: приём при занятом ходе, порядок, готовность канала и исходы.
//
// Проверяем поведение, ради которого канал существует: уточнение доходит до порта своего
// запуска, не создаёт второй обычный ход, не повторяется при неопределённом исходе и
// получает честный отказ, когда канал закрыт.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ChatAssistantMessages } from '../../server/src/lib/chat/assistantMessages.ts';
import { ChatInTurnLedger } from '../../server/src/lib/chat/inTurnLedger.ts';
import { InTurnMessages } from '../../server/src/lib/chat/inTurnMessages.ts';
import { IN_TURN_ATTACHMENT_LIMIT, IN_TURN_BACKLOG_LIMIT } from '../../shared/chatInTurnContracts.ts';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-in-turn-core-'));
}

/** Сборка координатора с журналами во временном каталоге: никакого общего состояния. */
async function makeCoordinator(onChange = null) {
  const dir = await tmpDir();
  const ledger = new ChatInTurnLedger({ dir: path.join(dir, 'messages'), now: () => 1000 });
  const assistant = new ChatAssistantMessages({ dir: path.join(dir, 'assistant'), now: () => 1000 });

  return new InTurnMessages({ ledger, assistant, now: () => 1000, onChange });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

/**
 * Ожидание наблюдаемого состояния без настоящих задержек: опрашиваем микротасками,
 * а таймаут оставляем только сторожем зависания.
 */
async function waitUntil(predicate, timeoutMs = 2000) {
  const started = Date.now();

  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('waitUntil: состояние не наступило');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function acceptInput(overrides = {}) {
  return {
    chatKey: 'fixture-chat',
    runId: 'fixture-run-0001',
    messageId: 'fixture-message-0001',
    text: 'Почему выбран первый файл?',
    ...overrides,
  };
}

test('CORE-01/CORE-04: уточнение доходит до порта, delivering записан до внешнего вызова', async () => {
  const inTurn = await makeCoordinator();

  inTurn.beginRun({ chatKey: 'fixture-chat', runId: 'fixture-run-0001' });

  const beforePort = await inTurn.accept(acceptInput());

  assert.equal(beforePort.ok, false);
  assert.equal(beforePort.code, 'in_turn_unavailable');
  assert.equal(beforePort.reason, 'not_ready');

  const seen = [];

  inTurn.registerPort('fixture-run-0001', {
    async deliver(input) {
      seen.push({ ...input, stateAtCall: inTurn.ledger.get('fixture-chat', input.messageId).state });

      return { ok: true, state: 'forwarded' };
    },
  });

  const accepted = await inTurn.accept(acceptInput());

  assert.equal(accepted.ok, true);
  assert.equal(accepted.receipt.state, 'accepted');
  assert.equal(accepted.receipt.sequence, 1);

  await waitUntil(() => inTurn.receipt('fixture-chat', 'fixture-message-0001').state === 'forwarded');

  assert.equal(seen.length, 1);
  assert.equal(seen[0].text, 'Почему выбран первый файл?');
  assert.equal(seen[0].stateAtCall, 'delivering', 'устойчивая запись предшествует внешнему эффекту');
});

test('CORE-02: порядок сохраняется, повтор не обгоняет и не дублирует', async () => {
  const inTurn = await makeCoordinator();
  const gate = deferred();
  const order = [];

  inTurn.beginRun({ chatKey: 'fixture-chat', runId: 'fixture-run-0001' });
  inTurn.registerPort('fixture-run-0001', {
    async deliver(input) {
      order.push(input.messageId);
      if (input.messageId === 'fixture-message-0001') {
        await gate.promise;
      }

      return { ok: true, state: 'forwarded' };
    },
  });

  await inTurn.accept(acceptInput());
  await inTurn.accept(acceptInput({ messageId: 'fixture-message-0002', text: 'Второе уточнение' }));

  const duplicate = await inTurn.accept(acceptInput());

  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.receipt.duplicate, true);
  assert.equal(duplicate.receipt.sequence, 1);

  gate.resolve();
  await waitUntil(() => order.length === 2);

  assert.deepEqual(order, ['fixture-message-0001', 'fixture-message-0002']);
});

test('CORE-05: другой payload при том же id — конфликт, дубликат переживает финал', async () => {
  const inTurn = await makeCoordinator();

  inTurn.beginRun({ chatKey: 'fixture-chat', runId: 'fixture-run-0001' });
  inTurn.registerPort('fixture-run-0001', { async deliver() { return { ok: true, state: 'forwarded' }; } });

  await inTurn.accept(acceptInput());

  const conflict = await inTurn.accept(acceptInput({ text: 'Другой текст' }));

  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'message_conflict');

  await waitUntil(() => inTurn.receipt('fixture-chat', 'fixture-message-0001').state === 'forwarded');
  await inTurn.closeRun('fixture-run-0001');

  const afterFinish = await inTurn.accept(acceptInput());

  assert.equal(afterFinish.ok, true, 'потерянный ACK восстанавливается после финала');
  assert.equal(afterFinish.receipt.duplicate, true);
  assert.equal(afterFinish.receipt.state, 'forwarded');
});

test('CORE-03: старый запуск закрыт, поздние события не трогают новый', async () => {
  const inTurn = await makeCoordinator();

  inTurn.beginRun({ chatKey: 'fixture-chat', runId: 'fixture-run-0001' });
  inTurn.registerPort('fixture-run-0001', { async deliver() { return { ok: true, state: 'forwarded' }; } });
  await inTurn.accept(acceptInput());
  await waitUntil(() => inTurn.receipt('fixture-chat', 'fixture-message-0001').state === 'forwarded');
  await inTurn.closeRun('fixture-run-0001', 'Ход остановлен.');

  inTurn.beginRun({ chatKey: 'fixture-chat', runId: 'fixture-run-0002' });

  const late = await inTurn.noteReceipt({
    chatKey: 'fixture-chat',
    runId: 'fixture-run-0001',
    messageId: 'fixture-message-0001',
    state: 'consumed',
  });

  assert.equal(late.state, 'consumed', 'позднее подтверждение поднимает свою запись');
  assert.equal(inTurn.availability('fixture-run-0002').available, false, 'новый запуск не открыт сам собой');
  assert.equal(inTurn.receipt('fixture-chat', 'fixture-message-0001').runId, 'fixture-run-0001');
});

test('CORE-06/CORE-13: unknown без повтора, позднее подтверждение поднимает состояние', async () => {
  const inTurn = await makeCoordinator();

  inTurn.beginRun({ chatKey: 'fixture-chat', runId: 'fixture-run-0001' });
  inTurn.registerPort('fixture-run-0001', {
    async deliver() {
      return { ok: false, code: 'transport_lost', message: 'Связь оборвалась', uncertain: true };
    },
  });

  await inTurn.accept(acceptInput());
  await waitUntil(() => inTurn.receipt('fixture-chat', 'fixture-message-0001').state === 'unknown');

  const revived = await inTurn.noteReceipt({
    chatKey: 'fixture-chat',
    runId: 'fixture-run-0001',
    messageId: 'fixture-message-0001',
    state: 'consumed',
  });

  assert.equal(revived.state, 'consumed');
  assert.ok(revived.revision > 2, 'revision растёт на каждом переходе');
});

test('инвариант 12: принятое сообщение ждёт открытия канала и доходит после ответа', async () => {
  const inTurn = await makeCoordinator();
  const gate = deferred();
  const delivered = [];

  inTurn.beginRun({ chatKey: 'fixture-chat', runId: 'fixture-run-0001' });
  inTurn.registerPort('fixture-run-0001', {
    async deliver(input) {
      delivered.push(input.messageId);
      if (input.messageId === 'fixture-message-0001') {
        await gate.promise;
      }

      return { ok: true, state: 'forwarded' };
    },
  });

  await inTurn.accept(acceptInput());
  await waitUntil(() => inTurn.ledger.get('fixture-chat', 'fixture-message-0001').state === 'delivering');
  await inTurn.accept(acceptInput({ messageId: 'fixture-message-0002', text: 'Второе уточнение' }));
  inTurn.setAvailability('fixture-run-0001', false, 'awaiting_answer');

  const rejected = await inTurn.accept(acceptInput({ messageId: 'fixture-message-0003', text: 'Третье уточнение' }));

  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'awaiting_answer');

  gate.resolve();
  await waitUntil(() => inTurn.receipt('fixture-chat', 'fixture-message-0001').state === 'forwarded');
  assert.equal(delivered.includes('fixture-message-0002'), false, 'вопрос не принят за ответ');

  inTurn.setAvailability('fixture-run-0001', true);
  await waitUntil(() => delivered.includes('fixture-message-0002'));
  assert.equal(inTurn.receipt('fixture-chat', 'fixture-message-0002').state, 'forwarded');
});

test('инвариант 12/закрытие: ожидающее сообщение при «стопе» получает отказ', async () => {
  const inTurn = await makeCoordinator();
  const gate = deferred();

  inTurn.beginRun({ chatKey: 'fixture-chat', runId: 'fixture-run-0001' });
  inTurn.registerPort('fixture-run-0001', {
    async deliver(input) {
      if (input.messageId === 'fixture-message-0001') {
        await gate.promise;
      }

      return { ok: true, state: 'forwarded' };
    },
  });

  await inTurn.accept(acceptInput());
  await waitUntil(() => inTurn.ledger.get('fixture-chat', 'fixture-message-0001').state === 'delivering');
  await inTurn.accept(acceptInput({ messageId: 'fixture-message-0002', text: 'Второе уточнение' }));
  inTurn.setAvailability('fixture-run-0001', false, 'awaiting_answer');

  await inTurn.closeRun('fixture-run-0001', 'Ход остановлен.');

  assert.equal(inTurn.receipt('fixture-chat', 'fixture-message-0001').state, 'unknown');
  assert.equal(inTurn.receipt('fixture-chat', 'fixture-message-0002').state, 'failed');
  assert.match(inTurn.receipt('fixture-chat', 'fixture-message-0002').error, /Ход остановлен/);

  gate.resolve();
});

test('гонка финала: закрытый run не вызывает порт после записи delivering', async () => {
  const inTurn = await makeCoordinator();
  const atBoundary = deferred();
  const release = deferred();
  const closingBoundary = deferred();
  const closeRelease = deferred();
  const sent = [];
  const update = inTurn.ledger.update.bind(inTurn.ledger);

  inTurn.ledger.update = async (...args) => {
    if (args[2]?.state === 'unknown') {
      closingBoundary.resolve();
      await closeRelease.promise;
    }

    const record = await update(...args);

    if (args[2]?.state === 'delivering') {
      atBoundary.resolve();
      await release.promise;
    }

    return record;
  };

  inTurn.beginRun({ chatKey: 'fixture-chat', runId: 'fixture-run-0001' });
  inTurn.registerPort('fixture-run-0001', {
    async deliver(input) {
      sent.push(input.messageId);

      return { ok: true, state: 'forwarded' };
    },
  });

  await inTurn.accept(acceptInput());
  await atBoundary.promise;
  const closing = inTurn.closeRun('fixture-run-0001');

  await closingBoundary.promise;
  release.resolve();
  await inTurn.runs.get('fixture-run-0001').delivery;
  closeRelease.resolve();
  await closing;

  assert.equal(inTurn.receipt('fixture-chat', 'fixture-message-0001').state, 'unknown');

  assert.deepEqual(sent, [], 'закрытие между журналом и портом не даёт внешнего вызова');

  inTurn.beginRun({ chatKey: 'fixture-chat', runId: 'fixture-run-0002' });
  inTurn.registerPort('fixture-run-0002', {
    async deliver(input) {
      sent.push(input.messageId);

      return { ok: true, state: 'forwarded' };
    },
  });

  const late = await inTurn.accept(acceptInput({ messageId: 'fixture-message-0002' }));

  assert.equal(late.ok, false);
  assert.equal(late.code, 'turn_changed');
  assert.deepEqual(sent, [], 'сообщение старого запуска не уходит новому');
});

test('гонка вопроса: канал закрывается между журналом и портом до ответа человека', async () => {
  const inTurn = await makeCoordinator();
  const atBoundary = deferred();
  const release = deferred();
  const sent = [];
  const update = inTurn.ledger.update.bind(inTurn.ledger);

  inTurn.ledger.update = async (...args) => {
    const record = await update(...args);

    if (args[2]?.state === 'delivering') {
      atBoundary.resolve();
      await release.promise;
    }

    return record;
  };

  inTurn.beginRun({ chatKey: 'fixture-chat', runId: 'fixture-run-0001' });
  inTurn.registerPort('fixture-run-0001', {
    async deliver(input) {
      sent.push(input.messageId);

      return { ok: true, state: 'forwarded' };
    },
  });

  await inTurn.accept(acceptInput());
  await atBoundary.promise;
  inTurn.setAvailability('fixture-run-0001', false, 'awaiting_answer');
  release.resolve();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(sent, []);
  assert.equal(inTurn.availability('fixture-run-0001').reason, 'awaiting_answer');

  inTurn.setAvailability('fixture-run-0001', true);
  await inTurn.runs.get('fixture-run-0001').delivery;

  assert.deepEqual(sent, ['fixture-message-0001']);
  assert.equal(inTurn.receipt('fixture-chat', 'fixture-message-0001').state, 'forwarded');
});

test('CORE-08: backlog ограничен, лимит освобождается исходом', async () => {
  const inTurn = await makeCoordinator();
  const gate = deferred();

  inTurn.beginRun({ chatKey: 'fixture-chat', runId: 'fixture-run-0001' });
  inTurn.registerPort('fixture-run-0001', {
    async deliver() {
      await gate.promise;

      return { ok: true, state: 'forwarded' };
    },
  });

  for (let index = 1; index <= IN_TURN_BACKLOG_LIMIT; index += 1) {
    const id = `fixture-message-${String(index).padStart(4, '0')}`;
    const result = await inTurn.accept(acceptInput({ messageId: id, text: `Сообщение ${index}` }));

    assert.equal(result.ok, true, `принято сообщение ${index}`);
  }

  const overflow = await inTurn.accept(acceptInput({ messageId: 'fixture-message-9999', text: 'Лишнее' }));

  assert.equal(overflow.ok, false);
  assert.equal(overflow.code, 'in_turn_backlog_full');

  gate.resolve();
  await waitUntil(() => inTurn.ledger.pendingCount('fixture-run-0001') === 0);
});

test('«стоп»: accepted становится failed, delivering — unknown, подтверждённое цело', async () => {
  const inTurn = await makeCoordinator();
  const hanging = deferred();

  inTurn.beginRun({ chatKey: 'fixture-chat', runId: 'fixture-run-0001' });
  inTurn.registerPort('fixture-run-0001', {
    async deliver(input) {
      if (input.messageId === 'fixture-message-0002') {
        await hanging.promise;
      }

      return { ok: true, state: 'forwarded' };
    },
  });

  await inTurn.accept(acceptInput());
  await inTurn.accept(acceptInput({ messageId: 'fixture-message-0002', text: 'Висящее' }));
  await waitUntil(() => inTurn.ledger.get('fixture-chat', 'fixture-message-0002').state === 'delivering');

  await inTurn.closeRun('fixture-run-0001', 'Ход остановлен.');

  assert.equal(inTurn.receipt('fixture-chat', 'fixture-message-0001').state, 'forwarded');
  assert.equal(inTurn.receipt('fixture-chat', 'fixture-message-0002').state, 'unknown');

  hanging.resolve();
});

test('готовая страница отдаёт уточнения по sequence и честно усекает', async () => {
  const inTurn = await makeCoordinator();

  inTurn.beginRun({ chatKey: 'fixture-chat', runId: 'fixture-run-0001' });
  inTurn.registerPort('fixture-run-0001', { async deliver() { return { ok: true, state: 'forwarded' }; } });

  await inTurn.accept(acceptInput());
  await inTurn.assistant.begin({
    runId: 'fixture-run-0001',
    chatKey: 'fixture-chat',
    assistantMessageId: 'fixture-block-0001',
    sequence: inTurn.nextSequence('fixture-run-0001'),
  });
  await inTurn.assistant.appendDelta('fixture-run-0001', 'fixture-block-0001', 'Ответ по ходу');
  await inTurn.assistant.complete('fixture-run-0001', 'fixture-block-0001');
  await inTurn.accept(acceptInput({ messageId: 'fixture-message-0002', text: 'Второе' }));

  const page = inTurn.page('fixture-run-0001', { limit: 2 });

  assert.deepEqual(page.entries.map((entry) => entry.sequence), [1, 2]);
  assert.equal(page.nextAfterSequence, 2);
  assert.equal(page.truncated, true);

  const rest = inTurn.page('fixture-run-0001', { afterSequence: page.nextAfterSequence });

  assert.deepEqual(rest.entries.map((entry) => entry.sequence), [3]);
  assert.equal(rest.truncated, false);
  assert.equal(rest.nextAfterSequence, null);
});

test('картинки уточнения: приём без текста, receipt, порт и отказ без поддержки', async () => {
  const inTurn = await makeCoordinator();
  const attachments = [{
    file: '1-shot.png',
    name: 'shot.png',
    url: '/api/chat/attachment/1-shot.png',
    mime: 'image/png',
  }];
  const seen = [];

  inTurn.beginRun({ chatKey: 'fixture-chat', runId: 'fixture-run-0001', images: true });
  inTurn.registerPort('fixture-run-0001', {
    async deliver(input) {
      seen.push(input);

      return { ok: true, state: 'forwarded' };
    },
  });

  const accepted = await inTurn.accept(acceptInput({ text: '', attachments }));

  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.receipt.attachments, attachments);
  await waitUntil(() => seen.length === 1);
  assert.deepEqual(seen[0].attachments, attachments);
  assert.equal(seen[0].text, '');

  const conflict = await inTurn.accept(acceptInput({
    text: '',
    attachments: [{ ...attachments[0], file: '2-other.png' }],
  }));

  assert.equal(conflict.code, 'message_conflict', 'другой набор картинок под тем же id');

  const empty = await inTurn.accept(acceptInput({ messageId: 'fixture-message-0002', text: '  ' }));

  assert.equal(empty.code, 'invalid_in_turn_message', 'без текста и картинок уточнения нет');

  const tooMany = await inTurn.accept(acceptInput({
    messageId: 'fixture-message-0003',
    attachments: Array.from({ length: IN_TURN_ATTACHMENT_LIMIT + 1 }, (_, index) => ({
      ...attachments[0],
      file: `${index}-shot.png`,
    })),
  }));

  assert.equal(tooMany.code, 'message_too_large');

  const plain = await makeCoordinator();

  plain.beginRun({ chatKey: 'fixture-chat', runId: 'fixture-run-0002' });
  plain.registerPort('fixture-run-0002', {
    async deliver() {
      return { ok: true, state: 'forwarded' };
    },
  });

  const refused = await plain.accept(acceptInput({ runId: 'fixture-run-0002', attachments }));

  assert.equal(refused.code, 'in_turn_unavailable');
  assert.equal(refused.reason, 'unsupported');
});
