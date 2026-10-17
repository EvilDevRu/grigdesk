import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTO_CONTINUE_PROMPT,
  autoContinueNote,
  continueAfterFailures,
  createContinueGate,
  deliveryFailureView,
} from '../../server/src/lib/chat/autoContinue.ts';

// Петля автопродолжения: решения принимаются по результату адаптера, а не по ленте UI.
// Таймеры и барьеры здесь управляемые — реальные минуты ожидания в тестах не нужны.

// ── Стенд ──────────────────────────────────────────────────────────────────

// Ручной планировщик: хранит callback и запускает его только по явной команде.
function manualScheduler() {
  const pending = [];

  return {
    setTimeout(callback, ms) {
      const timer = {
        callback,
        ms,
      };

      pending.push(timer);

      return timer;
    },
    clearTimeout(timer) {
      const index = pending.indexOf(timer);

      if (index >= 0) {
        pending.splice(index, 1);
      }
    },
    /**
     * Запускает самый ранний запланированный callback ровно один раз и возвращает
     * запрошенную задержку. Тест сам решает, когда «время вышло».
     */
    fire() {
      const timer = pending.shift();

      assert.ok(timer, 'нет запланированного таймера');

      timer.callback();

      return timer.ms;
    },
    get size() {
      return pending.length;
    },
  };
}

// Барьер подготовки: отпускается тестом ровно тогда, когда нужна гонка.
function deferred() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });

  return {
    promise,
    release,
  };
}

function note(text) {
  return {
    k: 'note',
    text,
    at: 1,
  };
}

function textStep(text) {
  return {
    k: 'text',
    text,
    at: 1,
  };
}

// Успешный результат новой попытки.
function success({ reply = 'готово', sessionId = 's1', steps = [], cost = null } = {}) {
  return {
    reply,
    sessionId,
    steps,
    cost,
  };
}

/**
 * Результат со сбоем доставки. turnRecovery задаётся ЯВНО: лента шагов ничего не решает.
 * `signal` — готовый turnFailure адаптера; без него сигналом становится текст ответа,
 * который общие слова распознают как сеть, то есть как продолжаемый сбой.
 */
function failure({
  reply = 'API Error: Connection error.',
  sessionId = 's1',
  canContinue = true,
  madeProgress = false,
  steps = [],
  cost = null,
  signal,
} = {}) {
  return {
    reply,
    sessionId,
    steps,
    cost,
    deliveryFailure: true,
    turnRecovery: {
      canContinue,
      madeProgress,
    },
    ...(signal ? { turnFailure: signal } : {}),
  };
}

/**
 * Прогон петли с записью попыток: что реально ушло в модель, какие заметки опубликованы.
 * Сценарий — массив результатов/исключений по номеру ВЫЗОВА, а не по номеру сбоя.
 */
async function run(options, initial, script) {
  const calls = [];
  const notes = [];

  const result = await continueAfterFailures(initial, {
    isEnabled: () => true,
    continueMessage: AUTO_CONTINUE_PROMPT,
    delaysMs: { network: [10, 20, 30] },
    openWait: () => options.scope,
    hasQueued: () => options.queued === true,
    beforeWait: options.beforeWait || (async () => {}),
    publishNote: (step) => notes.push(step),
    onSummary: () => {},
    run: async (input) => {
      const attempt = script[calls.length];

      calls.push({
        message: input.message,
        sessionId: input.sessionId,
      });

      if (typeof attempt === 'function') {
        return attempt(input);
      }

      if (attempt instanceof Error) {
        throw attempt;
      }

      return attempt;
    },
    attemptSteps: () => options.attemptSteps || [],
    ...(options.maxContinuations ? { maxContinuations: options.maxContinuations } : {}),
    ...(options.extra || {}),
  });

  return {
    result,
    calls,
    notes,
  };
}

/**
 * Прогон, который ОБЯЗАН упасть: возвращает ошибку и записанные попытки.
 * Упавшая попытка не должна оставаться необработанным промисом — тест обязан
 * дождаться её исхода, поэтому здесь один await, а не assert.rejects с промисом.
 */
