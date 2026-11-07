import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebLog } from '../../web/src/shared/webLog.ts';
import { createSurfacePerformance } from '../../web/src/shared/surfacePerformance.ts';

test('поверхность имеет pending, один итог, повтор и сброс поколения', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  let clock = 0;
  const log = createWebLog({
    now: () => new Date(1_700_000_000_000 + clock),
    monotonicNow: () => clock,
    pageId: 'page-aaaaaaaaaaaaaaaa',
    tabId: 'tab-bbbbbbbbbbbbbbbb',
    version: 'dev',
    context: () => ({
      route: '/board',
      vis: 'visible',
      boot: null
    }),
    level: 'verbose',
  });
  const recorder = createSurfacePerformance({ log, now: () => clock });
  const info = {
    kind: 'route',
    target: 'board',
    view: '/board',
    origin: 'navigation'
  };

  t.after(() => recorder.dispose());

  const first = recorder.start(info);

  assert.ok(first);
  clock = 50;
  first.mounted();
  first.update(2);
  clock = 3000;
  t.mock.timers.tick(3000);
  t.mock.timers.tick(6000);
  clock = 3500;
  first.finish('ready');
  first.finish('error');

  const rows = log.snapshot().entries.filter((entry) => entry.ev === 'perf.surface');

  assert.deepEqual(rows.map((entry) => entry.data.phase), ['start', 'pending', 'ready']);
  assert.equal(rows[1].data.pending, 2);
  assert.equal(rows[2].data.mountedMs, 50);
  assert.equal(rows[2].data.ms, 3500);

  const second = recorder.start(info);

  assert.equal(log.snapshot().entries.at(-1).data.first, false);
  log.setLevel('off');
  log.setLevel('verbose');
  second.finish('ready');
  assert.equal(log.snapshot().entries.length, 0);
  recorder.start(info);
  recorder.suspend();
  assert.equal(log.snapshot().entries.at(-1).data.phase, 'suspended');
  assert.ok(recorder.start(info));
});

test('ограничение активных поверхностей не создаёт неограниченные ожидания', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const rows = [];
  let onLevel;
  const recorder = createSurfacePerformance({
    now: () => 0,
    log: {
      level: () => 'verbose',
      record: (ev, data) => rows.push({ ev, data }),
      subscribeLevel: (listener) => {
        onLevel = listener;

        return () => onLevel = null;
      },
    },
  });

  t.after(() => recorder.dispose());

  for (let index = 0; index < 1000; index += 1) {
    recorder.start({
      kind: 'dialog',
      target: 'dialog',
      view: '/board',
      origin: 'surface'
    });
  }

  t.mock.timers.tick(3000);
  assert.equal(rows.filter((row) => row.data.phase === 'start').length, 32);
  assert.equal(rows.filter((row) => row.data.phase === 'pending').length, 32);
  recorder.dispose();
  assert.equal(onLevel, null);
});
