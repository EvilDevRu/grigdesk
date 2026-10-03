// Конец запуска закрывает черновики реплик любого исполнителя.
//
// Адаптер может не дописать реплику: обрыв потока, ошибка, стоп. После конца запуска
// текст уже не придёт, и окно не должно держать «Пишет…» ни у одного исполнителя.
import assert from 'node:assert/strict';
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
