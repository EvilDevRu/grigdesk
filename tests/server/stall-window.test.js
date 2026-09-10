import assert from 'node:assert/strict';
import test from 'node:test';

import { detectStall } from '../../server/src/lib/stall.ts';

// Журнал задачи ведётся месяцами и переживает любое число прогонов. Пока окна поиска не
// было, причина бралась первая попавшаяся с конца — то есть могла принадлежать заходу
// многодневной давности. Живые случаи 28.08.2026 разобраны в комментарии `stall.js`.

const line = (ts, event) => `${ts} [t1] route: ${event}`;

const logOf = (...events) => events.join('\n');

test('древняя причина не выдаётся за текущую: после неё маршрут прошёл узлы', () => {
  const logText = logOf(
    line('2026-08-03 19:36:11', 'среда профиля не готова (код 73)'),
    line('2026-08-27 20:09:51', 'узел measure: подготовка к исполнению'),
    line('2026-08-27 20:16:57', 'узел lint: подготовка к исполнению'),
    line('2026-08-27 20:17:54', 'пауза на human gate gate_accept'),
  );

  const stall = detectStall({
    registry: { STALLED_HUMAN: '1', GATE_ACCEPT: 'waiting' },
    logText,
    daemonAlive: false,
  });

  assert.equal(stall, null);
});

test('снятый тупик не даёт арбитру ложный вход', () => {
  const logText = logOf(
    line('2026-08-21 16:24:25', 'SKEPTIC: маршрут остановлен: no-progress — повторяется тот же набор'),
    line('2026-08-21 16:40:00', 'курсор возвращён человеком на узел plan: разбор'),
    line('2026-08-21 18:38:52', 'узел review: подготовка к исполнению'),
    line('2026-08-21 19:17:34', 'пауза на human gate gate_accept'),
  );

  const stall = detectStall({
    registry: { STALLED_HUMAN: '1', GATE_ACCEPT: 'waiting', RESULT: 'stopped-no-progress' },
    logText,
    daemonAlive: false,
  });

  assert.equal(stall, null);
});

test('свежая причина внутри текущего захода по-прежнему находится', () => {
  const logText = logOf(
    line('2026-08-27 13:19:04', 'узел measure: подготовка к исполнению'),
    line('2026-08-27 13:23:54', 'узел lint: подготовка к исполнению'),
    line('2026-08-27 13:26:47', 'LINT: маршрут остановлен: no-progress — повторяется тот же набор'),
  );

  const stall = detectStall({
    registry: { STALLED_HUMAN: '1' },
    logText,
    daemonAlive: false,
  });

  assert.equal(stall?.stop, 'no-progress');
  assert.equal(stall?.stage, 'LINT');
});

test('зафиксированные ворота тоже закрывают прошлый заход', () => {
  const logText = logOf(
    line('2026-08-27 10:00:00', 'SANDBOX: стенд не поднялся'),
    line('2026-08-27 11:00:00', 'gate gate_plan=approved зафиксирован'),
    line('2026-08-27 11:05:00', 'пауза на human gate gate_accept'),
  );

  const stall = detectStall({
    registry: { STALLED_HUMAN: '1', GATE_ACCEPT: 'waiting' },
    logText,
    daemonAlive: false,
  });

  assert.equal(stall, null);
});

test('восстановление инструментации движком тоже закрывает прошлый заход', () => {
  const logText = logOf(
    line('2026-08-27 12:00:00', 'BUILD: агент убит по таймауту'),
    line('2026-08-27 12:10:00', 'восстановление: инструментация снята, курсор возвращён на instrument (был build)'),
    line('2026-08-27 12:11:00', 'узел instrument: подготовка к исполнению'),
    line('2026-08-27 12:30:00', 'пауза на human gate gate_accept'),
  );

  const stall = detectStall({
    registry: { STALLED_HUMAN: '1', GATE_ACCEPT: 'waiting' },
    logText,
    daemonAlive: false,
  });

  assert.equal(stall, null);
});

test('без единого события продвижения окном остаётся весь журнал', () => {
  const logText = logOf(
    line('2026-08-27 09:00:00', 'sandbox_up упал'),
    line('2026-08-27 09:01:00', 'что-то ещё, под правила не подпадающее'),
  );

  const stall = detectStall({
    registry: { STALLED_HUMAN: '1' },
    logText,
    daemonAlive: false,
  });

  assert.equal(stall?.stage, 'SANDBOX');
  assert.equal(stall?.title, 'стенд не поднялся');
});

test('оборванный прогон не наследует причину прошлого захода', () => {
  const logText = logOf(
    line('2026-08-27 09:00:00', 'BUILD: агенту не дали записать результат'),
    line('2026-08-27 10:00:00', 'узел build: подготовка к исполнению'),
    line('2026-08-27 10:40:00', 'получен TERM; останавливаю exact active runner'),
  );

  const stall = detectStall({ registry: {}, logText, daemonAlive: false });

  assert.equal(stall?.kind, 'crashed');
  assert.equal(stall?.stage, null);
  assert.equal(stall?.title, 'конвейер оборвался, не дойдя до конца');
});