async function runReject(options, initial, script) {
  try {
    const settled = await run(options, initial, script);

    assert.fail(`ожидалась ошибка, получен результат ${JSON.stringify(settled.result)}`);
  } catch (error) {
    if (error?.code === 'ERR_ASSERTION' && error?.operator === 'fail') {
      throw error;
    }

    return error;
  }
}

/**
 * Простейшая область отмены: ожидание сразу истекло. Сигнал всё равно слушается —
 * «Стоп» приходит именно им, и заглушка, игнорирующая его, скрыла бы эту ветку.
 */
function idleScope(signal = null) {
  let cancelReason = signal?.aborted ? 'aborted' : null;

  signal?.addEventListener('abort', () => {
    cancelReason = cancelReason || 'aborted';
  }, { once: true });

  return {
    wait: async () => cancelReason || 'elapsed',
    status: () => cancelReason,
    cancel: (reason) => {
      cancelReason = cancelReason || reason;
    },
    dispose: () => {},
  };
}

// ── Петля ──────────────────────────────────────────────────────────────────

test('обычный успех: та же ссылка, петля ничего не трогает', async () => {
  const initial = success();
  let opens = 0;
  let runs = 0;

  const result = await continueAfterFailures(initial, {
    isEnabled: () => true,
    continueMessage: AUTO_CONTINUE_PROMPT,
    openWait: () => {
      opens += 1;

      return idleScope();
    },
    hasQueued: () => false,
    beforeWait: async () => {},
    publishNote: () => {},
    onSummary: () => {},
    run: async () => {
      runs += 1;

      return success();
    },
    attemptSteps: () => [],
  });

  assert.equal(result, initial, 'успех возвращается той же ссылкой');
  assert.equal(runs, 0);
  assert.equal(opens, 0);
});

test('переходная ошибка: просьба продолжить, та же сессия, recovered', async () => {
  const { result, calls } = await run(
    { scope: idleScope() },
    failure(),
    [success({ reply: 'доделал', sessionId: 's1' })],
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].message, AUTO_CONTINUE_PROMPT, 'только просьба продолжить');
  assert.equal(calls[0].sessionId, 's1', 'та же сохранённая сессия');
  assert.equal(result.reply, 'доделал');
  assert.equal(result.autoContinued, 1);
  assert.equal(result.autoContinueOutcome, 'recovered');
});

test('пустые steps не мешают продолжению и не подставляют исходный запрос', async () => {
  const { result, calls } = await run(
    { scope: idleScope() },
    failure({ steps: [], madeProgress: false }),
    [success()],
  );

  assert.equal(calls.length, 1, 'отсутствие шагов ничего не доказывает');
  assert.equal(calls[0].message, AUTO_CONTINUE_PROMPT);
  assert.equal(result.autoContinueOutcome, 'recovered');
});

test('четыре сбоя без продвижения: три продолжения, растущие паузы, exhausted', async () => {
  const delays = [];
  const fails = [failure(), failure(), failure(), failure()];
  let index = 0;

  const { result, notes } = await run(
    {
      scope: {
        wait: async (ms) => {
          delays.push(ms);

          return 'elapsed';
        },
        status: () => null,
        cancel: () => {},
        dispose: () => {},
      },
    },
    fails[0],
    [
      () => fails[++index],
      () => fails[++index],
      () => fails[++index],
      () => fails[++index],
    ],
  );

  assert.deepEqual(delays, [10, 20, 30]);
  assert.equal(result.autoContinued, 3);
  assert.equal(result.autoContinueOutcome, 'exhausted');
  assert.equal(notes.length, 3, 'три заметки паузы');
});

