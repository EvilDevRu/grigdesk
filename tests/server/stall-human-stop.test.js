import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { detectStall } from '../../server/src/lib/stall.js';

// Остановка `stop: human` — самая частая объявленная остановка маршрутов: замер по всем
// опубликованным каталогам дал 2785 таких переходов против 184 `done`. При этом до
// 28.08.2026 её не ловило ни одно правило `stall.js`, и человек читал «причина не
// нашлась в журнале» ровно там, где узел уже записал развёрнутый вердикт с вопросом.

const line = (ts, event) => `${ts} [t1] route: ${event}`;

const logOf = (...events) => events.join('\n');

const stalledRegistry = { STALLED_HUMAN: '1' };

test('остановка human называет узел, который вернул решение', () => {
  const stall = detectStall({
    registry: stalledRegistry,
    logText: logOf(
      line('2026-08-27 18:07:30', 'узел hyposkeptic: подготовка к исполнению'),
      line('2026-08-27 18:25:32', 'HYPOSKEPTIC: маршрут остановлен: human'),
    ),
    daemonAlive: false,
  });

  assert.equal(stall.stop, 'human');
  assert.equal(stall.stage, 'HYPOSKEPTIC');
  assert.equal(stall.kind, 'human');
  assert.equal(stall.title.includes('HYPOSKEPTIC'), true);
});

// Журналы, написанные до правки движка, узла в строке не несут, и взять его неоткуда.
// Тип остановки при этом известен точно — а он и есть главное для человека.
test('остановка human без узла всё равно называет вид остановки', () => {
  const stall = detectStall({
    registry: stalledRegistry,
    logText: logOf(
      line('2026-08-27 18:07:30', 'узел hyposkeptic: подготовка к исполнению'),
      line('2026-08-27 18:25:32', 'маршрут остановлен: human'),
    ),
    daemonAlive: false,
  });

  assert.equal(stall.stop, 'human');
  assert.equal(stall.stage, null);
  assert.equal(stall.title, 'маршрут вернул решение человеку');
});

// Гейт арбитра (`ARBITRABLE_STOPS`, кнопка в `PipelineView` и вотчер) сравнивает
// `stall.stop` строго с `no-progress`. Заполненный вид остановки `human` не имеет права
// открыть арбитра: класс `human` означает, что решение не выводится из вердиктов дуги.
test('human не является арбитрабельной остановкой', () => {
  const stall = detectStall({
    registry: stalledRegistry,
    logText: logOf(line('2026-08-27 18:25:32', 'HYPOSKEPTIC: маршрут остановлен: human')),
    daemonAlive: false,
  });

  assert.notEqual(stall.stop, 'no-progress');
});

test('прошлый no-progress не перебивает свежую остановку human', () => {
  const stall = detectStall({
    registry: stalledRegistry,
    logText: logOf(
      line('2026-08-27 10:00:00', 'BUILD: маршрут остановлен: no-progress — повтор набора'),
      line('2026-08-27 10:24:32', 'курсор возвращён человеком на узел instrument'),
      line('2026-08-27 18:07:30', 'узел hyposkeptic: подготовка к исполнению'),
      line('2026-08-27 18:25:32', 'HYPOSKEPTIC: маршрут остановлен: human'),
    ),
    daemonAlive: false,
  });

  assert.equal(stall.stop, 'human');
  assert.equal(stall.stage, 'HYPOSKEPTIC');
});

// Формат строки принадлежит движку, а разбирает её кокпит. Разъезжаются они молча:
// именно так «маршрут завершён» когда-то показывался как оборванный прогон. Сверяем
// шаблон в `bin/factory` с тем, что фактически ловит правило.
test('формат строки движка и правило кокпита сходятся', async () => {
  const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const factory = await fs.readFile(path.join(root, 'engine', 'bin', 'factory'), 'utf8');

  assert.equal(
    factory.includes('v2_log "${stop_node^^}: маршрут остановлен: $stop"'),
    true,
    'движок больше не пишет узел в строке остановки — правило в stall.js осталось без источника',
  );

  const stall = detectStall({
    registry: stalledRegistry,
    logText: logOf(line('2026-08-27 18:25:32', 'HYPOSKEPTIC: маршрут остановлен: human')),
    daemonAlive: false,
  });

  assert.equal(stall.stop, 'human');
});
