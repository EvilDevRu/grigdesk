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
import { IN_TURN_BLOCK_TEXT_LIMIT, utf8Bytes } from '../../shared/chat/chatInTurnContracts.ts';

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

test('брошенный черновик помечен, больше не живой и не принимает поздние дельты', async (t) => {
  const dir = await tmpDir();
  const messages = new ChatAssistantMessages({ dir, now: () => 1000 });

  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await messages.begin({
    runId: 'fixture-run-0001',
    chatKey: 'fixture-chat',
    assistantMessageId: 'fixture-block-0001',
    sequence: 1,
  });
  messages.setDraft('fixture-run-0001', 'fixture-block-0001', 'Половина отв');

  const abandoned = await messages.abandon('fixture-run-0001', 'fixture-block-0001');

  assert.equal(abandoned.abandoned, true, 'обрыв виден по флагу, а не по догадке');
  assert.equal(abandoned.complete, false);
  assert.equal(messages.live('fixture-run-0001').length, 0, 'брошенный блок уже не пишется');

  messages.setDraft('fixture-run-0001', 'fixture-block-0001', 'Поздняя дельта');
  assert.equal(messages.get('fixture-run-0001', 'fixture-block-0001').text, 'Половина отв');

  const restored = new ChatAssistantMessages({ dir, now: () => 1000 });

  await restored.load();
  assert.equal(restored.get('fixture-run-0001', 'fixture-block-0001').abandoned, true);

  const done = await messages.complete('fixture-run-0001', 'fixture-block-0001', { text: 'Полный ответ' });

  assert.equal(done.complete, true);
  assert.equal(Object.hasOwn(done, 'abandoned'), false, 'позднее завершение снимает отметку обрыва');
});

test('уборка убирает старые брошенные блоки: в историю они не переносятся', async (t) => {
  const dir = await tmpDir();
  let now = 1000;
  const messages = new ChatAssistantMessages({
    dir,
    now: () => now,
    retentionMs: 10,
  });

  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await messages.begin({
    runId: 'fixture-run-0001',
    chatKey: 'fixture-chat',
    assistantMessageId: 'fixture-block-0001',
    sequence: 1,
  });
  await messages.begin({
    runId: 'fixture-run-0001',
    chatKey: 'fixture-chat',
    assistantMessageId: 'fixture-block-0002',
    sequence: 2,
  });
  await messages.abandon('fixture-run-0001', 'fixture-block-0001');
  now = 2000;
  await messages.prune();

  assert.equal(messages.get('fixture-run-0001', 'fixture-block-0001'), null);
  assert.ok(
    messages.get('fixture-run-0001', 'fixture-block-0002'),
    'незавершённый блок после падения не трогаем',
  );
});

test('событие обрыва закрывает черновик с его текстом и публикуется один раз', async (t) => {
  const dir = await tmpDir();
  const messages = new ChatAssistantMessages({ dir });
  const published = [];
  const publisher = new ChatAssistantPublisher({
    messages,
    nextSequence: () => 1,
    onMessage: (block) => published.push(block),
  });

  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const events = [
    ['Начало ответа', false],
    ['Начало ответа', true],
    ['Начало ответа и поздняя дельта', false],
    ['Начало ответа', true],
  ];

  for (const [text, abandoned] of events) {
    await publisher.publish('fixture-run-0001', 'fixture-chat', {
      assistantMessageId: 'fixture-block-0001',
      text,
      sourceRevision: 1,
      complete: false,
      abandoned,
    });
  }

  const block = messages.get('fixture-run-0001', 'fixture-block-0001');

  assert.equal(block.abandoned, true);
  assert.equal(block.text, 'Начало ответа');
  assert.deepEqual(published.map((entry) => [entry.text, entry.abandoned === true]), [
    ['Начало ответа', false],
    ['Начало ответа', true],
  ]);
});

test('конец запуска бросает незакрытые черновики только этого запуска', async (t) => {
  const dir = await tmpDir();
  const messages = new ChatAssistantMessages({ dir });
  const published = [];
  const publisher = new ChatAssistantPublisher({
    messages,
    nextSequence: () => 1,
    onMessage: (block) => published.push(block),
  });

  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const events = [
    ['fixture-run-0001', 'fixture-block-0001', 'Готовая реплика', true],
    ['fixture-run-0001', 'fixture-block-0002', 'Недописанная репл', false],
    ['fixture-run-0002', 'fixture-block-0003', 'Чужой черновик', false],
  ];

  for (const [runId, assistantMessageId, text, complete] of events) {
    void publisher.publish(runId, 'fixture-chat', {
      assistantMessageId,
      text,
      sourceRevision: 1,
      complete,
    });
  }

  await publisher.settleRun('fixture-run-0001');

  assert.equal(messages.get('fixture-run-0001', 'fixture-block-0001').abandoned, undefined);
  assert.equal(messages.get('fixture-run-0001', 'fixture-block-0002').abandoned, true);
  assert.equal(messages.get('fixture-run-0001', 'fixture-block-0002').text, 'Недописанная репл');
  assert.equal(messages.get('fixture-run-0002', 'fixture-block-0003').abandoned, undefined);
  assert.equal(published.at(-1).assistantMessageId, 'fixture-block-0002');
  assert.equal(published.at(-1).abandoned, true);

  const count = published.length;

  await publisher.settleRun('fixture-run-0001');
  assert.equal(published.length, count, 'повторный конец запуска ничего не публикует');
});