test('реальная работа между сбоями сбрасывает серию пауз только по madeProgress', async () => {
  const delays = [];

  const { result } = await run(
    {
      scope: {
        wait: async (ms) => {
          delays.push(ms);

          return 'elapsed';
        },
        status: () => null,
        cancel: () => {},
        dispose: () => {},
      },
    },
    failure(),
    [
      () => failure({ madeProgress: true }),
      () => failure(),
      () => success(),
    ],
  );

  // Серия без продвижения набирается только там, где его не подтвердили: после
  // madeProgress true индекс снова нулевой, поэтому третья пауза начинается с 10 с.
  assert.deepEqual(delays, [10, 10, 20], 'продвижение обнуляет индекс паузы');
  assert.equal(result.autoContinued, 3);
});

test('без подтверждённого продвижения пауза растёт со второй попытки', async () => {
  const delays = [];

  const { result } = await run(
    {
      scope: {
        wait: async (ms) => {
          delays.push(ms);

          return 'elapsed';
        },
        status: () => null,
        cancel: () => {},
        dispose: () => {},
      },
    },
    failure(),
    [() => failure(), () => failure(), () => failure()],
  );

  assert.deepEqual(delays, [10, 20, 30], 'индекс серии растёт без продвижения');
  assert.equal(result.autoContinueOutcome, 'exhausted');
});

test('потолок начатых продолжений: одиннадцатый вызов не начинается', async () => {
  let runs = 0;
  let queue = failure();

  const result = await continueAfterFailures(queue, {
    isEnabled: () => true,
    continueMessage: AUTO_CONTINUE_PROMPT,
    delaysMs: { network: new Array(50).fill(1) },
    openWait: () => idleScope(),
    hasQueued: () => false,
    beforeWait: async () => {},
    publishNote: () => {},
    onSummary: () => {},
    run: async () => {
      runs += 1;
      queue = failure({ madeProgress: true });

      return queue;
    },
    attemptSteps: () => [],
  });

  assert.equal(runs, 10, 'ровно десять начатых продолжений');
  assert.equal(result.autoContinued, 10);
  assert.equal(result.autoContinueOutcome, 'exhausted');
});

test('смена вида переходной ошибки не сбрасывает серию пауз', async () => {
  const delays = [];
  const quotaCode = { code: 'RATE_LIMIT', message: 'x' };
  const overloadCode = { code: 'serverOverloaded', message: 'x' };
  const rules = [
    {
      id: 'test.rate',
      kind: 'rate_limited',
      codes: ['RATE_LIMIT'],
    },
    {
      id: 'test.overloaded',
      kind: 'overloaded',
      codes: ['serverOverloaded'],
    },
  ];

  const { result } = await run(
    {
      scope: {
        wait: async (ms) => {
          delays.push(ms);

          return 'elapsed';
        },
        status: () => null,
        cancel: () => {},
        dispose: () => {},
      },
      extra: {
        rules,
        // Паузы задаются обеим видам: вторая берётся из ВТОРОЙ колонки перегрузки.
        delaysMs: { rate_limited: [10, 20, 30], overloaded: [111, 222, 333] },
        maxContinuations: 2,
      },
    },
    failure({ signal: quotaCode }),
    [() => failure({ signal: overloadCode }), () => failure({ signal: overloadCode })],
  );

  assert.deepEqual(delays, [10, 222], 'индекс не сброшен, вид переключился');
  assert.equal(result.autoContinued, 2);
});

test('признак прогресса из результата важнее вытеснения шага из ленты', async () => {
  const { result, calls } = await run(
    { scope: idleScope() },
    failure({ madeProgress: true, steps: [note('хвост без инструмента')] }),
    [success()],
  );

  assert.equal(calls.length, 1, 'всегда просьба продолжить, а не replay');
  assert.equal(calls[0].message, AUTO_CONTINUE_PROMPT);
  assert.equal(result.autoContinueOutcome, 'recovered');
});

