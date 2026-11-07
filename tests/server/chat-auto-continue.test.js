// Автопродолжение в НАСТОЯЩЕМ ядре чата: один ход, один turnId/runId, один pending,
// один финал. Исполнитель управляется тестом — проверяется оркестрация, а не транспорт.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chatAppFixture,
  controlledExecutor,
  saveChat,
  turnBody,
  waitFor,
} from './helpers/chat-turns.js';

const DELAYS = Object.freeze({
  network: [5, 5, 5],
  server_error: [5, 5, 5],
  overloaded: [5, 5, 5],
  rate_limited: [5, 5, 5],
});

// Провал доставки так, как его отдаёт адаптер: явное подтверждение Р2 обязательно.
function deliveryFailure(message = 'API Error: Connection error.', extra = {}) {
  return {
    reply: message,
    deliveryFailure: true,
    turnRecovery: { canContinue: true, madeProgress: false },
    ...extra,
  };
}

/**
 * Исполнитель, который отвечает по сценарию теста: каждый запуск отдаёт свой результат.
 * Сценарий — массив описаний: текст ответа, провал доставки или исключение.
 */
function scriptedExecutor(script) {
  const runs = [];
  const waiters = new Set();

  /**
   * Будит ожидающих, когда запусков стало достаточно: тест получает первые `count`
   * запусков в порядке старта, как их увидел исполнитель.
   */
  function wake() {
    for (const waiter of [...waiters]) {
      if (runs.length >= waiter.count) {
        waiters.delete(waiter);
        waiter.resolve(runs.slice(0, waiter.count));
      }
    }
  }

  const executor = {
    id: 'test-provider',
    /**
     * Один запуск по сценарию: отдаёт результат, провал доставки или исключение.
     * Записывает, что именно ушло в модель — по этому тест и проверяет продолжение.
     */
    async run(options) {
      const index = runs.length;
      const step = script[index] || { reply: `Ответ ${index + 1}` };
      const run = {
        message: String(options.message || ''),
        sessionId: options.sessionId ?? null,
        attachments: options.attachmentPaths || [],
      };

      runs.push(run);

      for (const item of step.steps || []) {
        options.onStep?.(item);
      }

      await options.onSessionCreated?.('sess-1');

      if (step.throw) {
        throw Object.assign(new Error(step.throw), {
          steps: step.exceptionSteps,
          ...(step.stopped ? { stopped: true } : {}),
        });
      }

      wake();

      return {
        sessionId: 'sess-1',
        steps: step.steps || [],
        cost: step.cost === undefined ? 0 : step.cost,
        ...step.result,
      };
    },
  };

  return {
    executor,
    runs,
    waitForRuns(count, timeoutMs = 5000) {
      if (runs.length >= count) {
        return Promise.resolve(runs.slice(0, count));
      }

      return new Promise((resolve, reject) => {
        const waiter = { count, resolve };
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`исполнитель получил ${runs.length} запусков из ${count}`));
        }, timeoutMs);

        waiter.resolve = (value) => {
          clearTimeout(timer);
          resolve(value);
        };
        waiters.add(waiter);
      });
    },
  };
}

async function fixture(t, script, prefs = {}) {
  const controlled = scriptedExecutor(script);

  const app = await chatAppFixture(t, {
    executor: controlled.executor,
    prefs,
    autoContinueDelaysMs: DELAYS,
  });

  return { ...controlled, ...app };
}

function pendingOf(app, chatKey) {
  return app.inject({ method: 'GET', url: `/api/chat/pending?chatKey=${chatKey}` });
}

