import assert from 'node:assert/strict';
import test from 'node:test';

import { FactoryArbiterLive } from '../../server/src/lib/factoryArbiterLive.ts';

// Пока арбитр работает, задача снаружи выглядит вставшей: та же плашка затыка, та же
// кнопка. Прежний признак занятости жил только в нажавшем окне, поэтому обход вотчера
// не показывался нигде — человек шёл делать руками работу, которую делал арбитр.

test('начало и конец разбора будят шину ровно по разу', async () => {
  const events = [];
  const live = new FactoryArbiterLive({ onChange: (task) => events.push(task) });

  const done = live.begin('8512', { actor: 'auto', model: 'claude/claude-opus-5' });
  assert.deepEqual(events, ['8512']);

  done();
  assert.deepEqual(events, ['8512', '8512']);

  // Повторное снятие — обычный путь: `finally` может выполниться после ветки отказа.
  done();
  assert.deepEqual(events, ['8512', '8512'], 'второе снятие не шлёт лишнее событие');
});

test('проекция называет актора, модель и прошедшее время', async () => {
  const live = new FactoryArbiterLive();
  const done = live.begin('42', { actor: 'human', model: 'claude/opus' });

  const run = live.read('42');
  assert.equal(run.actor, 'human');
  assert.equal(run.model, 'claude/opus');
  assert.equal(Number.isInteger(run.elapsedSec), true);
  assert.equal(run.elapsedSec >= 0, true);

  done();
  assert.equal(live.read('42'), null, 'снятая отметка не остаётся фантомом');
});

test('незнакомая задача разбором не считается', async () => {
  const live = new FactoryArbiterLive();
  assert.equal(live.read('777'), null);
  assert.equal(live.read(''), null);
  assert.equal(live.read(null), null);
});

// Пустой id означал бы отметку, которую нечем снять: она держала бы «разбор» вечно.
test('пустая задача отметку не создаёт', async () => {
  const events = [];
  const live = new FactoryArbiterLive({ onChange: (task) => events.push(task) });

  const done = live.begin('', { actor: 'auto' });
  assert.equal(live.size, 0);
  assert.deepEqual(events, []);

  done();
  assert.equal(live.size, 0);
});

test('две задачи разбираются независимо друг от друга', async () => {
  const live = new FactoryArbiterLive();
  const first = live.begin('1', { actor: 'auto' });
  live.begin('2', { actor: 'human' });

  assert.equal(live.size, 2);
  first();
  assert.equal(live.read('1'), null);
  assert.equal(live.read('2').actor, 'human');
});

// Обход вотчера дорогой: он читает журналы попыток и вердикты каждой задачи. Пока
// остановленных задач нет, короткая пауза не должна превращаться в такой обход — иначе
// вернётся грабля, убившая карточку «Слоты запуска».
test('дешёвый фильтр отсекает обход, пока никто не встал', async () => {
  const { FactoryArbiterWatch } = await import('../../server/src/lib/factoryArbiterWatch.ts');
  let listed = 0;
  const watch = new FactoryArbiterWatch({
    sse: { subscribe: () => () => {} },
    prefs: { read: () => ({ arbiter: { auto: true } }) },
    hasStopped: async () => false,
    listTasks: async () => { listed += 1; return []; },
    arbitrate: async () => null,
    log: { info() {}, warn() {} },
  });

  await watch.tick();
  assert.equal(listed, 0, 'полный список задач не читался');
});

test('появление остановленной задачи обход запускает', async () => {
  const { FactoryArbiterWatch } = await import('../../server/src/lib/factoryArbiterWatch.ts');
  let listed = 0;
  const watch = new FactoryArbiterWatch({
    sse: { subscribe: () => () => {} },
    prefs: { read: () => ({ arbiter: { auto: true } }) },
    hasStopped: async () => true,
    listTasks: async () => { listed += 1; return []; },
    arbitrate: async () => null,
    log: { info() {}, warn() {} },
  });

  await watch.tick();
  assert.equal(listed, 1);
});