test('нет подтверждения Р2: ни одного вызова, not_resumable', async () => {
  const cases = [
    {
      name: 'нет turnRecovery',
      initial: {
        deliveryFailure: true,
        reply: 'API Error: Connection error.',
        sessionId: 's1',
      },
    },
    { name: 'canContinue false', initial: failure({ canContinue: false }) },
    { name: 'пустой id', initial: failure({ sessionId: '' }) },
    { name: 'id null', initial: failure({ sessionId: null }) },
    { name: 'sessionReset', initial: { ...failure(), sessionReset: true } },
  ];

  for (const item of cases) {
    const { result, calls } = await run({ scope: idleScope() }, item.initial, [success()]);

    assert.equal(calls.length, 0, `${item.name}: вызовов нет`);
    assert.equal(result.autoContinueOutcome, 'not_resumable', item.name);
  }
});

test('окончательные виды не продолжаются', async () => {
  const cases = [
    { kind: 'auth', code: 'authentication_failed' },
    { kind: 'usage_limit', code: 'billing_error' },
    { kind: 'context_overflow', code: 'contextWindowExceeded' },
    { kind: 'policy', code: 'cyberPolicy' },
    { kind: 'bad_request', code: 'badRequest' },
    { kind: 'unknown', code: 'NO_SUCH_CODE' },
  ];
  const rules = [
    {
      id: 'test.auth',
      kind: 'auth',
      codes: ['authentication_failed'],
    },
    {
      id: 'test.billing',
      kind: 'usage_limit',
      codes: ['billing_error'],
    },
    {
      id: 'test.context',
      kind: 'context_overflow',
      codes: ['contextWindowExceeded'],
    },
    {
      id: 'test.policy',
      kind: 'policy',
      codes: ['cyberPolicy'],
    },
    {
      id: 'test.bad-request',
      kind: 'bad_request',
      codes: ['badRequest'],
    },
  ];

  for (const item of cases) {
    const { result, calls } = await run(
      { scope: idleScope(), extra: { rules, maxContinuations: 1 } },
      failure({ signal: { code: item.code, message: 'x' } }),
      [success()],
    );

    assert.equal(calls.length, 0, `${item.kind}: вызовов нет`);
    assert.equal(result.autoContinueOutcome, 'not_continuable', item.kind);
    assert.equal(result.failureKind, item.kind, `${item.kind}: вид назван`);
  }
});

test('выключатель запрещает автоматику с начала и на выходе из паузы', async () => {
  let enabled = false;

  const start = await run(
    { scope: idleScope(), extra: { isEnabled: () => enabled } },
    failure(),
    [success()],
  );

  assert.equal(start.calls.length, 0);
  assert.equal(start.result.autoContinueOutcome, 'disabled');

  enabled = true;

  const scope = {
    wait: async () => {
      enabled = false;

      return 'elapsed';
    },
    status: () => null,
    cancel: () => {},
    dispose: () => {},
  };

  const duringPause = await run({ scope, extra: { isEnabled: () => enabled } }, failure(), [success()]);

  assert.equal(duringPause.calls.length, 0, 'выключение в паузе запрещает вызов');
  assert.equal(duringPause.result.autoContinued, 0);
  assert.equal(duringPause.result.autoContinueOutcome, 'disabled');
});

test('очередь человека отменяет автоматику до подготовки и внутри неё', async () => {
  const already = await run({ scope: idleScope(), queued: true }, failure(), [success()]);

  assert.equal(already.calls.length, 0);
  assert.equal(already.result.autoContinueOutcome, 'yielded');

  // Гонка: пока подготовка удерживается барьером, приходит новое сообщение человека.
  const barrier = deferred();
  const gate = { queued: false };
  // Барьер отпускает сама подготовка: тест не ждёт снаружи, иначе ожидание повисло бы.
  const beforeWait = async () => {
    gate.queued = true;
    barrier.release();

    await barrier.promise;
  };

  const inside = await run(
    {
      scope: idleScope(),
      beforeWait,
      extra: { hasQueued: () => gate.queued },
    },
    failure(),
    [success()],
  );

  assert.equal(inside.calls.length, 0, 'после барьера вызова нет');
  assert.equal(inside.result.autoContinueOutcome, 'yielded');
});

