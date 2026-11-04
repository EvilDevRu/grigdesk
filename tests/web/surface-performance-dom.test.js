import { performanceSurface } from '../../web/src/shared/performanceContext.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Window } from '../../web/node_modules/happy-dom/lib/index.js';
import { createWebLog } from '../../web/src/shared/webLog.ts';
import { installSurfacePerformance } from '../../web/src/shared/surfacePerformanceRuntime.ts';

/**
 * Поддельны только часы, кадры и геометрия; DOM и MutationObserver настоящие.
 * Содержимое элементов намеренно содержит секрет, который не должен читаться логом.
 */
function fixture(t) {
  const win = new Window({ url: 'http://fixture.test/' });
  const hooks = {
    before() {},
    after() {},
    error() {}
  };
  const frames = new Map();
  let nextFrame = 0;
  let clock = 0;
  const route = {
    path: '/board',
    fullPath: '/board',
    name: 'board'
  };
  const router = {
    currentRoute: { value: route },
    beforeEach: (fn) => {
      hooks.before = fn;

      return () => {};
    },
    afterEach: (fn) => {
      hooks.after = fn;

      return () => {};
    },
    onError: (fn) => {
      hooks.error = fn;

      return () => {};
    },
  };
  const log = createWebLog({
    now: () => new Date(1_700_000_000_000 + clock),
    monotonicNow: () => clock,
    pageId: 'page-aaaaaaaaaaaaaaaa',
    tabId: 'tab-bbbbbbbbbbbbbbbb',
    version: 'dev',
    context: () => ({
      route: router.currentRoute.value.path,
      vis: 'visible',
      boot: null
    }),
    level: 'verbose',
  });

  win.requestAnimationFrame = (callback) => {
    frames.set(nextFrame += 1, callback);

    return nextFrame;
  };
  win.cancelAnimationFrame = (id) => frames.delete(id);
  Object.defineProperty(win.document, 'visibilityState', { value: 'visible', configurable: true });

  const stop = installSurfacePerformance({
    log,
    router,
    win,
    doc: win.document,
    now: () => clock,
    isVisible: (element) => !element.hidden,
    afterUpdate: (callback) => queueMicrotask(callback),
  });

  t.after(() => {
    stop();
    win.close();
  });

  return {
    win,
    log,
    router,
    hooks,
    frames,
    at(value) {
      clock = value;
    },
    async flush() {
      await win.happyDOM.whenAsyncComplete();
      await Promise.resolve();
    },
    frame() {
      const callbacks = [...frames.values()];

      frames.clear();
      callbacks.forEach((callback) => callback(clock));
    },
  };
}

test('маршрут ждёт каркас и два кадра, быстрый повтор тоже сохраняется', async (t) => {
  const f = fixture(t);
  const to = {
    path: '/projects/private',
    fullPath: '/projects/private',
    name: 'projects'
  };

  f.hooks.before(to);
  f.router.currentRoute.value = to;
  f.hooks.after(to, {}, undefined);
  f.win.document.body.innerHTML = '<main data-perf-surface="route" data-perf-target="projects"'
    + ' data-perf-key="/projects/private"><div data-ui-loading>secret</div></main>';
  await f.flush();
  f.frame();
  f.frame();
  assert.equal(f.log.snapshot().entries.some((row) => row.data.phase === 'ready'), false);
  f.at(500);
  f.win.document.querySelector('[data-ui-loading]').remove();
  await f.flush();
  f.frame();
  f.at(520);
  f.frame();

  const ready = f.log.snapshot().entries.find((row) => row.data.phase === 'ready');

  assert.ok(ready);
  assert.equal(ready.data.ms, 520);
  assert.equal(ready.data.view, '/projects/:id?');
  assert.equal(f.frames.size, 0);
  assert.doesNotMatch(JSON.stringify(f.log.snapshot()), /private|secret/u);

  const repeat = { ...to };

  f.at(600);
  f.hooks.before(repeat);
  f.router.currentRoute.value = repeat;
  f.hooks.after(repeat, to);
  await f.flush();
  f.frame();
  f.frame();
  assert.equal(f.log.snapshot().entries.at(-1).data.first, false);
  assert.equal(f.log.snapshot().entries.at(-1).data.phase, 'ready');
});

test('tool вне main, настройки и диалог имеют отдельные итоги; смена key отменяет ожидание',
  async (t) => {
    const f = fixture(t);

    f.win.document.body.innerHTML = '<main></main>'
      + '<section data-perf-surface="tool" data-perf-target="code" data-perf-key="code"'
      + ' aria-busy="true"></section>'
      + '<section data-perf-surface="dialog" data-perf-target="dialog" data-perf-key="1">'
      + '<section data-perf-surface="settings" data-perf-target="agents.models"'
      + ' data-perf-key="agents.models"><div data-ui-loading></div></section></section>';
    await f.flush();
    f.frame();
    f.frame();

    const code = f.win.document.querySelector('[data-perf-target="code"]');
    const settings = f.win.document.querySelector('[data-perf-surface="settings"]');

    code.removeAttribute('aria-busy');
    settings.setAttribute('data-perf-key', 'system.processes');
    settings.setAttribute('data-perf-target', 'system.processes');
    settings.replaceChildren();
    await f.flush();
    f.frame();
    f.frame();

    const rows = f.log.snapshot().entries.map((row) => row.data);

    assert.ok(rows.some((row) => row.target === 'agents.models' && row.phase === 'cancelled'));
    assert.ok(rows.some((row) => row.target === 'system.processes' && row.phase === 'ready'));
    assert.ok(rows.some((row) => row.kind === 'dialog' && row.phase === 'ready'));
    assert.ok(rows.some((row) => row.target === 'code' && row.phase === 'ready'));
  });

