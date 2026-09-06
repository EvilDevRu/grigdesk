// Свежесть лимитов у открытой всплывашки исполнителя. Смысл проверки: цифры брались один
// раз и дальше стояли, поэтому важны ровно три вещи — раскрытие читает, открытая всплывашка
// тикает, закрытая молчит. Плюс переход по ряду иконок: события open/close идут внахлёст, и
// чужое закрытие не должно гасить опрос уже открытой соседки.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createUsageWatch } from '../../web/src/features/providers/usageWatch.js';

function fakeTimers() {
  const started = new Map();
  let nextId = 1;

  return {
    started,
    setInterval(fn, ms) {
      const id = nextId;

      nextId += 1;
      started.set(id, { fn, ms });

      return id;
    },
    clearInterval(id) {
      started.delete(id);
    },
    tick(id) {
      started.get(id).fn();
    },
  };
}

test('раскрытие всплывашки читает лимиты и запускает тик', () => {
  const timers = fakeTimers();
  const reads = [];
  const watch = createUsageWatch(() => reads.push('read'), { intervalMs: 30_000, timers });

  watch.open('claude');

  assert.deepEqual(reads, ['read'], 'раскрытие не перечитало лимиты');
  assert.deepEqual([...timers.started.values()].map((entry) => entry.ms), [30_000]);

  timers.tick(1);
  timers.tick(1);
  assert.deepEqual(reads, ['read', 'read', 'read'], 'открытая всплывашка перестала обновляться');
});

test('закрытая всплывашка лимиты не опрашивает', () => {
  const timers = fakeTimers();
  const reads = [];
  const watch = createUsageWatch(() => reads.push('read'), { timers });

  watch.open('claude');
  watch.close('claude');

  assert.equal(timers.started.size, 0, 'тик остался жить после закрытия');
  assert.equal(watch.openFor, '');
  assert.deepEqual(reads, ['read']);
});

test('закрытие прежней всплывашки не гасит опрос уже открытой соседней', () => {
  const timers = fakeTimers();
  const reads = [];
  const watch = createUsageWatch(() => reads.push('read'), { timers });

  // Мышь ушла с иконки Claude на иконку Codex: open соседки приходит раньше close прежней.
  watch.open('claude');
  watch.open('codex');
  watch.close('claude');

  assert.equal(watch.openFor, 'codex', 'опрос отдали чужому закрытию');
  assert.equal(timers.started.size, 1, 'у открытой всплывашки не осталось ровно одного тика');

  const [id] = [...timers.started.keys()];

  timers.tick(id);
  assert.deepEqual(reads, ['read', 'read', 'read']);
});

test('переоткрытие не оставляет второй тик', () => {
  const timers = fakeTimers();
  const watch = createUsageWatch(() => {}, { timers });

  watch.open('claude');
  watch.open('claude');

  assert.equal(timers.started.size, 1, 'тики копятся на каждое наведение');

  watch.stop();
  assert.equal(timers.started.size, 0);
});