test('отмена внутри подготовки не запускает модель', async () => {
  const controller = new AbortController();
  let sawAbort = false;

  const error = await runReject(
    {
      scope: idleScope(controller.signal),
      beforeWait: async () => {
        sawAbort = true;
        controller.abort();
      },
      extra: { signal: controller.signal },
    },
    failure(),
    [success()],
  );

  assert.equal(sawAbort, true, 'подготовка началась');
  assert.equal(error.stopped, true, 'остановка, а не автопродолжение');
});

test('очередь после истёкшего ожидания отменяет продолжение', async () => {
  let queued = false;
  const scope = {
    wait: async () => {
      queued = true;

      return 'elapsed';
    },
    status: () => null,
    cancel: () => {},
    dispose: () => {},
  };

  const { result, calls } = await run(
    { scope, extra: { hasQueued: () => queued } },
    failure(),
    [success()],
  );

  assert.equal(calls.length, 0, 'очередь отменяет даже после elapsed');
  assert.equal(result.autoContinueOutcome, 'yielded');
});

test('abort и очередь одновременно: остановка приоритетнее', async () => {
  const controller = new AbortController();
  const scope = {
    wait: async () => {
      controller.abort();

      return 'aborted';
    },
    status: () => 'aborted',
    cancel: () => {},
    dispose: () => {},
  };

  const error = await runReject(
    {
      scope,
      queued: true,
      extra: { signal: controller.signal },
    },
    failure(),
    [success()],
  );

  assert.equal(error.stopped, true, '«Стоп» сильнее уступки очереди');
});

test('ошибка подготовки останавливает ход без новой попытки', async () => {
  const broken = new Error('публикация не удалась');

  const error = await runReject(
    {
      scope: idleScope(),
      beforeWait: async () => {
        throw broken;
      },
    },
    failure(),
    [success()],
  );

  assert.equal(error, broken, 'ошибка проброшена как есть');
});

test('ошибка публикации заметки тоже останавливает ход', async () => {
  const broken = new Error('заметка не записалась');

  let caught = null;

  try {
    await continueAfterFailures(failure(), {
      isEnabled: () => true,
      continueMessage: AUTO_CONTINUE_PROMPT,
      openWait: () => idleScope(),
      hasQueued: () => false,
      beforeWait: async () => {},
      publishNote: () => {
        throw broken;
      },
      onSummary: () => {},
      run: async () => success(),
      attemptSteps: () => [],
    });
  } catch (error) {
    caught = error;
  }

  assert.equal(caught, broken, 'ошибка публикации не проглочена');
});

test('отменённое ожидание: ноль продолжений, расход исходной попытки сохранён', async () => {
  const scope = {
    wait: async () => 'yielded',
    status: () => 'yielded',
    cancel: () => {},
    dispose: () => {},
  };

  const { result, calls, notes } = await run(
    { scope },
    failure({ cost: 0.5, steps: [textStep('работал')] }),
    [success()],
  );

  assert.equal(calls.length, 0);
  assert.equal(result.autoContinued, 0);
  assert.equal(result.cost, 0.5, 'известный расход исходной попытки сохранён');
  assert.equal(result.autoContinueOutcome, 'yielded');
  // Заметка паузы могла остаться в ленте — это допустимо, но не обязательно;
  // обязательны сохранённый расход и лента исходной попытки.
  assert.ok(notes.length <= 1, 'заметка публикуется не больше одного раза');
  assert.equal(result.steps.includes(textStep('работал')), false);
  assert.equal(result.steps.length >= 1, true);
});

