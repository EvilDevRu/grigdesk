import assert from 'node:assert/strict';
import test from 'node:test';
import { getEventListeners } from 'node:events';
import * as startup from '../../desktop/src/startupController.ts';

import {
  createFrameTracker,
  createStartupController,
  FRAME_LIMIT_MS,
  SPLASH_MINIMUM_MS,
  STARTUP_DEADLINE_MS,
  STARTUP_HOLD_LIMIT_MS,
} from '../../desktop/src/startupController.ts';

const STEPS = ['showSplash', 'prepare', 'connect', 'waitFrame'];

/**
 * Даёт отработать цепочкам обещаний, не продвигая ручные часы теста.
 * Несколько оборотов нужны, потому что каждый await контроллера — отдельная микрозадача.
 */
async function flush() {
  for (let index = 0; index < 20; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Ручные часы: таймеры срабатывают только при advance и строго по времени.
 * Отменённый таймер не срабатывает, а число живых таймеров видно тесту.
 */
function manualClock() {
  let now = 0;
  const timers = [];

  return {
    now: () => now,
    setTimer(ms, callback) {
      const timer = {
        at: now + ms,
        callback,
        cancelled: false,
      };

      timers.push(timer);

      return () => {
        timer.cancelled = true;
      };
    },
    /**
     * Продвигает время, по очереди срабатывая наступившие таймеры.
     * После каждого срабатывания даёт отработать цепочкам обещаний.
     */
    async advance(ms) {
      const target = now + ms;

      while (true) {
        const due = timers
          .filter((timer) => !timer.cancelled && timer.at <= target)
          .sort((left, right) => left.at - right.at)[0];

        if (!due) {
          break;
        }

        now = due.at;
        due.cancelled = true;
        due.callback();
        await flush();
      }

      now = target;
      await flush();
    },
    live: () => timers.filter((timer) => !timer.cancelled).length,
  };
}

/**
 * Каждый шаг старта — отдельное обещание, которое тест разрешает руками.
 * Журнал вызовов показывает порядок, моменты показа и сообщения отказа.
 */
function fixture(overrides = {}) {
  const clock = manualClock();
  const calls = [];
  const signals = [];
  const steps = Object.fromEntries(STEPS.map((name) => [name, Promise.withResolvers()]));
  const step = (name) => (signal) => {
    calls.push(name);
    signals.push(signal);

    return steps[name].promise;
  };
  const adapters = {
    now: clock.now,
    setTimer: clock.setTimer,
    showSplash: step('showSplash'),
    prepare: step('prepare'),
    connect: step('connect'),
    waitFrame: step('waitFrame'),
    focusSplash: () => calls.push('focusSplash'),
    reveal: () => calls.push(`reveal@${clock.now()}`),
    focusMain: () => calls.push('focusMain'),
    timeoutMessage: (phase) => `срок:${phase}`,
    fail: (message) => calls.push(`fail:${message}`),
    ...overrides,
  };

  return {
    controller: createStartupController(adapters),
    calls,
    signals,
    steps,
    clock,
  };
}

/**
 * Проводит старт до нужного шага: все предыдущие шаги разрешаются по порядку.
 * Часы при этом не двигаются, поэтому заставка считается показанной в момент 0.
 */
async function reach(f, name) {
  for (const current of STEPS) {
    await flush();

    if (current === name) {
      return;
    }

    f.steps[current].resolve();
  }

  await flush();
}

test('ST-01: заставка показана до подготовки сервера, показа главного нет', async () => {
  const f = fixture();

  f.controller.start();
  await flush();
  assert.deepEqual(f.calls, ['showSplash']);
  f.steps.showSplash.resolve();
  await flush();
  assert.deepEqual(f.calls, ['showSplash', 'prepare']);
  assert.equal(f.calls.some((call) => call.startsWith('reveal')), false);
});

test('ST-02: готовность через 100 мс — показ ровно на 2000 мс от заставки', async () => {
  const f = fixture();

  f.controller.start();
  f.steps.showSplash.resolve();
  await flush();
  await f.clock.advance(100);
  f.steps.prepare.resolve();
  f.steps.connect.resolve();
  f.steps.waitFrame.resolve();
  await flush();
  assert.equal(f.calls.some((call) => call.startsWith('reveal')), false);
  await f.clock.advance(SPLASH_MINIMUM_MS - 101);
  assert.equal(f.calls.some((call) => call.startsWith('reveal')), false);
  await f.clock.advance(1);
  assert.equal(f.calls.at(-1), 'reveal@2000');
  assert.equal(f.controller.state, 'revealed');
});

test('ST-03: готовность на 8000 мс — показ сразу, без лишних двух секунд', async () => {
  const f = fixture();

  f.controller.start();
  f.steps.showSplash.resolve();
  await flush();
  await f.clock.advance(8000);
  f.steps.prepare.resolve();
  f.steps.connect.resolve();
  f.steps.waitFrame.resolve();
  await flush();
  assert.equal(f.calls.at(-1), 'reveal@8000');
});

test('ST-04: минимум истёк без готовности — показа нет', async () => {
  const f = fixture();

  f.controller.start();
  await reach(f, 'connect');
  await f.clock.advance(5000);
  assert.equal(f.calls.some((call) => call.startsWith('reveal')), false);
  assert.equal(f.controller.state, 'booting');
});

test('ST-05: подключение готово, кадр нет — ждём кадр; предел кадра даёт показ', async () => {
  const f = fixture();

  f.controller.start();
  await reach(f, 'waitFrame');
  await f.clock.advance(3000);
  assert.equal(f.calls.some((call) => call.startsWith('reveal')), false);
  f.steps.waitFrame.resolve();
  await flush();
  assert.equal(f.calls.at(-1), 'reveal@3000');

  const clock = manualClock();
  const frames = createFrameTracker();
  const waiting = frames.wait(new AbortController().signal, FRAME_LIMIT_MS, clock.setTimer);
  let done = false;

  void waiting.then(() => {
    done = true;
  });
  frames.navigated();
  await clock.advance(FRAME_LIMIT_MS - 1);
  assert.equal(done, false);
  await clock.advance(1);
  assert.equal(done, true, 'Предел кадра разрешает ожидание, а не отклоняет его.');
  assert.equal(clock.live(), 0);
});

test('ST-06: барьер кадра считает документы', async () => {
  const clock = manualClock();
  const frames = createFrameTracker();
  const signal = new AbortController().signal;
  let done = false;

  frames.painted();

  const first = frames.wait(signal, FRAME_LIMIT_MS, clock.setTimer);

  void first.then(() => {
    done = true;
  });
  await flush();
  assert.equal(done, false, 'Кадр без navigated не засчитывается.');
  frames.navigated();
  frames.painted();
  await flush();
  assert.equal(done, true);
  assert.equal(clock.live(), 0, 'Таймер предела снят после кадра.');

  frames.navigated();
  done = false;

  const second = frames.wait(signal, FRAME_LIMIT_MS, clock.setTimer);

  void second.then(() => {
    done = true;
  });
  await flush();
  assert.equal(done, false, 'Кадр прежнего документа не засчитывается новому.');
  frames.painted();
  await flush();
  assert.equal(done, true);
  await frames.wait(signal, FRAME_LIMIT_MS, clock.setTimer);

  const controller = new AbortController();

  frames.navigated();

  const cancelled = frames.wait(controller.signal, FRAME_LIMIT_MS, clock.setTimer);

  controller.abort();
  await assert.rejects(cancelled);
  assert.equal(clock.live(), 0);
});

test('ST-07: срок в фазе server — один отказ с её текстом, поздний ответ игнорируется', async () => {
  const f = fixture();

  f.controller.start();
  await reach(f, 'prepare');
  await f.clock.advance(STARTUP_DEADLINE_MS - 1);
  assert.equal(f.calls.some((call) => call.startsWith('fail')), false);
  await f.clock.advance(1);
  assert.deepEqual(f.calls.filter((call) => call.startsWith('fail')), ['fail:срок:server']);
  assert.equal(f.signals.at(-1).aborted, true);
  f.steps.prepare.resolve();
  await flush();
  await f.clock.advance(STARTUP_DEADLINE_MS);
  assert.equal(f.calls.includes('connect'), false);
  assert.equal(f.calls.filter((call) => call.startsWith('fail')).length, 1);
  assert.equal(f.calls.some((call) => call.startsWith('reveal')), false);
  assert.equal(f.controller.state, 'failed');
});

test('ST-08: отказ prepare или connect — ровно один fail с текстом ошибки', async () => {
  for (const name of ['prepare', 'connect']) {
    const f = fixture();
    const finished = f.controller.start();

    await reach(f, name);
    f.steps[name].reject(new Error(`отказ ${name}`));
    assert.equal(await finished, 'failed');
    await f.clock.advance(STARTUP_DEADLINE_MS);
    assert.deepEqual(f.calls.filter((call) => call.startsWith('fail')), [`fail:отказ ${name}`], name);
    assert.equal(f.clock.live(), 0, name);
  }
});

test('ST-09: отмена на любом ожидании — ни показа, ни отказа', async () => {
  for (const name of [...STEPS, 'minimum']) {
    const f = fixture();
    const finished = f.controller.start();

    if (name === 'minimum') {
      await reach(f, 'none');
    } else {
      await reach(f, name);
    }

    f.controller.cancel();
    assert.equal(f.controller.state, 'cancelled', name);
    assert.equal(f.signals.at(-1).aborted, true, name);

    for (const step of STEPS) {
      f.steps[step].resolve();
    }

    assert.equal(await finished, 'cancelled', name);
    await f.clock.advance(STARTUP_DEADLINE_MS);
    assert.equal(f.calls.some((call) => call.startsWith('reveal') || call.startsWith('fail')), false, name);
    assert.equal(f.clock.live(), 0, name);
  }
});

test('ST-10: повторный start — то же обещание и один показ', async () => {
  const f = fixture();
  const first = f.controller.start();

  assert.strictEqual(f.controller.start(), first);
  await reach(f, 'none');
  await f.clock.advance(SPLASH_MINIMUM_MS);
  assert.equal(await first, 'revealed');
  assert.strictEqual(f.controller.start(), first);
  assert.equal(f.calls.filter((call) => call.startsWith('reveal')).length, 1);
  assert.equal(f.calls.filter((call) => call === 'showSplash').length, 1);
});

test('ST-11: после показа поздние события ничего не меняют', async () => {
  const f = fixture();
  const finished = f.controller.start();

  await reach(f, 'none');
  await f.clock.advance(SPLASH_MINIMUM_MS);
  assert.equal(await finished, 'revealed');
  assert.equal(f.clock.live(), 0, 'Срок старта снят после показа.');

  const before = [...f.calls];

  f.controller.cancel();
  await f.clock.advance(STARTUP_DEADLINE_MS);
  assert.equal(f.controller.state, 'revealed');
  assert.deepEqual(f.calls, before);
  assert.equal(f.signals.at(-1).aborted, false);
});

test('ST-12: запрос фокуса по состояниям', async () => {
  const f = fixture();

  f.controller.focusRequest();
  assert.deepEqual(f.calls, []);
  f.controller.start();
  f.controller.focusRequest();
  await flush();
  assert.deepEqual(f.calls, ['showSplash']);
  f.steps.showSplash.resolve();
  await flush();
  assert.deepEqual(f.calls, ['showSplash', 'focusSplash', 'prepare']);
  f.controller.focusRequest();
  assert.equal(f.calls.at(-1), 'focusSplash');
  f.steps.prepare.resolve();
  f.steps.connect.resolve();
  f.steps.waitFrame.resolve();
  await f.clock.advance(SPLASH_MINIMUM_MS);
  f.controller.focusRequest();
  assert.equal(f.calls.at(-1), 'focusMain');

  for (const end of ['failed', 'cancelled']) {
    const g = fixture();

    g.controller.start();
    await reach(g, 'prepare');

    if (end === 'failed') {
      g.steps.prepare.reject(new Error('отказ'));
      await flush();
    } else {
      g.controller.cancel();
    }

    const before = [...g.calls];

    g.controller.focusRequest();
    assert.deepEqual(g.calls, before, end);
  }
});

test('ST-13: срок считается от start — зависшая заставка даёт отказ фазы splash', async () => {
  const f = fixture();
  const finished = f.controller.start();

  await f.clock.advance(STARTUP_DEADLINE_MS);
  assert.equal(await finished, 'failed');
  assert.deepEqual(f.calls, ['showSplash', 'fail:срок:splash']);
  f.steps.showSplash.resolve();
  await flush();
  assert.deepEqual(f.calls, ['showSplash', 'fail:срок:splash']);
});

test('ST-14: переходы idle → booting → revealed | failed | cancelled', async () => {
  const revealed = fixture();

  assert.equal(revealed.controller.state, 'idle');
  revealed.controller.start();
  assert.equal(revealed.controller.state, 'booting');
  await reach(revealed, 'none');
  await revealed.clock.advance(SPLASH_MINIMUM_MS);
  assert.equal(revealed.controller.state, 'revealed');

  const failed = fixture();

  failed.controller.start();
  await reach(failed, 'connect');
  failed.steps.connect.reject(new Error('нет'));
  await flush();
  assert.equal(failed.controller.state, 'failed');

  const cancelled = fixture();

  cancelled.controller.cancel();
  assert.equal(cancelled.controller.state, 'cancelled');
  assert.equal(await cancelled.controller.start(), 'cancelled');
  assert.deepEqual(cancelled.calls, []);
});

test('ST-15: ожидание VPN не расходует срок; после него — свежие 90 с', async () => {
  let held = false;
  const f = fixture({
    holdDeadline: () => held,
  });

  f.controller.start();
  await reach(f, 'prepare');
  held = true;
  await f.clock.advance(STARTUP_DEADLINE_MS + 110_000);
  assert.equal(f.calls.some((call) => call.startsWith('fail')), false, 'Отказ во время ожидания VPN.');
  held = false;
  await f.clock.advance(STARTUP_DEADLINE_MS);
  assert.equal(f.calls.some((call) => call.startsWith('fail')), false, 'Срок после VPN неполный.');
  await f.clock.advance(1000);
  assert.deepEqual(f.calls.filter((call) => call.startsWith('fail')), ['fail:срок:server']);
  assert.equal(f.clock.live(), 0);
});

test('ST-16: ожидание VPN дольше предела удержания — отказ фазы', async () => {
  const f = fixture({
    holdDeadline: () => true,
  });

  f.controller.start();
  await reach(f, 'prepare');
  await f.clock.advance(STARTUP_HOLD_LIMIT_MS - 1000);
  assert.equal(f.calls.some((call) => call.startsWith('fail')), false);
  await f.clock.advance(1000);
  assert.deepEqual(f.calls.filter((call) => call.startsWith('fail')), ['fail:срок:server']);
  assert.equal(f.controller.state, 'failed');
});

test('ST-17: удержание после показа и в отменённом старте ничего не делает', async () => {
  const f = fixture({
    holdDeadline: () => true,
  });
  const finished = f.controller.start();

  await reach(f, 'none');
  await f.clock.advance(SPLASH_MINIMUM_MS);
  assert.equal(await finished, 'revealed');
  assert.equal(f.clock.live(), 0, 'После показа нет ни срока, ни опроса удержания.');
});

for (const mode of ['REMOTE', 'NONE']) {
  test(`ST-BASE-${mode}: без выбранного local сервер не задерживает минимум`, async () => {
    let waits = 0;
    const f = fixture({
      localSelected: () => false,
      waitLocal: () => {
        waits += 1;

        return new Promise(() => {});
      },
    });

    f.controller.start();
    await reach(f, 'none');
    await f.clock.advance(2000);
    assert.equal(f.controller.state, 'revealed');
    assert.equal(f.calls.at(-1), 'reveal@2000');
    assert.equal(waits, 0);
    assert.equal(f.clock.live(), 0);
  });
}

/**
 * Местный сервер завершается отдельно от документа и кадра.
 * Сигнал и мягкие исходы доступны тесту без запуска настоящего процесса.
 */
function localFixture(overrides = {}) {
  const local = Promise.withResolvers();
  const fallbacks = [];
  let signal;

  local.promise.catch(() => {});

  const f = fixture({
    localSelected: () => true,
    waitLocal: (value) => {
      signal = value;

      return local.promise;
    },
    localFallback: (...args) => fallbacks.push(args),
    ...overrides,
  });

  return {
    ...f,
    local,
    fallbacks,
    localSignal: () => signal,
  };
}

test('ST-L01: местный сервер готов на 6000 мс — один показ после сервера', async () => {
  const f = localFixture();

  f.controller.start();
  await reach(f, 'none');
  await f.clock.advance(2000);
  assert.equal(f.controller.state, 'booting', 'Заставка ждёт местный сервер после кадра.');
  await f.clock.advance(4000);
  f.local.resolve();
  await flush();
  assert.deepEqual(f.calls.filter((call) => call.startsWith('reveal')), ['reveal@6000']);
  assert.deepEqual(f.fallbacks, []);
  assert.equal(f.localSignal().aborted, true, 'Наблюдение завершено после успеха.');
  assert.equal(getEventListeners(f.signals[0], 'abort').length, 0);
  assert.equal(f.clock.live(), 0);
  f.controller.focusRequest();
  assert.equal(f.calls.at(-1), 'focusMain');
});

for (const preparationMs of [0, 10_000]) {
  test(`ST-L02: бюджет от заставки, подготовка ${preparationMs} мс, VPN не продлевает`, async () => {
    const f = localFixture({ holdDeadline: () => true });

    f.controller.start();
    f.steps.showSplash.resolve();
    await flush();
    await f.clock.advance(preparationMs);
    f.steps.prepare.resolve();
    f.steps.connect.resolve();
    f.steps.waitFrame.resolve();
    await flush();
    await f.clock.advance(29_999 - preparationMs);
    assert.equal(f.controller.state, 'booting', 'На 29999 мс сервер ещё ждут.');
    await f.clock.advance(1);
    assert.deepEqual(f.calls.filter((call) => call.startsWith('reveal')), ['reveal@30000']);
    assert.equal(f.fallbacks.length, 1);
    assert.equal(f.fallbacks[0][0], 'timeout');
    assert.equal(f.signals[0].aborted, false, 'Мягкий срок не отменяет фоновую подготовку.');
    assert.equal(startup.LOCAL_SERVER_WAIT_MS, 30_000);
    assert.equal(f.localSignal().aborted, true);
    assert.equal(getEventListeners(f.signals[0], 'abort').length, 0);
    assert.equal(f.clock.live(), 0, 'После мягкого показа сняты оба срока.');
    await f.clock.advance(65_000);
    f.local.reject(new Error('Поздний отказ после срока'));
    await flush();
    assert.equal(f.calls.some((call) => call.startsWith('fail')), false);
    assert.equal(f.fallbacks.length, 1);
    assert.equal(f.clock.live(), 0);
  });
}

test('ST-L03: отказ местного сервера даёт мягкий показ после минимума', async () => {
  const f = localFixture();

  f.controller.start();
  await reach(f, 'none');
  f.local.reject(new Error('Синтетический отказ запуска'));
  await flush();
  assert.deepEqual(f.fallbacks, [['failed', 'Синтетический отказ запуска']]);
  assert.equal(f.controller.state, 'booting');
  await f.clock.advance(1999);
  assert.equal(f.controller.state, 'booting');
  await f.clock.advance(1);
  assert.deepEqual(f.calls.filter((call) => call.startsWith('reveal')), ['reveal@2000']);
  assert.equal(f.calls.some((call) => call.startsWith('fail')), false);
  assert.equal(f.clock.live(), 0);
});

for (const late of ['resolve', 'reject']) {
  test(`ST-L04: отмена local, фокус заставке, поздний ${late} без эффектов`, async () => {
    const f = localFixture();
    const finished = f.controller.start();

    await reach(f, 'none');
    await f.clock.advance(2000);
    f.controller.focusRequest();
    assert.equal(f.calls.at(-1), 'focusSplash');
    assert.ok(f.localSignal(), 'Местный адаптер должен получить отдельный сигнал.');
    f.controller.cancel();
    assert.equal(await finished, 'cancelled');
    assert.equal(f.localSignal().aborted, true);
    assert.equal(getEventListeners(f.signals[0], 'abort').length, 0);
    assert.equal(f.clock.live(), 0);

    const before = [...f.calls];

    f.local[late](new Error('Поздний результат после отмены'));
    await flush();
    await f.clock.advance(95_000);
    f.controller.focusRequest();
    assert.deepEqual(f.calls, before);
    assert.deepEqual(f.fallbacks, []);
    assert.equal(f.clock.live(), 0);
  });
}
