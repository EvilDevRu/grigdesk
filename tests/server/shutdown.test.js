// Координатор остановки: сигнал → шаги слива → закрытие → выход. Проверяется контракт,
// ради которого он появился: слив идёт ДО закрытия сервера, зависший шаг не держит
// процесс дольше бюджета, а повторный сигнал завершает его немедленно.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createShutdownCoordinator } from '../../server/src/lib/shutdown.ts';

function harness({ timeoutMs = 200, close = async () => {} } = {}) {
  const signals = new EventEmitter();
  const exits = [];
  const log = { info() {}, warn() {}, error() {} };
  const coordinator = createShutdownCoordinator({
    close,
    log,
    timeoutMs,
    signals,
    exit: (code) => exits.push(code),
  });
  return { coordinator, signals, exits };
}

test('SIGTERM запускает шаги слива по порядку, потом закрытие и чистый выход', async () => {
  const order = [];
  const { coordinator, signals, exits } = harness({
    close: async () => { order.push('close'); },
  });
  coordinator.register('первый', async () => { order.push('первый'); });
  coordinator.register('второй', async () => { order.push('второй'); });
  coordinator.arm();

  assert.equal(coordinator.active, false);
  signals.emit('SIGTERM');
  assert.equal(coordinator.active, true, 'с первого сигнала остановка активна');

  await coordinator.begin('повтор');
  assert.deepEqual(order, ['первый', 'второй', 'close']);
  assert.deepEqual(exits, [0]);
});

test('упавший шаг не мешает остальным и закрытию', async () => {
  const order = [];
  const { coordinator, exits } = harness({
    close: async () => { order.push('close'); },
  });
  coordinator.register('ломается', async () => { throw new Error('нет'); });
  coordinator.register('живой', async () => { order.push('живой'); });

  await coordinator.begin('тест');
  assert.deepEqual(order, ['живой', 'close']);
  assert.deepEqual(exits, [0]);
});

test('зависший шаг обрывается бюджетом с ненулевым кодом', async () => {
  const { coordinator, exits } = harness({
    timeoutMs: 50,
    close: async () => {},
  });
  coordinator.register('вечный', () => new Promise(() => {}));

  const begun = coordinator.begin('тест');
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(exits, [1], 'по истечении бюджета процесс выходит принудительно');
  // Обещание остановки так и не разрешится — это норма: настоящий exit его прервал бы.
  void begun;
});

test('повторный сигнал во время остановки — немедленный выход', async () => {
  let release;
  const { coordinator, signals, exits } = harness({
    close: () => new Promise((resolve) => { release = resolve; }),
  });
  coordinator.arm();

  signals.emit('SIGINT');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(exits, [], 'первый сигнал — штатная остановка');

  signals.emit('SIGINT');
  assert.deepEqual(exits, [1]);
  release();
});

test('begin идемпотентен: вторая остановка не запускает шаги заново', async () => {
  let runs = 0;
  const { coordinator, exits } = harness();
  coordinator.register('шаг', async () => { runs += 1; });

  await Promise.all([coordinator.begin('раз'), coordinator.begin('два')]);
  assert.equal(runs, 1);
  assert.deepEqual(exits, [0]);
});

test('DP-01 begin с кодом 75 сохраняет первый код и выходит после слива', async () => {
  const order = [];
  const { coordinator, exits } = harness({
    close: async () => {
      order.push('close');
    },
  });

  coordinator.register('слив', async () => {
    order.push('слив');
  });

  const first = coordinator.begin('перезапуск приложения', 75);
  const repeated = coordinator.begin('повтор', 0);

  assert.equal(repeated, first);
  await first;
  assert.deepEqual(order, ['слив', 'close']);
  assert.deepEqual(exits, [75]);
});

test('DP-02 превышение бюджета сохраняет код 75, без кода выходит с 1', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  for (const code of [75, undefined]) {
    const { coordinator, exits } = harness({ timeoutMs: 50 });

    coordinator.register('вечный', () => new Promise(() => {}));
    void coordinator.begin('проверка бюджета', code);
    t.mock.timers.tick(50);

    assert.deepEqual(exits, [code || 1]);
  }
});

test('DP-02 ошибка close сохраняет код перезапуска и код ошибки обычной остановки', async () => {
  for (const code of [75, undefined]) {
    const { coordinator, exits } = harness({
      close: async () => {
        throw new Error('ошибка закрытия фикстуры');
      },
    });

    await coordinator.begin('ошибка закрытия', code);

    assert.deepEqual(exits, [code || 1]);
  }
});

test('deadline называет внутренний close-шаг и не даёт поздний успешный drain proof', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const events = [];
  const proofs = [];
  const exits = [];
  let release;
  const coordinator = createShutdownCoordinator({
    timeoutMs: 50,
    exit: (code) => exits.push(code),
    log: {
      info: (fields) => events.push(fields),
      error: (fields) => events.push(fields),
    },
    close: () => coordinator.closeStep('telegram-watch', () => new Promise((resolve) => {
      release = resolve;
    })),
  });

  coordinator.afterDrain((success) => proofs.push(success));

  const stopping = coordinator.begin('синтетика', 75);

  t.mock.timers.tick(50);
  release();
  await stopping;
  assert.deepEqual(exits, [75]);
  assert.deepEqual(proofs, []);
  assert.equal(events.find((event) => event.event === 'shutdown.deadline').step, 'telegram-watch');
  assert.ok(events.some((event) => event.event === 'shutdown.step.start'));
  assert.ok(events.some((event) => event.event === 'shutdown.step.end'));
});