test('исключение второй попытки: хвост добавлен один раз и дальше не продолжаем', async () => {
  const thrown = Object.assign(new Error('обрыв'), {
    steps: [textStep('вторая попытка')],
    cost: 0.25,
  });

  const error = await runReject(
    { scope: idleScope() },
    failure({ steps: [textStep('первая попытка')], cost: 0.5 }),
    [thrown],
  );

  assert.equal(error.stopped, undefined);
  assert.equal(error.autoContinued, 1);
  assert.equal(error.cost, 0.75, 'известные расходы сложены');
  // Лента цепочки: шаг исходной попытки, заметка паузы и шаг упавшей попытки —
  // каждая ровно один раз и в исходном порядке.
  assert.deepEqual(
    error.steps.map((step) => step.k),
    ['text', 'note', 'text'],
    'ленты обеих попыток и заметка ровно по одному разу',
  );
  assert.equal(error.steps[0].text, 'первая попытка');
  assert.equal(error.steps[2].text, 'вторая попытка');
});

test('ошибка без steps берёт только буфер текущей попытки', async () => {
  const thrown = new Error('обрыв без ленты');

  const error = await runReject(
    { scope: idleScope(), attemptSteps: [textStep('из буфера')] },
    failure({ steps: [textStep('первая попытка')] }),
    [thrown],
  );

  const textSteps = error.steps.filter((step) => step.k === 'text').map((step) => step.text);

  assert.deepEqual(textSteps, ['первая попытка', 'из буфера'], 'буфер добавляется один раз');
  assert.equal(error.steps.filter((step) => step.k === 'note').length, 1);
});

test('известные расходы складываются, неизвестные не выдают частичную сумму за полную', async () => {
  const recovered = await run(
    { scope: idleScope() },
    failure({ cost: 0.5, steps: [textStep('раз')] }),
    [success({ cost: 0.25 })],
  );

  assert.equal(recovered.result.cost, 0.75);

  const half = await run(
    { scope: idleScope() },
    failure({ cost: 0.5 }),
    [success({ cost: null })],
  );

  assert.equal(half.result.cost, 0.5, 'неизвестный расход не обнуляет известный');

  const unknown = await run({ scope: idleScope() }, failure({ cost: null }), [success({ cost: null })]);

  assert.equal(unknown.result.cost, null, 'ничего не известно — null, а не 0');

  const zero = await run({ scope: idleScope() }, failure({ cost: 0 }), [success({ cost: 0 })]);

  assert.equal(zero.result.cost, 0, 'известный ноль остаётся нулём');
});

test('стоимость и лента сохраняются при остановке второй попытки', async () => {
  const stopped = Object.assign(new Error('Стоп'), {
    stopped: true,
    steps: [textStep('вторая')],
    cost: 0.25,
  });

  const error = await runReject(
    { scope: idleScope() },
    failure({ cost: 0.5, steps: [textStep('первая')] }),
    [stopped],
  );

  assert.equal(error.stopped, true);
  assert.equal(error.cost, 0.75);
  assert.equal(error.steps.filter((step) => step.k === 'text').length, 2);
  assert.equal(error.steps.filter((step) => step.k === 'note').length, 1);
});

test('успешный результат не наследует метки сбоя первой попытки', async () => {
  const { result } = await run({ scope: idleScope() }, failure(), [success()]);

  assert.equal(result.deliveryFailure, undefined, 'метка сбоя не перенесена');
  assert.equal(result.turnFailure, undefined);
  assert.equal(result.turnRecovery, undefined);
  assert.equal(result.autoContinueOutcome, 'recovered');
});

test('unknown пишется в журнал очищенным текстом без исходного запроса', async () => {
  const logged = [];

  await run(
    {
      scope: idleScope(),
      extra: {
        log: {
          warn: (fields, message) => logged.push({ fields, message }),
        },
      },
    },
    failure({
      signal: {
        message: 'Bearer sk-secret1234567890 https://internal.example/x \u001b[31mboom',
      },
    }),
    [success()],
  );

  assert.equal(logged.length, 1, 'один warn на исход');

  const serialized = JSON.stringify(logged[0]);

  assert.equal(serialized.includes('sk-secret1234567890'), false, 'ключ не утёк');
  assert.equal(serialized.includes('internal.example'), false, 'адрес скрыт');
  assert.equal(serialized.includes('\\u001b'), false, 'управляющие символы убраны');
});

