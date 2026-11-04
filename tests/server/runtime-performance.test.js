import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeDiagnostics } from '../../server/src/lib/runtimeDiagnostics.ts';

test('server runtime считает окно, GC и ресурсы, а off/close всё освобождают', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });

  const rows = [];
  let clock = 0;
  let cpu = 0;
  let active = 0;
  let gc;
  const histogram = {
    max: 250_000_000,
    percentile: () => 100_000_000,
    reset() {},
    enable() {
      active += 1;
    },
    disable() {
      active -= 1;
    },
  };
  const monitor = createRuntimeDiagnostics((row) => rows.push(row), {
    now: () => clock,
    cpu: () => cpu,
    memory: () => ({ rss: 20_000_000, heapUsed: 10_000_000 }),
    histogram: () => histogram,
    observeGc: (callback) => {
      gc = callback;

      return () => gc = null;
    },
  });

  t.mock.timers.tick(5000);
  assert.equal(rows.length, 0);
  monitor.setEnabled(true);
  assert.equal(active, 1);
  gc(30);
  clock = 5000;
  cpu = 500_000;
  t.mock.timers.tick(5000);
  assert.equal(rows[0].event, 'server.runtime');
  assert.equal(rows[0].loopMaxMs, 250);
  assert.equal(rows[0].loopP95Ms, 100);
  assert.equal(rows[0].cpuPercent, 10);
  assert.equal(rows[0].gcMs, 30);
  assert.equal(rows[0].gcCount, 1);
  assert.equal(rows[0].rss, 20_000_000);

  const lateGc = gc;

  monitor.setEnabled(false);
  assert.equal(active, 0);
  assert.equal(gc, null);
  t.mock.timers.tick(50_000);
  assert.equal(rows.length, 1);
  monitor.setEnabled(true);
  lateGc(99);
  clock = 10_000;
  t.mock.timers.tick(5000);
  assert.equal(rows[1].gcCount, 0);
  assert.equal(rows[1].gcMs, 0);
  monitor.close();
  monitor.close();
  assert.equal(active, 0);
});