test('сбой после работы: просьба продолжить, один ход и один итог', async (t) => {
  const f = await fixture(t, [
    {
      steps: [{
        k: 'tool',
        id: 't1',
        name: 'Bash',
        text: 'ls',
      }],
      result: deliveryFailure(),
    },
    {
      steps: [{ k: 'text', text: 'Доделал.' }],
      result: { reply: 'Доделал.' },
    },
  ]);

  await saveChat(f.app, 'chat-ac');

  const accepted = await f.app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody('chat-ac', 'turn-ac-0001', 'исходный запрос'),
  });

  assert.equal(accepted.statusCode, 202);

  const runs = await f.waitForRuns(2);

  assert.equal(runs[1].message.includes('Предыдущая попытка завершилась временным сбоем'), true,
    'автоматика шлёт только просьбу продолжить');
  assert.equal(runs[1].message.includes('исходный запрос'), false, 'исходный запрос не повторяется');
  assert.equal(runs[1].sessionId, 'sess-1', 'продолжение идёт в ту же сессию');
  assert.deepEqual(runs[1].attachments, [], 'вложения повторно не отправляются');

  const pending = await waitFor(async () => {
    const response = await pendingOf(f.app, 'chat-ac');
    const body = response.json();

    return body?.pending?.length ? body : null;
  }, { what: 'итог хода в pending' });

  assert.equal(pending.pending.length, 1, 'единственный финальный pending');

  const turn = pending.pending[0];

  assert.equal(turn.turnId, 'turn-ac-0001', 'тот же turnId');
  assert.match(String(turn.reply), /Доделал/u);
  assert.equal(turn.autoContinued, 1);
  assert.equal(turn.deliveryFailure, undefined, 'успешное продолжение не помечено сбоем');
});

test('сбой без работы: исходный текст и вложения не подставляются', async (t) => {
  const f = await fixture(t, [
    { steps: [], result: deliveryFailure() },
    { steps: [{ k: 'text', text: 'Продолжил.' }], result: { reply: 'Продолжил.' } },
  ]);

  await saveChat(f.app, 'chat-empty');
  await f.app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody('chat-empty', 'turn-empty-0001', 'исходный запрос', {
      attachments: [{ file: 'missing.png' }],
    }),
  });

  const runs = await f.waitForRuns(2);

  assert.equal(runs[1].message.includes('исходный запрос'), false);
  assert.deepEqual(runs[1].attachments, []);
  assert.equal(runs[1].message.includes('Предыдущая попытка'), true);
});

test('сбои без работы: три продолжения по бюджету вида, exhausted и три заметки', async (t) => {
  // Первый запуск — исходная попытка, следующие три — начатые продолжения. Четвёртая
  // колонка пауз отсутствует, поэтому после третьего продолжения цепочка исчерпана.
  const failing = () => ({ steps: [], result: deliveryFailure() });
  const f = await fixture(t, [failing(), failing(), failing(), failing()]);

  await saveChat(f.app, 'chat-four');
  await f.app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody('chat-four', 'turn-four-0001', 'исходный запрос'),
  });

  await f.waitForRuns(3);
  await waitFor(() => f.runs.length >= 3 && true, { what: 'три запуска' });

  const pending = await waitFor(async () => {
    const response = await pendingOf(f.app, 'chat-four');
    const body = response.json();

    return body?.pending?.length ? body : null;
  }, { what: 'итог исчерпанной цепочки' });

  const turn = pending.pending[0];
  const notes = (turn.steps || []).filter((step) => step.k === 'note'
    && String(step.text).includes('Сбой хода'));

  assert.equal(f.runs.length, 4, 'исходная попытка плюс ровно три продолжения');
  assert.equal(turn.autoContinued, 3, 'в итоге считаются только начатые продолжения');
  assert.match(String(turn.reply), /Автопродолжение не помогло/u);
  assert.equal(notes.length, 3, 'по одной заметке на каждую паузу');
  assert.deepEqual(turn.steps.slice(0, 3), notes, 'заметки идут в исходном порядке');
});

test('окончательный отказ не продолжается', async (t) => {
  const f = await fixture(t, [
    {
      steps: [],
      result: deliveryFailure('API Error: 401 Unauthorized', {
        turnFailure: { code: 'authentication_failed', message: 'API Error: 401 Unauthorized' },
      }),
    },
  ]);

  await saveChat(f.app, 'chat-auth');
  await f.app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody('chat-auth', 'turn-auth-0001', 'исходный запрос'),
  });
  await f.waitForRuns(1);

  const pending = await waitFor(async () => {
    const response = await pendingOf(f.app, 'chat-auth');
    const body = response.json();

    return body?.pending?.length ? body : null;
  }, { what: 'итог отказа' });

  const turn = pending.pending[0];

  await new Promise((resolve) => {
    setTimeout(resolve, 60);
  });

  assert.equal(f.runs.length, 1, 'второго запуска нет');
  assert.equal(turn.autoContinued, 0);
  assert.match(String(turn.reply), /Сам не продолжаю/u);
  assert.equal(turn.interruptedBy, undefined, 'кнопки продолжения нет');
});

