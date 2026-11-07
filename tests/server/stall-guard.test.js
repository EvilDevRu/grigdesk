import assert from 'node:assert/strict';
import test from 'node:test';

import { detectStall } from '../../server/src/lib/stall.ts';

// Сторож state-only: проверяющий узел оставил после себя изменённое рабочее дерево.
// До 11.09.2026 движок писал в журнал одну строку «dispatcher остановлен fail-closed
// (код 75)», а карточка отвечала «причина не нашлась в журнале». Живой случай: критик
// тестов прогнал e2e, Playwright переписал untracked storage state, и человек разбирал
// base64 в снимках сторожа — три задачи подряд.

const line = (ts, event) => `${ts} [t1] route: ${event}`;

const logOf = (...events) => events.join('\n');

const stalledRegistry = { STALLED_HUMAN: '1' };

const guardLine = 'TCRITIC: сторож state-only: узел tcritic изменил рабочее дерево'
  + ' — UNTRACKED /work/fe/e2e/.auth (1)';

test('остановка сторожа называет узел и каталог расхождения', () => {
  const stall = detectStall({
    registry: stalledRegistry,
    logText: logOf(
      line('2026-09-11 16:02:18', 'узел tcritic: подготовка к исполнению'),
      line('2026-09-11 16:12:13', guardLine),
      line('2026-09-11 16:12:13', '  изменено: UNTRACKED /work/fe/e2e/.auth (1)'),
      line('2026-09-11 16:12:13', 'dispatcher остановлен fail-closed (код 75)'),
    ),
    daemonAlive: false,
  });

  assert.equal(stall.kind, 'human');
  assert.equal(stall.stop, 'guard');
  assert.equal(stall.stage, 'TCRITIC');
  assert.equal(stall.title.includes('/work/fe/e2e/.auth (1)'), true);
  assert.equal(stall.hint.includes('profile_route_volatile_paths'), true);
});

// Итоговая строка диспетчера печатается ПОСЛЕ строки с причиной, и раньше первой с конца
// попадалась бы именно она. Слабое правило не должно перекрывать точную причину выше.
test('итоговая строка fail-closed не заслоняет точную причину над ней', () => {
  const stall = detectStall({
    registry: stalledRegistry,
    logText: logOf(
      line('2026-09-11 16:12:13', guardLine),
      line('2026-09-11 16:12:13', 'dispatcher остановлен fail-closed (код 75)'),
    ),
    daemonAlive: false,
  });

  assert.equal(stall.stop, 'guard');
});

// Журналы до правки движка причины не несут — но и «причина не нашлась» там неправда:
// сам факт fail-closed выхода и его код известны точно.
test('голый fail-closed без причины всё равно называет вид остановки и код', () => {
  const stall = detectStall({
    registry: stalledRegistry,
    logText: logOf(
      line('2026-09-10 21:06:47', 'узел verify: подготовка к исполнению'),
      line('2026-09-10 21:07:29', 'dispatcher остановлен fail-closed (код 75)'),
    ),
    daemonAlive: false,
  });

  assert.equal(stall.stop, 'fail-closed');
  assert.equal(stall.stage, null);
  assert.equal(stall.title, 'диспетчер остановлен fail-closed (код 75)');
  assert.equal(stall.hint.includes('resume'), true);
});

// Окно поиска остаётся в силе: после того как маршрут поехал дальше, старая остановка
// сторожа текущей причиной быть не может.
test('снятая остановка сторожа не выдаётся за текущую после продвижения маршрута', () => {
  const stall = detectStall({
    registry: { STALLED_HUMAN: '1', GATE_ACCEPT: 'waiting' },
    logText: logOf(
      line('2026-09-11 16:12:13', guardLine),
      line('2026-09-11 16:12:13', 'dispatcher остановлен fail-closed (код 75)'),
      line('2026-09-11 17:00:00', 'узел tcritic: подготовка к исполнению'),
      line('2026-09-11 18:00:00', 'пауза на human gate gate_accept'),
    ),
    daemonAlive: false,
  });

  assert.equal(stall, null);
});