// Остановка — конечное состояние: после неё движок не пишет ни строки, поэтому шина
// молчит. Задача, вставшая до подъёма сервера, без стартового обхода ждала бы первого
// срабатывания пятнадцатиминутной страховки — то есть перезапуск сервера добавлял бы
// простоя ровно там, где автоматический путь и нужен.
test('старт вотчера сам делает первый обход', async (t) => {
  const { FactoryArbiterWatch } = await import('../../server/src/lib/factoryArbiterWatch.ts');
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });

  let checked = 0;
  const watch = new FactoryArbiterWatch({
    sse: { subscribe: () => () => {} },
    prefs: { read: () => ({ arbiter: { auto: true } }) },
    hasStopped: async () => { checked += 1; return false; },
    listTasks: async () => [],
    arbitrate: async () => null,
    log: { info() {}, warn() {} },
  });

  watch.start();
  assert.equal(checked, 0, 'обход не идёт синхронно из onReady: inject ждал бы готовности Fastify');

  t.mock.timers.tick(9 * 1000);
  await new Promise((resolve) => { setImmediate(resolve); });

  assert.equal(checked, 1, 'первый обход состоялся без единого события шины');
  watch.stop();
});

// Вердикт `human` означает «вход разобран, дальше решает человек». Задача при этом
// остаётся `arbitrable` — вид остановки-то подходящий, — и без отдельного правила вотчер
// брал бы её каждый час до бесконечности: тот же ход живого агента, тот же ответ.
test('вотчер не перемалывает остановку, уже отданную человеку', async () => {
  const { FactoryArbiterWatch } = await import('../../server/src/lib/factoryArbiterWatch.ts');
  const decided = {
    task: '8507',
    readOnly: false,
    daemonAlive: false,
    stall: {
      node: 'build',
      stop: 'human',
      arbitrable: true,
      arbiter: { verdict: 'human', node: 'build', stop: 'human' },
    },
  };
  const attempts = [];
  const watch = new FactoryArbiterWatch({
    sse: { subscribe: () => () => {} },
    prefs: { read: () => ({ arbiter: { auto: true } }) },
    hasStopped: async () => true,
    listTasks: async () => [decided],
    arbitrate: async (id) => { attempts.push(id); return null; },
    log: { info() {}, warn() {} },
  });

  await watch.tick();
  assert.deepEqual(attempts, [], 'повторный разбор той же остановки не запускается');

  // Человек вернул курсор, и маршрут встал в другом месте — это другая остановка.
  decided.stall = {
    node: 'review',
    stop: 'no-progress',
    arbitrable: true,
    arbiter: { verdict: 'human', node: 'build', stop: 'human' },
  };
  await watch.tick();
  assert.deepEqual(attempts, ['8507'], 'новая остановка разбирается');
});

// Снятый тупик — не приговор: `resolve` возвращает курсор, маршрут едет дальше, и если
// он встанет снова, разбирать надо. Запрет относится только к вердикту `human`.
test('снятый арбитром тупик не запрещает следующий разбор', async () => {
  const { FactoryArbiterWatch } = await import('../../server/src/lib/factoryArbiterWatch.ts');
  const attempts = [];
  const watch = new FactoryArbiterWatch({
    sse: { subscribe: () => () => {} },
    prefs: { read: () => ({ arbiter: { auto: true } }) },
    hasStopped: async () => true,
    listTasks: async () => [{
      task: '42',
      readOnly: false,
      daemonAlive: false,
      stall: {
        node: 'build',
        stop: 'no-progress',
        arbitrable: true,
        arbiter: { verdict: 'resolve', node: 'build', stop: 'no-progress' },
      },
    }],
    arbitrate: async (id) => { attempts.push(id); return null; },
    log: { info() {}, warn() {} },
  });

  await watch.tick();
  assert.deepEqual(attempts, ['42']);
});
