// Конец запуска закрывает черновики реплик любого исполнителя.
//
// Адаптер может не дописать реплику: обрыв потока, ошибка, стоп. После конца запуска
// текст уже не придёт, и окно не должно держать «Пишет…» ни у одного исполнителя.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  chatAppFixture,
  controlledExecutor,
  saveChat,
  turnBody,
  waitFor,
} from './helpers/chat-turns.js';

/**
 * Ход с одним незакрытым черновиком: исполнитель публикует начало реплики и
 * завершается так, как велит тест. Возвращает события блока этого черновика.
 */
async function runWithDraft(t, finish) {
  const { executor, waitForRuns } = controlledExecutor();
  const { app, events } = await chatAppFixture(t, { executor });

  await saveChat(app, 'chat-fixture');

  const started = await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody('chat-fixture', 'turn-fixture-d001', 'Проверь файл'),
  });

  assert.equal(started.statusCode, 202, started.body);

  const [run] = await waitForRuns(1);

  await run.options.onAssistantMessage({
    assistantMessageId: 'assistant-fixture-d001',
    text: 'Начало отв',
    sourceRevision: 1,
    complete: false,
  });
  finish(run);
  await waitFor(() => events.some((entry) => entry.event === 'chat-done'), { what: 'конец хода' });

  return events
    .filter((entry) => entry.event === 'chat-assistant-message')
    .map((entry) => entry.data.block)
    .filter((block) => block.assistantMessageId === 'assistant-fixture-d001');
}

test('ошибка исполнителя закрывает его черновик как оборванный', async (t) => {
  const blocks = await runWithDraft(t, (run) => run.fail('поток оборвался'));

  assert.equal(blocks.at(-1).abandoned, true);
  assert.equal(blocks.at(-1).complete, false);
  assert.equal(blocks.at(-1).text, 'Начало отв');
});

test('успешный ход без завершения реплики тоже не оставляет «Пишет…»', async (t) => {
  const blocks = await runWithDraft(t, (run) => run.release('Итог'));

  assert.equal(blocks.at(-1).abandoned, true);
  assert.equal(blocks.at(-1).text, 'Начало отв');
});

test('поздний колбэк исполнителя после конца хода не заводит блок', async (t) => {
  const { executor, waitForRuns } = controlledExecutor();
  const { app, events, root } = await chatAppFixture(t, { executor });

  await saveChat(app, 'chat-fixture');

  const started = await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody('chat-fixture', 'turn-fixture-d002', 'Проверь файл'),
  });

  assert.equal(started.statusCode, 202, started.body);

  const [run] = await waitForRuns(1);

  await run.options.onAssistantMessage({
    assistantMessageId: 'assistant-fixture-d002',
    text: 'Начало ответа',
    sourceRevision: 1,
    complete: false,
  });
  run.release('Итог');
  await waitFor(() => events.some((entry) => entry.event === 'chat-done'), { what: 'конец хода' });

  const done = events.find((entry) => entry.event === 'chat-done');
  const doneAt = events.indexOf(done);

  // Колбэк пришёл уже после конца хода. Ждём сам publish: он и делает запись на диск.
  await run.options.onAssistantMessage({
    assistantMessageId: 'assistant-fixture-late1',
    text: 'Поздняя дельта',
    sourceRevision: 1,
    complete: false,
  });

  const late = events.slice(doneAt)
    .filter((entry) => entry.event === 'chat-assistant-message')
    .map((entry) => entry.data.block);
  const dir = path.join(root, 'chats', 'in-turn-assistant', done.data.runId);
  const draft = JSON.parse(await fs.readFile(path.join(dir, 'assistant-fixture-d002.json'), 'utf8'));

  assert.deepEqual(late.filter((block) => block.complete === false && !block.abandoned), [],
    'после конца хода окно не получает открытых блоков');
  assert.equal(draft.abandoned, true, 'черновик хода брошен концом хода');
  await assert.rejects(fs.access(path.join(dir, 'assistant-fixture-late1.json')),
    { code: 'ENOENT' }, 'поздняя дельта не заводит блок на диске');
});

test('после падения сервера открытый блок прошлого процесса брошен на старте', async (t) => {
  const first = controlledExecutor();
  const crashed = await chatAppFixture(t, { executor: first.executor });

  await saveChat(crashed.app, 'chat-fixture');

  const started = await crashed.app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody('chat-fixture', 'turn-fixture-d004', 'Проверь файл'),
  });

  assert.equal(started.statusCode, 202, started.body);

  const [run] = await first.waitForRuns(1);

  await run.options.onAssistantMessage({
    assistantMessageId: 'assistant-fixture-d004',
    text: 'Начало отв',
    sourceRevision: 1,
    complete: false,
  });

  const { runId } = crashed.events.find((entry) => entry.event === 'chat-assistant-message').data;
  const file = path.join(crashed.root, 'chats', 'in-turn-assistant', runId,
    'assistant-fixture-d004.json');

  // Падение: ход не закончился, блок на диске открыт. Новый процесс поднимается на том же root.
  await chatAppFixture(t, { executor: controlledExecutor().executor, root: crashed.root });

  const block = JSON.parse(await fs.readFile(file, 'utf8'));

  assert.equal(block.abandoned, true, 'запуск прошлого процесса мёртв — блок брошен');
  assert.equal(block.complete, false, 'брошенный блок не объявляется полным');
});

test('сторож: «Стоп» посреди реплики закрывает её черновик как оборванный', async (t) => {
  const { executor, waitForRuns } = controlledExecutor();
  const { app, events } = await chatAppFixture(t, { executor });

  await saveChat(app, 'chat-fixture');

  const started = await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody('chat-fixture', 'turn-fixture-d003', 'Проверь файл'),
  });

  assert.equal(started.statusCode, 202, started.body);

  const [run] = await waitForRuns(1);

  await run.options.onAssistantMessage({
    assistantMessageId: 'assistant-fixture-d003',
    text: 'Начало отв',
    sourceRevision: 1,
    complete: false,
  });

  const stopped = await app.inject({
    method: 'POST',
    url: '/api/chat/stop',
    payload: { chatKey: 'chat-fixture' },
  });

  assert.equal(stopped.json().ok, true, stopped.body);
  await waitFor(() => events.some((entry) => entry.event === 'chat-done'), { what: 'конец хода' });

  const blocks = events
    .filter((entry) => entry.event === 'chat-assistant-message')
    .map((entry) => entry.data.block)
    .filter((block) => block.assistantMessageId === 'assistant-fixture-d003');

  assert.equal(blocks.at(-1).abandoned, true);
  assert.equal(blocks.at(-1).complete, false);
  assert.equal(blocks.at(-1).text, 'Начало отв');
});