// ── Область отмены ─────────────────────────────────────────────────────────

test('область отмены: очередь до ожидания отдаёт yielded без таймера', () => {
  const scheduler = manualScheduler();
  const gate = createContinueGate({ scheduler });
  const scope = gate.open('chat-1');

  gate.notifyQueued('chat-1');

  assert.equal(scope.status(), 'yielded');

  let waited = null;

  scope.wait(1000).then((value) => {
    waited = value;
  });

  assert.equal(scheduler.size, 0, 'таймер не создан');
  scope.dispose();
});

test('область отмены: чужой чат не отменяет ожидание', () => {
  const scheduler = manualScheduler();
  const gate = createContinueGate({ scheduler });
  const scope = gate.open('chat-1');

  gate.notifyQueued('chat-2');

  assert.equal(scope.status(), null);
  scope.dispose();
});

test('область отмены: повторный open того же чата — ошибка инварианта', () => {
  const gate = createContinueGate({ scheduler: manualScheduler() });
  const scope = gate.open('chat-1');

  assert.throws(() => gate.open('chat-1'), /chat-1/u);

  scope.dispose();
  gate.open('chat-1').dispose();
});

test('область отмены: dispose до конца ожидания завершает его, поздний таймер не вредит', async () => {
  const scheduler = manualScheduler();
  const gate = createContinueGate({ scheduler });
  const scope = gate.open('chat-1');
  let waited = null;

  scope.wait(5000).then((value) => {
    waited = value;
  });

  assert.equal(scheduler.size, 1);
  scope.dispose();
  await Promise.resolve();
  assert.equal(waited, 'aborted', 'ожидание не зависло');

  const next = gate.open('chat-1');

  assert.equal(next.status(), null, 'новая область не отменена старым callback');
  next.dispose();
});

test('область отмены: истёкшее ожидание помнит отмену, пришедшую после него', async () => {
  const scheduler = manualScheduler();
  const gate = createContinueGate({ scheduler });
  const scope = gate.open('chat-1');
  let waited = null;

  scope.wait(1000).then((value) => {
    waited = value;
  });

  scheduler.fire();
  assert.equal(scheduler.size, 0);
  await Promise.resolve();
  assert.equal(waited, 'elapsed', 'истёкшее ожидание завершилось само');

  gate.notifyQueued('chat-1');

  assert.equal(scope.status(), 'yielded', 'запись живёт до dispose');
  scope.dispose();
  // Контракт status() сообщает только отмену, поэтому признак «время вышло» живёт
  // отдельно и переживает dispose: решение о продолжении принимается уже после него.
  assert.equal(scope.elapsed(), true);
});

test('область отмены: уже отменённый сигнал даёт sticky aborted', async () => {
  const controller = new AbortController();

  controller.abort();

  const gate = createContinueGate({ scheduler: manualScheduler() });
  const scope = gate.open('chat-1', controller.signal);

  assert.equal(scope.status(), 'aborted');
  assert.equal(await scope.wait(1000), 'aborted');
  scope.dispose();
});

// ── Тексты ─────────────────────────────────────────────────────────────────

test('заметка паузы: подпись вида, секунды и минуты', () => {
  const seconds = autoContinueNote({
    kind: 'network',
    delayMs: 10_000,
    attempt: 1,
    budget: 3,
  });

  assert.equal(
    seconds,
    'Сбой хода: оборвалась связь с моделью. Через 10 с попрошу агента продолжить '
      + 'с места остановки — попытка 1 из 3 без продвижения. «Стоп» или сообщение '
      + 'в очереди отменят.',
  );
  assert.match(
    autoContinueNote({
      kind: 'overloaded',
      delayMs: 180_000,
      attempt: 2,
      budget: 3,
    }),
    /Через 3 мин попрошу/u,
  );
  assert.match(
    autoContinueNote({
      kind: 'network',
      delayMs: 500,
      attempt: 1,
      budget: 3,
    }),
    /Через 1 с попрошу/u,
  );
});