test('без подтверждения Р2 автоматика молчит, но кнопка остаётся', async (t) => {
  const f = await fixture(t, [
    { steps: [], result: { reply: 'API Error: Connection error.', deliveryFailure: true } },
  ]);

  await saveChat(f.app, 'chat-no-r2');
  await f.app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody('chat-no-r2', 'turn-r2-0001', 'исходный запрос'),
  });
  await f.waitForRuns(1);

  const pending = await waitFor(async () => {
    const response = await pendingOf(f.app, 'chat-no-r2');
    const body = response.json();

    return body?.pending?.length ? body : null;
  }, { what: 'итог без Р2' });

  const turn = pending.pending[0];

  await new Promise((resolve) => {
    setTimeout(resolve, 60);
  });

  assert.equal(f.runs.length, 1, 'автоматика не запускалась');
  assert.equal(turn.autoContinued, 0);
  assert.match(String(turn.reply), /Автопродолжение недоступно/u);
  assert.equal(turn.interruptedBy, 'delivery_failure', 'контекст сохранён — окно даёт кнопку');
});

test('выключатель запрещает автоматику', async (t) => {
  const f = await fixture(
    t,
    [{ steps: [], result: deliveryFailure() }],
    { chatAutoContinue: false },
  );

  await saveChat(f.app, 'chat-off');
  await f.app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody('chat-off', 'turn-off-0001', 'исходный запрос'),
  });
  await f.waitForRuns(1);

  const pending = await waitFor(async () => {
    const response = await pendingOf(f.app, 'chat-off');
    const body = response.json();

    return body?.pending?.length ? body : null;
  }, { what: 'итог при выключенной настройке' });

  await new Promise((resolve) => {
    setTimeout(resolve, 60);
  });

  assert.equal(f.runs.length, 1, 'продолжений нет');
  assert.match(String(pending.pending[0].reply), /Автопродолжение выключено в настройках/u);
});

test('сообщение человека в паузе отменяет продолжение и исполняется само', async (t) => {
  const f = await fixture(t, [
    {
      steps: [{
        k: 'tool',
        id: 't1',
        name: 'Bash',
        text: 'ls',
      }],
      result: deliveryFailure(),
    },
    { steps: [], result: { reply: 'Ответ на новое сообщение' } },
  ]);

  await saveChat(f.app, 'chat-yield');
  await f.app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody('chat-yield', 'turn-yield-0001', 'первое сообщение'),
  });
  await f.waitForRuns(1);

  // Второе сообщение приходит ровно в паузу: оно имеет приоритет.
  const second = await f.app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody('chat-yield', 'turn-yield-0002', 'второе сообщение'),
  });

  assert.equal(second.statusCode, 202);

  const runs = await f.waitForRuns(2);

  assert.equal(runs[1].message.startsWith('второе сообщение'), true,
    'исполняется сообщение человека, а не автопродолжение');
  assert.equal(runs.some((run) => run.message.includes('Предыдущая попытка')), false,
    'автопродолжения не было');
});

test('«Стоп» в паузе останавливает цепочку', async (t) => {
  const f = await fixture(t, [
    {
      steps: [{
        k: 'tool',
        id: 't1',
        name: 'Bash',
        text: 'ls',
      }],
      result: deliveryFailure(),
    },
  ]);
  const ac = new AbortController();

  await saveChat(f.app, 'chat-stop');
  await f.app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody('chat-stop', 'turn-stop-0001', 'первое сообщение'),
  });
  await f.waitForRuns(1);

  ac.abort();
  await f.app.inject({
    method: 'POST',
    url: '/api/chat/stop',
    payload: { chatKey: 'chat-stop' },
  });

  const pending = await waitFor(async () => {
    const response = await pendingOf(f.app, 'chat-stop');
    const body = response.json();

    return body?.pending?.length ? body : null;
  }, { what: 'итог остановленного хода' });

  const turn = pending.pending[0];

  assert.equal(turn.stopped, true, 'ход остановлен человеком');
  assert.equal(turn.autoContinued === undefined || turn.autoContinued === 0, true);
  assert.equal(f.runs.length, 1, 'автопродолжение не началось');
});
