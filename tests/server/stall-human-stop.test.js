import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { detectStall } from '../../server/src/lib/stall.ts';

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
    factory.includes('v2_log "${stop_node^^}: маршрут остановлен: ${stop}${stop_suffix}"'),
    true,
    'движок больше не пишет узел в строке остановки — правило в stall.js осталось без источника',
  );
  assert.equal(
    factory.includes('stop_suffix=" — $ROUTE_V2_EVIDENCE_STOP_REASON"'),
    true,
    'движок больше не дописывает причину сторожа в строку остановки — правило про сторожа осталось без источника',
  );

  const stall = detectStall({
    registry: stalledRegistry,
    logText: logOf(line('2026-08-27 18:25:32', 'HYPOSKEPTIC: маршрут остановлен: human')),
    daemonAlive: false,
  });

  assert.equal(stall.stop, 'human');
});

// Агент сдал `done`, а хостовый сторож доказательств сдачу отверг: остановка та же `human`,
// но совет «прочитай замечание узла» здесь вреден — замечание агента рапортует об успехе.
// Причину движок кладёт в саму строку остановки (t8702: в manifest тестов попал файл,
// который VERIFY не исполняет; человек собирал это по route-v2.log).
test('отказ сторожа в строке остановки попадает в заголовок карточки', () => {
  const reason = 'feature-verify snapshot: manifest нельзя полностью выполнить: '
    + 'frontend:tests/unit/projects/volumeDeviceToggles.test.mjs';
  const stall = detectStall({
    registry: { ...stalledRegistry, TESTS_COMMENT: `сторож отверг сдачу — ${reason}` },
    logText: logOf(
      line('2026-09-16 15:08:11', 'узел tests: подготовка к исполнению'),
      line('2026-09-16 15:26:38', `TESTS: сторож отверг сдачу — ${reason}; повтор с её цитатой`),
      line('2026-09-16 15:44:02', `TESTS: сторож отверг сдачу — ${reason}; повтор не помог`),
      line('2026-09-16 15:44:03', `TESTS: маршрут остановлен: human — сторож отверг сдачу — ${reason}`),
    ),
    daemonAlive: false,
  });

  assert.equal(stall.stop, 'human');
  assert.equal(stall.stage, 'TESTS');
  assert.equal(stall.title, `TESTS: сторож отверг сдачу — ${reason}`);
  assert.equal(stall.hint.includes('перейти сюда'), true);
  assert.equal(stall.hint.includes('замечание'), false);
  assert.equal(stall.comment.startsWith('сторож отверг сдачу'), true);
});