test('итог сбоя: основа, прибавки исходов и наличие кнопки', () => {
  const base = deliveryFailureView({
    said: 'API Error: Connection error.',
    kind: 'network',
    resumeAvailable: true,
  });

  assert.equal(
    base.reply,
    '⚠ Ход оборвал сам CLI: «API Error: Connection error.».'
      + ' Контекст сохранён — нажми «Продолжить ход» или напиши «Продолжай»,'
      + ' и агент продолжит с этого места.',
  );
  assert.equal(base.resumable, true);

  const exhausted = deliveryFailureView({
    said: 'x',
    kind: 'network',
    outcome: 'exhausted',
    attempts: 3,
    resumeAvailable: true,
  });

  assert.match(
    exhausted.reply,
    /Автопродолжение не помогло: начатых продолжений — 3 \(оборвалась связь с моделью\)\./u,
  );

  const yielded = deliveryFailureView({
    said: 'x',
    kind: 'network',
    outcome: 'yielded',
    resumeAvailable: true,
  });

  assert.match(yielded.reply, /Автопродолжение отменено: поступило новое сообщение человека\./u);
  assert.equal(yielded.resumable, false, 'уступка очереди не зовёт писать «Продолжай»');

  const notResumable = deliveryFailureView({
    said: 'x',
    kind: 'network',
    outcome: 'not_resumable',
    resumeAvailable: true,
  });

  assert.match(notResumable.reply, /Автопродолжение недоступно: сохранность контекста не подтверждена\./u);
  assert.equal(
    notResumable.resumable,
    true,
    'неподтверждённая АВТОМАТИКА не отменяет ручную кнопку: сессия пригодна',
  );

  const noSession = deliveryFailureView({
    said: 'x',
    kind: 'auth',
    outcome: 'not_continuable',
    resumeAvailable: false,
  });

  assert.equal(noSession.resumable, false);
  assert.equal(noSession.reply.includes('Контекст сохранён'), false);

  const unknownKinded = deliveryFailureView({
    said: 'x',
    kind: 'unknown',
    outcome: 'not_continuable',
    resumeAvailable: true,
  });

  assert.equal(unknownKinded.resumable, true, 'unknown оставляет ручную кнопку');

  const disabled = deliveryFailureView({
    said: 'x',
    kind: 'network',
    outcome: 'disabled',
    resumeAvailable: true,
  });

  assert.match(disabled.reply, /Автопродолжение выключено в настройках\./u);
  assert.equal(disabled.resumable, true);
});

test('итог сбоя: окончательные виды объясняют отказ словами', () => {
  const cases = [
    { kind: 'usage_limit', expected: /Сам не продолжаю: исчерпан лимит использования/u },
    { kind: 'auth', expected: /Проверь вход или ключ исполнителя в настройках/u },
    { kind: 'context_overflow', expected: /Сожми контекст кнопкой на кольце/u },
    { kind: 'policy', expected: /Переформулируй запрос или начни новую сессию/u },
    { kind: 'bad_request', expected: /Переформулируй запрос или начни новую сессию/u },
  ];

  for (const item of cases) {
    const view = deliveryFailureView({
      said: 'x',
      kind: item.kind,
      outcome: 'not_continuable',
      resumeAvailable: true,
    });

    assert.match(view.reply, item.expected, item.kind);
    assert.equal(view.resumable, false, `${item.kind}: кнопки нет`);
  }
});

test('итог сбоя не утверждает, что модели не было, если она уже говорила', () => {
  const said = deliveryFailureView({
    said: 'API Error: 529',
    kind: 'overloaded',
    resumeAvailable: true,
  });
  const silent = deliveryFailureView({
    said: 'API Error: 529',
    kind: 'overloaded',
    resumeAvailable: true,
    modelSpoke: false,
  });

  assert.equal(said.reply.includes('ответа модели не было'), false);
  assert.equal(silent.reply.includes('ответа модели не было'), true);
});
