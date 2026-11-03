import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import test from 'node:test';

import {
  chatAppFixture,
  controlledExecutor,
  saveChat,
  turnBody,
  waitFor,
} from './helpers/chat-turns.js';

/**
 * Итог и конец хода должны появиться до старта следующего сообщения из очереди.
 * Запись pending читается отдельно: событие не заменяет устойчивый ответ.
 */
async function finishedTurn(app, events, turnId) {
  await waitFor(() => events.some((entry) => entry.event === 'chat-done' && entry.data.turnId === turnId));

  const pending = (await app.inject('/api/chat/pending')).json().pending;

  return pending.find((entry) => entry.turnId === turnId);
}

test('сбой подготовки закрывается до следующего запуска и сохраняет порядок очереди', async (t) => {
  const control = controlledExecutor();

  control.executor.workToolsTransport = 'mcp';

  const { app, events } = await chatAppFixture(t, { executor: control.executor });

  await saveChat(app, 'queue-chat');

  const mkdtemp = fs.mkdtemp;
  let failPreparation;
  let preparing = false;

  t.mock.method(fs, 'mkdtemp', (prefix, ...args) => {
    if (String(prefix).includes('grigdesk-work-') && !preparing) {
      preparing = true;

      return new Promise((_resolve, reject) => {
        failPreparation = () => reject(Object.assign(new Error('дисковая квота'), { code: 'EDQUOT' }));
      });
    }

    return mkdtemp(prefix, ...args);
  });

  const firstId = 'turn-preparation-0001';
  const secondId = 'turn-preparation-0002';
  const first = await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody('queue-chat', firstId),
  });

  assert.equal(first.statusCode, 202, first.body);
  await waitFor(() => failPreparation);

  const second = await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody('queue-chat', secondId),
  });

  assert.equal(second.json().state, 'queued');
  failPreparation();

  const failed = await finishedTurn(app, events, firstId);

  assert.equal(failed.role, 'error');
  assert.match(failed.reply, /EDQUOT/);
  assert.match(failed.reply, /квот/);
  await control.waitForRuns(1);

  const doneAt = events.findIndex((entry) => entry.event === 'chat-done' && entry.data.turnId === firstId);
  const startAt = events.findIndex((entry) => entry.event === 'chat-turn-start'
    && entry.data.turnId === secondId);

  assert.ok(doneAt < startAt, 'конец отказавшего хода не гасит следующий запуск');
  assert.equal(events[doneAt].data.queued, 1);
  assert.equal(events.some((entry) => entry.event === 'chat-turn-start'
    && entry.data.turnId === firstId), false, 'подготовка не выдаётся за запуск агента');

  const turn = (await app.inject(`/api/chat/turns?ids=${firstId}`)).json().turns[firstId];

  assert.equal(turn.state, 'done');
  assert.equal(turn.outcome, 'error');
  control.runs[0].release('Следующий ход выполнен');
  await finishedTurn(app, events, secondId);
  assert.equal(events.filter((entry) => entry.event === 'chat-done').length, 2);
});

test('явный отказ подготовки тоже сообщает о завершении принятого хода', async (t) => {
  const control = controlledExecutor();

  control.executor.prepareRuntime = async () => {
    throw new Error('runtime недоступен');
  };

  const { app, events } = await chatAppFixture(t, { executor: control.executor });
  const turnId = 'turn-preparation-refused';

  await saveChat(app, 'refused-chat');
  await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody('refused-chat', turnId),
  });

  const failed = await finishedTurn(app, events, turnId);

  assert.equal(failed.role, 'error');
  assert.equal(failed.reply, 'Не удалось подготовить runtime исполнителя');
  assert.equal(control.runs.length, 0);
  assert.equal(events.filter((entry) => entry.event === 'chat-done').length, 1);
});

test('синхронный ход получает понятную ошибку доступа при подготовке', async (t) => {
  const control = controlledExecutor();

  control.executor.workToolPolicy = () => {
    throw Object.assign(new Error('EACCES: permission denied, /private/path'), { code: 'EACCES' });
  };

  const { app } = await chatAppFixture(t, { executor: control.executor });

  await saveChat(app, 'legacy-chat');

  const payload = turnBody('legacy-chat', 'unused-turn');

  delete payload.turnId;

  const response = await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload,
  });

  assert.equal(response.statusCode, 500);
  assert.match(response.json().message, /прав доступа/);
  assert.match(response.json().message, /EACCES/);
  assert.equal(response.json().message.includes('/private/path'), false);
  assert.equal(control.runs.length, 0);
});

test('неизвестная ошибка подготовки сохраняет причину и завершает ход', async (t) => {
  const control = controlledExecutor();

  control.executor.workToolPolicy = () => {
    throw new Error('Не удалось подготовить инструменты');
  };

  const { app, events } = await chatAppFixture(t, { executor: control.executor });
  const turnId = 'turn-preparation-unknown';

  await saveChat(app, 'unknown-chat');
  await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody('unknown-chat', turnId),
  });

  const failed = await finishedTurn(app, events, turnId);

  assert.equal(failed.reply, 'Ход не выполнен: Не удалось подготовить инструменты.');
  assert.equal(control.runs.length, 0);
});

test('системная ошибка уже запущенного исполнителя сохраняет шаги и завершается один раз', async (t) => {
  const control = controlledExecutor();

  control.executor.run = async (input) => {
    input.onStep({
      k: 'text',
      text: 'Проверяю файлы',
      at: Date.now(),
    });

    throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' });
  };

  const { app, events } = await chatAppFixture(t, { executor: control.executor });
  const turnId = 'turn-executor-system-error';

  await saveChat(app, 'executor-chat');
  await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody('executor-chat', turnId),
  });

  const failed = await finishedTurn(app, events, turnId);

  assert.equal(failed.role, 'error');
  assert.match(failed.reply, /только для чтения/);
  assert.match(failed.reply, /EROFS/);
  assert.equal(failed.steps[0].text, 'Проверяю файлы');
  assert.equal(events.filter((entry) => entry.event === 'chat-done').length, 1);
  assert.deepEqual((await app.inject('/api/chat/active')).json().active, []);
});