/**
 * Публикатор над временным журналом: тест видит и durable-блоки, и всё, что ушло окну.
 * Каталог убирается после теста.
 */
async function publisherFixture(t) {
  const dir = await tmpDir();
  const messages = new ChatAssistantMessages({ dir });
  const published = [];
  const publisher = new ChatAssistantPublisher({
    messages,
    nextSequence: () => 1,
    onMessage: (block) => published.push(block),
  });

  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  return {
    messages,
    published,
    publisher,
  };
}

/** Событие адаптера: по умолчанию незавершённый черновик, поля можно переопределить. */
function draftEvent(assistantMessageId, extra = {}) {
  return {
    assistantMessageId,
    text: 'Текст черновика',
    sourceRevision: 1,
    complete: false,
    ...extra,
  };
}

test('после конца запуска поздний черновик не заводит блок', async (t) => {
  const { messages, published, publisher } = await publisherFixture(t);

  await publisher.settleRun('fixture-run-0001');
  await publisher.publish('fixture-run-0001', 'fixture-chat', draftEvent('fixture-late-0001'));

  assert.equal(messages.get('fixture-run-0001', 'fixture-late-0001'), null, 'блок не заводится');
  assert.deepEqual(published, [], 'окно ничего не получает');
});

test('черновик, пришедший во время конца запуска, не остаётся открытым', async (t) => {
  const { messages, publisher } = await publisherFixture(t);

  await publisher.publish('fixture-run-0001', 'fixture-chat', draftEvent('fixture-open-0001'));

  // settleRun уже бросает первый блок (идёт запись на диск), а адаптер шлёт новую дельту.
  const settling = publisher.settleRun('fixture-run-0001');
  const late = publisher.publish('fixture-run-0001', 'fixture-chat',
    draftEvent('fixture-late-0001'));

  await Promise.all([settling, late]);

  assert.deepEqual(messages.live('fixture-run-0001'), [], 'открытых блоков нет');
  assert.equal(messages.get('fixture-run-0001', 'fixture-late-0001'), null);
  assert.equal(messages.get('fixture-run-0001', 'fixture-open-0001').abandoned, true);
});

test('сторож: после конца запуска итог принимается, обрыв незнакомого блока — нет',
  async (t) => {
    const { messages, published, publisher } = await publisherFixture(t);

    await publisher.settleRun('fixture-run-0001');
    await publisher.publish('fixture-run-0001', 'fixture-chat', draftEvent('fixture-final-0001', {
      text: 'Итог',
      complete: true,
    }));
    await publisher.publish('fixture-run-0001', 'fixture-chat', draftEvent('fixture-gone-0001', {
      abandoned: true,
    }));

    assert.equal(messages.get('fixture-run-0001', 'fixture-final-0001').complete, true);
    assert.equal(messages.get('fixture-run-0001', 'fixture-gone-0001'), null);
    assert.deepEqual(published.map((block) => block.assistantMessageId), ['fixture-final-0001']);
  });

/**
 * Блок журнала прямо на диске — так его оставил прошлый процесс. Текст непустой нарочно:
 * уборка обязана сохранить именно его, а не пустой черновик из памяти нового процесса.
 */
async function writeBlock(dir, runId, assistantMessageId, extra = {}) {
  await fs.mkdir(path.join(dir, runId), { recursive: true });
  await fs.writeFile(path.join(dir, runId, `${assistantMessageId}.json`), JSON.stringify({
    runId,
    chatKey: 'fixture-chat',
    assistantMessageId,
    sequence: 1,
    revision: 1,
    text: 'Начало ответа',
    complete: false,
    startedAt: 1000,
    ...extra,
  }));
}

test('уборка мёртвых запусков бросает их открытые блоки и не трогает живые', async (t) => {
  const dir = await tmpDir();

  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await writeBlock(dir, 'fixture-run-0001', 'fixture-open-0001');
  await writeBlock(dir, 'fixture-run-0001', 'fixture-done-0001', {
    complete: true,
    completedAt: 2000,
  });
  await writeBlock(dir, 'fixture-run-0002', 'fixture-live-0002');

  const messages = new ChatAssistantMessages({ dir });
  const touched = await messages.sweepDeadRuns(new Set(['fixture-run-0002']));
  const open = messages.get('fixture-run-0001', 'fixture-open-0001');
  const onDisk = JSON.parse(await fs.readFile(
    path.join(dir, 'fixture-run-0001', 'fixture-open-0001.json'), 'utf8'));

  assert.deepEqual(touched.map((block) => block.assistantMessageId), ['fixture-open-0001']);
  assert.equal(open.abandoned, true);
  assert.equal(open.complete, false, 'брошенный блок не объявляется полным');
  assert.equal(open.text, 'Начало ответа', 'текст с диска сохраняется');
  assert.equal(onDisk.abandoned, true, 'отметка обязана быть durable');
  assert.equal(messages.get('fixture-run-0001', 'fixture-done-0001').abandoned, undefined);
  assert.equal(messages.get('fixture-run-0002', 'fixture-live-0002').abandoned, undefined);
  assert.deepEqual(await messages.sweepDeadRuns(new Set(['fixture-run-0002'])), [],
    'повторная уборка ничего не меняет');
});