test('старый afterEach и callback кадра не завершают новое открытие', async (t) => {
  const f = fixture(t);
  const a = {
    path: '/board',
    fullPath: '/board',
    name: 'board'
  };
  const b = {
    path: '/chats',
    fullPath: '/chats',
    name: 'chats'
  };

  f.hooks.before(a);
  f.hooks.before(b);
  f.hooks.after(a, {}, undefined);
  f.router.currentRoute.value = b;
  f.hooks.after(b, a, undefined);
  f.win.document.body.innerHTML = '<main data-perf-surface="route" data-perf-target="chats"'
    + ' data-perf-key="/chats" aria-busy="true"></main>';
  await f.flush();
  f.frame();
  f.frame();
  assert.equal(f.log.snapshot().entries.some((row) => row.data.phase === 'ready'), false);
  assert.ok(f.log.snapshot().entries.some((row) => row.data.target === 'board'
    && row.data.phase === 'cancelled'));
});

test('удаление корня отменяет ожидание и снимает назначенные кадры', async (t) => {
  const f = fixture(t);

  f.win.document.body.innerHTML = '<main data-perf-surface="route" data-perf-target="board"'
    + ' data-perf-key="/board"></main>';
  await f.flush();
  assert.equal([...f.frames.values()].length > 0, true);
  f.win.document.body.innerHTML = '';
  await f.flush();

  const rows = f.log.snapshot().entries.map((row) => row.data);

  assert.equal(rows.at(-1).phase, 'cancelled');
  assert.equal(f.frames.size, 0);
});

test('hidden прекращает span и кадры, visible начинает observed без времени сна', async (t) => {
  const f = fixture(t);

  f.win.document.body.innerHTML = '<main data-perf-surface="route" data-perf-target="board"'
    + ' data-perf-key="/board"></main>';
  await f.flush();

  const late = [...f.frames.values()][0];

  assert.equal(typeof late, 'function');
  f.at(100);
  Object.defineProperty(f.win.document, 'visibilityState', { value: 'hidden', configurable: true });
  f.win.document.dispatchEvent(new f.win.Event('visibilitychange'));
  late(100);
  assert.equal(f.log.snapshot().entries.some((row) => row.data.phase === 'ready'), false);
  assert.equal(f.log.snapshot().entries.at(-1).data.phase, 'suspended');
  f.at(100_000);
  Object.defineProperty(f.win.document, 'visibilityState', { value: 'visible', configurable: true });
  f.win.document.dispatchEvent(new f.win.Event('visibilitychange'));
  await f.flush();
  f.frame();
  f.at(100_020);
  f.frame();

  const ready = f.log.snapshot().entries.at(-1).data;

  assert.equal(ready.phase, 'ready');
  assert.equal(ready.origin, 'observed');
  assert.equal(ready.ms, 20);
});

test('ошибка chunk не раскрывает текст и повтор получает собственный итог', async (t) => {
  const f = fixture(t);
  const failed = {
    path: '/projects/private',
    fullPath: '/projects/private',
    name: 'projects'
  };

  f.hooks.before(failed);
  f.hooks.error(new Error('secret chunk text'), failed);

  const retried = { ...failed };

  f.hooks.before(retried);
  f.router.currentRoute.value = retried;
  f.hooks.after(retried, {});
  f.win.document.body.innerHTML = '<main data-perf-surface="route" data-perf-target="projects"'
    + ' data-perf-key="/projects/private"></main>';
  await f.flush();
  f.frame();
  f.frame();

  const rows = f.log.snapshot().entries.map((row) => row.data);

  assert.equal(rows.filter((row) => row.phase === 'error').length, 1);
  assert.equal(rows.filter((row) => row.phase === 'ready').length, 1);
  assert.notEqual(rows.find((row) => row.phase === 'error').surface,
    rows.find((row) => row.phase === 'ready').surface);
  assert.doesNotMatch(JSON.stringify(rows), /secret|private/u);
});

test('native /surface имеет одного владельца и освобождает контекст после ready', async (t) => {
  const f = fixture(t);
  const to = {
    path: '/surface',
    fullPath: '/surface',
    name: 'surface'
  };

  f.hooks.before(to);
  f.router.currentRoute.value = to;
  f.hooks.after(to, {});
  f.win.document.body.innerHTML = '<main data-perf-surface="route" data-perf-target="surface"'
    + ' data-perf-key="/surface"></main>';
  await f.flush();
  f.frame();
  f.frame();
  assert.deepEqual(f.log.snapshot().entries.map((row) => row.data.phase), ['start', 'ready']);
  assert.equal(performanceSurface(), undefined);
});
