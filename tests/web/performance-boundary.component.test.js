import assert from 'node:assert/strict';
import test from 'node:test';
import { api, setApiLogSink } from '../../web/src/shared/apiClient.ts';
import { createWebLog } from '../../web/src/shared/webLog.ts';
import { installSurfacePerformance } from '../../web/src/shared/surfacePerformanceRuntime.ts';
import * as intents from '../../web/src/shared/surfaceIntents.ts';
import { compileModule, webFile } from './helpers/compile-vue.js';
import { LOCAL_TASK, mountLocalCard } from './helpers/grigdesk-task-card.js';

test('первый запрос настоящего TaskModal получает ранний span и serverRequest', async (t) => {
  let log;
  let release;

  t.mock.method(globalThis, 'fetch', () => new Promise((resolve) => release = resolve));

  const card = await mountLocalCard(t, {
    load: () => api.get('/api/auth/state', { retry: false }),
    wrap: async (TaskModal, { browser }) => {
      globalThis.__performanceIntents = intents;

      const { default: Boundary } = await compileModule(webFile('src/shared/performanceBoundary.ts'), {
        stubs: { './surfaceIntents.ts':
          'export const { beginSurfaceIntent } = globalThis.__performanceIntents;' },
      });
      const { h } = await import('../../web/node_modules/vue/index.mjs');

      log = createWebLog({
        now: () => new Date(),
        monotonicNow: () => 0,
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

      const stop = installSurfacePerformance({
        log,
        win: browser,
        doc: browser.document,
        router: {
          currentRoute: { value: { path: '/board' } },
          beforeEach: () => () => {},
          afterEach: () => () => {},
          onError: () => () => {},
        },
        now: () => 0,
        isVisible: () => true,
        afterUpdate: (callback) => queueMicrotask(callback),
      });

      setApiLogSink((event, data) => log.record(event, data), () => true);
      t.after(() => {
        stop();
        setApiLogSink(null);
        delete globalThis.__performanceIntents;
      });

      return { render: () => h(Boundary, {
        kind: 'dialog',
        target: () => 'task',
        identity: () => `grigdesk:${LOCAL_TASK.id}`,
      }, () => h(TaskModal)) };
    },
  });
  const start = log.snapshot().entries.find((row) => row.ev === 'perf.surface'
    && row.data.target === 'task');

  assert.ok(start);
  assert.equal(typeof release, 'function');
  release(new Response(JSON.stringify(LOCAL_TASK), { headers: {
    'X-GrigDesk-Request': 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
  } }));
  await card.flushPromises();

  const complete = log.snapshot().entries.find((row) => row.ev === 'api.complete');

  assert.equal(complete.data.surface, start.data.surface);
  assert.equal(complete.data.serverRequest, 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');
});

test('повторный показ смонтированного ToolHost начинает контекст до active watcher', async (t) => {
  const { hostFixture } = await import('./helpers/tool-window-harness.js');
  let log;

  globalThis.__performanceIntents = intents;
  t.after(() => delete globalThis.__performanceIntents);
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { headers: {
    'X-GrigDesk-Request': 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
  } }));

  const host = await hostFixture(t, {
    onActivate: () => api.get('/api/auth/state', { retry: false }),
    extraStubs: { './surfaceIntents.ts':
      'export const { beginSurfaceIntent } = globalThis.__performanceIntents;' },
  });

  log = createWebLog({
    now: () => new Date(),
    monotonicNow: () => 0,
    pageId: 'page-aaaaaaaaaaaaaaaa',
    tabId: 'tab-bbbbbbbbbbbbbbbb',
    version: 'dev',
    context: () => ({
      route: '/chats',
      vis: 'visible',
      boot: null
    }),
    level: 'verbose',
  });

  const stop = installSurfacePerformance({
    log,
    win: host.browser,
    doc: host.browser.document,
    router: host.router,
    now: () => 0,
    isVisible: () => true,
    afterUpdate: (callback) => queueMicrotask(callback),
  });

  t.after(() => {
    stop();
    setApiLogSink(null);
  });
  setApiLogSink((event, data) => log.record(event, data), () => true);
  host.dock.open('code');
  await host.settle();
  host.dock.close();
  await host.settle();
  log.clear();
  host.dock.open('code');
  await host.settle();

  const rows = log.snapshot().entries;
  const start = rows.find((row) => row.ev === 'perf.surface' && row.data.target === 'code');
  const complete = rows.find((row) => row.ev === 'api.complete');

  assert.ok(start);
  assert.equal(complete.data.surface, start.data.surface);
  assert.equal(complete.data.serverRequest, 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');
  assert.equal(host.mounts.filter((id) => id === 'code').length, 1);
});