// ── Барьер публикации перед автопродолжением (этап 7 плана) ──
// Перед паузой ядро закрывает недописанные блоки упавшей попытки и ждёт известные
// записи. Ошибку записи барьер не глотает: продолжать модель после неё нельзя.

test('abandonOpen закрывает незавершённый блок и не трогает завершённый', async (t) => {
  const dir = await tmpDir();
  const messages = new ChatAssistantMessages({ dir });
  const published = [];
  const publisher = new ChatAssistantPublisher({
    messages,
    nextSequence: () => 1,
    onMessage: (block) => published.push(block),
  });

  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await publisher.publish('fixture-run-0001', 'fixture-chat', {
    assistantMessageId: 'fixture-block-0001',
    text: 'Готовый ответ',
    sourceRevision: 1,
    complete: true,
  });
  await publisher.publish('fixture-run-0001', 'fixture-chat', {
    assistantMessageId: 'fixture-block-0002',
    text: 'Половина отв',
    sourceRevision: 2,
  });
  published.length = 0;
  await publisher.abandonOpen('fixture-run-0001');

  const abandoned = published.filter((block) => block.abandoned);

  assert.equal(abandoned.length, 1, 'брошен ровно один блок');
  assert.equal(abandoned[0].assistantMessageId, 'fixture-block-0002');
  assert.equal(abandoned[0].complete, false);
  assert.equal(messages.get('fixture-run-0001', 'fixture-block-0001').complete, true);
  assert.equal(publisher.errors.has('fixture-run-0001'), false, 'карта ошибок не очищена');
});

test('abandonOpen не дублирует событие брошенного блока', async (t) => {
  const dir = await tmpDir();
  const messages = new ChatAssistantMessages({ dir });
  const published = [];
  const publisher = new ChatAssistantPublisher({
    messages,
    nextSequence: () => 1,
    onMessage: (block) => published.push(block),
  });

  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await publisher.publish('fixture-run-0001', 'fixture-chat', {
    assistantMessageId: 'fixture-block-0001',
    text: 'Черновик',
    sourceRevision: 1,
  });
  await publisher.abandonOpen('fixture-run-0001');
  await publisher.abandonOpen('fixture-run-0001');

  assert.equal(published.filter((block) => block.abandoned).length, 1);
});

test('ошибка завершившейся записи видна после abandonOpen', async (t) => {
  const dir = await tmpDir();
  const file = path.join(dir, 'not-a-directory');

  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(file, 'Каталог недоступен');

  const publisher = new ChatAssistantPublisher({
    messages: new ChatAssistantMessages({ dir: file }),
    nextSequence: () => 1,
    onMessage: () => {},
  });

  void publisher.publish('fixture-run-0001', 'fixture-chat', {
    assistantMessageId: 'fixture-block-0001',
    text: 'Ответ',
    sourceRevision: 1,
    complete: true,
  }).catch(() => {});

  await publisher.abandonOpen('fixture-run-0001').catch(() => {});

  await assert.rejects(
    () => publisher.flush('fixture-run-0001'),
    /ENOTDIR|not a directory|Каталог/u,
    'ошибка записи не теряется барьером',
  );
});

test('abandonOpen ждёт удержанную запись и не мешает следующей попытке', async (t) => {
  const dir = await tmpDir();
  const messages = new ChatAssistantMessages({ dir });
  const original = messages.complete.bind(messages);
  let release = null;
  const held = new Promise((resolve) => {
    release = resolve;
  });

  messages.complete = async (...args) => {
    await held;

    return original(...args);
  };

  const published = [];
  const publisher = new ChatAssistantPublisher({
    messages,
    nextSequence: () => 1,
    onMessage: (block) => published.push(block),
  });

  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const writing = publisher.publish('fixture-run-0001', 'fixture-chat', {
    assistantMessageId: 'fixture-block-0001',
    text: 'Держится',
    sourceRevision: 1,
    complete: true,
  });
  let barrierDone = false;
  const barrier = publisher.abandonOpen('fixture-run-0001').then(() => {
    barrierDone = true;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(barrierDone, false, 'барьер не прошёл мимо удержанной записи');

  release();
  await Promise.all([writing.catch(() => {}), barrier]);

  assert.equal(barrierDone, true);

  // Следующая попытка того же запуска пишет новый блок и завершает его.
  await publisher.publish('fixture-run-0001', 'fixture-chat', {
    assistantMessageId: 'fixture-block-0002',
    text: 'Новая попытка',
    sourceRevision: 2,
    complete: true,
  });

  const fresh = messages.get('fixture-run-0001', 'fixture-block-0002');

  assert.equal(fresh.complete, true);
  assert.equal(published.some((block) => block.assistantMessageId === 'fixture-block-0002'), true);
});
