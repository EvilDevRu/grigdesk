import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserApi } from '../../desktop/src/browser/browserApi.ts';
import type { BrowserPreferences } from '../../shared/browser/browserContract.ts';
import type { BrowserViewEvents, NativeBrowserView } from '../../desktop/src/browser/browserView.ts';
import type { BrowserRect } from '../../desktop/src/browser/browserTabs.ts';
import type { TestContext } from 'node:test';

type Snapshot = ReturnType<ReturnType<typeof createBrowserApi>['snapshot']>;
interface TabResult {
  ok: boolean;
  tabId: string;
  url: string;
  grantEpoch: number;
  pageEpoch: number;
}

/**
 * Promise barrier замораживает один native await без задержек и polling.
 * entered подтверждает именно начало выбранной операции.
 */
function barrier() {
  let enter = () => {};
  let release = () => {};
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    enter,
    release,
    entered,
    waiting
  };
}

/**
 * Fixture исполняет настоящий runtime/driver/protocol с fake Electron port.
 * Она не запускает браузер и не использует личные cookies или runtime.
 */
async function fixture(t: TestContext, agents = true) {
  let clock = 100;
  let serial = 0;
  let request = 0;
  let preferences: BrowserPreferences = {
    open: 'external',
    external: 'system',
    agents
  };
  let commitGate: ReturnType<typeof barrier> | null = null;
  let failCommit = false;
  let navigationGate: ReturnType<typeof barrier> | null = null;
  const calls: {
    tabId: string;
    method: string;
    params?: unknown
  }[] = [];
  const listeners = new Set<(value: Snapshot) => void>();
  const views = new Map<string, {
    events: BrowserViewEvents;
    scope: string;
    rect: BrowserRect | null;
    closed: boolean;
    captureWithCdp: boolean;
    captureFailure: boolean;
    zoom: number;
    gate: { method: string; barrier: ReturnType<typeof barrier> } | null;
  }>();
  const api = createBrowserApi({
    now: () => clock,
    id: () => `tab${++serial}`,
    preferences: () => preferences,
    commit: async (next) => {
      if (commitGate) {
        commitGate.enter();
        await commitGate.waiting;
      }

      if (failCommit) {
        throw new Error('disk');
      }

      preferences = next;
    },
    apps: async () => [{ id: 'app:fixture', name: 'Fixture' }],
    chooseApp: async () => ({ id: 'app:fixture', name: 'Fixture' }),
    external: async () => {
      calls.push({ tabId: '', method: 'external' });
    },
    bounds: () => ({
      width: 1000,
      height: 800,
      zoom: 1
    }),
    changed: (value) => {
        for (const listener of listeners) {
          listener(value as Snapshot);
        }
    },
    view: ({ id, scope, events }): NativeBrowserView => {
      const record = {
        events,
        scope,
        rect: null as BrowserRect | null,
        closed: false,
        captureWithCdp: false,
        captureFailure: false,
        zoom: 1,
        gate: null as { method: string; barrier: ReturnType<typeof barrier> } | null
      };

      views.set(id, record);

      return {
        state: () => ({
          canBack: false,
          canForward: false,
          zoom: record.zoom * 100
        }),
        async navigate(url) {
          events.start();

          if (navigationGate) {
            const gate = navigationGate;

            navigationGate = null;
            gate.enter();
            await gate.waiting;
          }

          events.navigated(url);
        },
        show: (rect) => {
          record.rect = rect;
        },
        hide: () => {
          record.rect = null;
        },
        destroy: () => {
          record.closed = true;
        },
        history: () => {},
        reload: () => {},
        zoom: (factor) => {
          record.zoom = factor;
        },
        /**
         * Fake снимка использует переданный runtime fence для отдельных CDP чтений.
         * Так отзыв между чтением размеров и захватом проверяется без настоящего Electron.
         */
        async screenshot(send) {
          if (record.captureFailure) {
            throw new Error('Failed to capture page');
          }

          if (record.captureWithCdp) {
            await send('Page.getLayoutMetrics');
            await send('Page.captureScreenshot');
          }

          return 'AQ==';
        },
        console: () => [{ level: 'error', text: 'fixture error' }],
        /**
         * Fake CDP сохраняет вызовы и отдаёт bounded fixture-ответы протокола.
         * Барьер удерживает точный метод для проверки отзыва во время await.
         */
        async send(method, params) {
          calls.push({
            tabId: id,
            method,
            params
          });

          if (record.gate?.method === method) {
            const gate = record.gate.barrier;

            record.gate = null;
            gate.enter();
            await gate.waiting;
          }

          if (method === 'Page.getFrameTree') {
            return { frameTree: { frame: { id: 'frame-a' } } };
          }

          if (method === 'Page.createIsolatedWorld') {
            return { executionContextId: 1 };
          }

          if (method === 'Runtime.evaluate') {
            const value = params as { expression?: string };

            return value.expression === 'globalThis' ? { result: { objectId: 'global-a' } }
              : { result: { value: { text: 'fixture', elements: [{ ref: 'e1', name: 'Button' }] } } };
          }

          if (method === 'Runtime.callFunctionOn') {
            return { result: { value: {
              x: 10,
              y: 10,
              editable: true
            } } };
          }

          return {};
        },
      };
    },
  });

  t.after(() => api.dispose());

  if (agents) {
    await api.invoke({
      operation: 'host-start',
      hostId: 'host-a',
      hostEpoch: 1,
      leaseUntil: clock + 15000
    });
  }

  const execute = (input: Record<string, unknown>, epoch = 0, owner = 'owner-a',
    valid: () => boolean = () => true,
  ) => api.invoke({ operation: 'execute', command: {
    ...input,
    requestId: `request${++request}`,
    hostId: 'host-a',
    hostEpoch: 1,
    owner,
    grantEpoch: epoch,
    deadline: clock + 10000,
  } }, valid);
  const open = async (owner = 'owner-a') => {
    const result = await execute({ action: 'open', url: 'http://fixture.test/' }, 0, owner) as TabResult;

    assert.equal(result.ok, true);

    return result;
  };

  return {
    api,
    views,
    calls,
    execute,
    open,
    navigation: (gate: ReturnType<typeof barrier>) => {
      navigationGate = gate;
    },
    clock: (value: number) => {
      clock = value;
    },
    commit: (gate: ReturnType<typeof barrier>, fail: boolean) => {
      commitGate = gate;
      failCommit = fail;
    },
    /**
     * Изменение native state наблюдается subscription, без фиксированного sleep.
     * Подписка снимается сразу при достижении требуемого состояния.
     */
    until(predicate: (state: Snapshot) => boolean): Promise<Snapshot> {
      const current = api.snapshot();

      if (predicate(current)) {
        return Promise.resolve(current);
      }

      return new Promise((resolve) => {
        const listener = (state: Snapshot) => {
          if (predicate(state)) {
            listeners.delete(listener);
            resolve(state);
          }
        };

        listeners.add(listener);
      });
    },
  };
}

test('BR-N01: human tab невидима агенту до explicit grant и после revoke', async (t) => {
  const f = await fixture(t);

  await f.api.invoke({
    operation: 'open',
    url: 'http://fixture.test/',
    target: 'internal'
  });

  const tab = f.api.snapshot().tabs[0]!;

  assert.equal(tab.owner, null);
  assert.equal(f.api.snapshot().grants.length, 0);
  assert.deepEqual(await f.execute({ action: 'list' }), { ok: true, tabs: [] });
  assert.deepEqual(await f.execute({ action: 'snapshot', tabId: tab.id }, tab.grantEpoch),
    { ok: false, error: 'access_revoked' });

  const snapshot = await f.execute({
    action: 'grant',
    human: true,
    tabId: tab.id,
    pageEpoch: tab.pageEpoch,
  }, tab.grantEpoch) as Snapshot;
  const granted = snapshot.tabs[0]!;
  const read = await f.execute({ action: 'snapshot', tabId: tab.id }, granted.grantEpoch) as { ok: boolean };

  assert.equal(read.ok, true);
  await f.api.invoke({ operation: 'revoke', tabId: tab.id });
  assert.equal(f.api.snapshot().grants.length, 0);
  assert.deepEqual(await f.execute({ action: 'console', tabId: tab.id }, granted.grantEpoch),
    { ok: false, error: 'access_revoked' });
});

test('BR-N02: второй snapshot меняет pageEpoch; S1 ref не нажимает S2 документ', async (t) => {
  const f = await fixture(t);
  const tab = await f.open();
  const first = await f.execute({ action: 'snapshot', tabId: tab.tabId }, tab.grantEpoch) as {
    pageEpoch: number;
  };
  const second = await f.execute({ action: 'snapshot', tabId: tab.tabId }, tab.grantEpoch) as {
    pageEpoch: number;
  };
  const before = f.calls.filter((call) => call.method.startsWith('Input.')).length;

  assert.ok(second.pageEpoch > first.pageEpoch);
  assert.deepEqual(await f.execute({
    action: 'click',
    tabId: tab.tabId,
    ref: 'e1',
    pageEpoch: first.pageEpoch
  }, tab.grantEpoch), { ok: false, error: 'stale_page' });
  assert.equal(f.calls.filter((call) => call.method.startsWith('Input.')).length, before);
});

test('BR-N03: pause/resume не оживляет queued старый grantEpoch', { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const tab = await f.open();
  const gate = barrier();

  f.views.get(tab.tabId)!.gate = { method: 'Page.getFrameTree', barrier: gate };

  const pending = f.execute({ action: 'snapshot', tabId: tab.tabId }, tab.grantEpoch);

  await gate.entered;

  const click = f.execute({
    action: 'click',
    tabId: tab.tabId,
    pageEpoch: f.api.snapshot().tabs[0]!.pageEpoch,
    ref: 'e1'
  }, tab.grantEpoch);

  await f.api.invoke({ operation: 'pause', tabId: tab.tabId });
  await f.api.invoke({ operation: 'resume', tabId: tab.tabId });
  gate.release();
  assert.deepEqual(await pending, { ok: false, error: 'access_revoked' });
  assert.deepEqual(await click, { ok: false, error: 'access_revoked' });
  assert.equal(f.calls.some((call) => call.method.startsWith('Input.')), false);
});

test('BR-N04: revoke/IPC epoch change во время resolve не отправляет Input', async (t) => {
  const f = await fixture(t);
  const tab = await f.open();
  const snapshot = await f.execute({ action: 'snapshot', tabId: tab.tabId }, tab.grantEpoch) as {
    pageEpoch: number;
  };
  const gate = barrier();
  let valid = true;

  f.views.get(tab.tabId)!.gate = { method: 'Runtime.callFunctionOn', barrier: gate };

  const pending = f.execute({
    action: 'click',
    tabId: tab.tabId,
    pageEpoch: snapshot.pageEpoch,
    ref: 'e1'
  }, tab.grantEpoch, 'owner-a', () => valid);

  await gate.entered;
  valid = false;
  gate.release();
  assert.deepEqual(await pending, { ok: false, error: 'access_revoked' });
  assert.equal(f.calls.some((call) => call.method.startsWith('Input.')), false);
});

test('BR-N04B: отзыв между CDP чтениями снимка блокирует захват', { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const tab = await f.open();
  const view = f.views.get(tab.tabId)!;

  view.captureWithCdp = true;

  const captured = await f.execute({ action: 'screenshot', tabId: tab.tabId }, tab.grantEpoch) as {
    format: string;
  };

  assert.equal(captured.format, 'grigdesk-work-content-v1');

  const gate = barrier();

  t.after(() => gate.release());
  view.gate = { method: 'Page.getLayoutMetrics', barrier: gate };

  const pending = f.execute({ action: 'screenshot', tabId: tab.tabId }, tab.grantEpoch);

  await gate.entered;
  await f.api.invoke({ operation: 'revoke', tabId: tab.tabId });
  gate.release();
  assert.deepEqual(await pending, { ok: false, error: 'access_revoked' });
  assert.equal(f.calls.filter((call) => call.method === 'Page.captureScreenshot').length, 1);
});

test('BR-N04C: отказ снимка не объявляет живой браузер недоступным', async (t) => {
  const f = await fixture(t);
  const tab = await f.open();

  f.views.get(tab.tabId)!.captureFailure = true;
  assert.deepEqual(await f.execute({ action: 'screenshot', tabId: tab.tabId }, tab.grantEpoch),
    { ok: false, error: 'browser_capture_failed' });

  const result = await f.execute({ action: 'console', tabId: tab.tabId }, tab.grantEpoch) as { ok: boolean };

  assert.equal(result.ok, true);
});

test('BR-N05: navigation begin блокирует команды; другой origin отзывает grant', async (t) => {
  const f = await fixture(t);
  const tab = await f.open();
  const view = f.views.get(tab.tabId)!;

  view.events.start();
  assert.deepEqual(await f.execute({ action: 'console', tabId: tab.tabId }, tab.grantEpoch),
    { ok: false, error: 'access_revoked' });
  view.events.navigated('http://other.test/');
  assert.equal(f.api.snapshot().tabs[0]!.paused, true);
  assert.equal(f.api.snapshot().grants.length, 0);
  assert.deepEqual(await f.execute({ action: 'screenshot', tabId: tab.tabId }, tab.grantEpoch),
    { ok: false, error: 'access_revoked' });
});

test('BR-N06: cross-origin popup наследует session, но не fresh agent grant',
  { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const tab = await f.open();
  const ready = f.until((state) => state.tabs.length === 2 && state.tabs[1]!.paused);

  f.views.get(tab.tabId)!.events.popup('http://other.test/');

  const snapshot = await ready;
  const child = snapshot.tabs[1]!;

  assert.equal(f.views.get(child.id)!.scope, f.views.get(tab.tabId)!.scope);
  assert.equal(child.grantOrigin, null);
  assert.equal(snapshot.grants.some((row) => row.tabId === child.id), false);
  assert.deepEqual(await f.execute({ action: 'snapshot', tabId: child.id }, child.grantEpoch),
    { ok: false, error: 'access_revoked' });
});

test('BR-N07: host renewal сохраняет grant; takeover и stale stop не смешивают host', async (t) => {
  const f = await fixture(t);
  const tab = await f.open();

  await f.api.invoke({
    operation: 'host-start',
    hostId: 'host-a',
    hostEpoch: 1,
    leaseUntil: 12000
  });
  assert.equal(f.api.snapshot().tabs[0]!.grantEpoch, tab.grantEpoch);
  await f.api.invoke({
    operation: 'host-start',
    hostId: 'host-b',
    hostEpoch: 2,
    leaseUntil: 13000
  });
  assert.equal(f.api.snapshot().grants.length, 0);

  const epoch = f.api.snapshot().tabs[0]!.grantEpoch;

  await f.api.invoke({
    operation: 'host-stop',
    hostId: 'host-a',
    hostEpoch: 1
  });
  assert.equal(f.api.snapshot().tabs[0]!.grantEpoch, epoch);
  assert.deepEqual(await f.execute({ action: 'console', tabId: tab.tabId }, tab.grantEpoch),
    { ok: false, error: 'access_revoked' });
});

test('BR-N08: истекшая lease не сохраняет grant при renewal той же пары', async (t) => {
  const f = await fixture(t);

  await f.open();
  f.clock(16000);
  await f.api.invoke({
    operation: 'host-start',
    hostId: 'host-a',
    hostEpoch: 1,
    leaseUntil: 30000
  });
  assert.equal(f.api.snapshot().grants.length, 0);
});

test('BR-N09: synchronous hide отсекает старый layout; remount отсекает старый instance', async (t) => {
  const f = await fixture(t);
  const tab = await f.open();
  const first = '11111111-1111-4111-8111-111111111111';
  const second = '22222222-2222-4222-8222-222222222222';
  const rect = {
    x: 20,
    y: 50,
    width: 800,
    height: 600
  };

  await f.api.invoke({ operation: 'viewport-mount', instance: first });
  await f.api.invoke({
    operation: 'layout',
    instance: first,
    revision: 1,
    rect
  });
  assert.deepEqual(f.views.get(tab.tabId)!.rect, rect);
  f.api.hide({
    operation: 'hide',
    instance: first,
    revision: 3
  });
  assert.equal(f.views.get(tab.tabId)!.rect, null);
  await f.api.invoke({
    operation: 'layout',
    instance: first,
    revision: 2,
    rect
  });
  assert.equal(f.views.get(tab.tabId)!.rect, null);
  await f.api.invoke({ operation: 'viewport-mount', instance: second });
  await f.api.invoke({
    operation: 'layout',
    instance: second,
    revision: 1,
    rect
  });
  f.api.hide({
    operation: 'hide',
    instance: first,
    revision: 999
  });
  await f.api.invoke({ operation: 'viewport-unmount', instance: first });
  assert.deepEqual(f.views.get(tab.tabId)!.rect, rect);
});

test('BR-N10: disk failure/deferred commit не включает preference agents', async (t) => {
  const f = await fixture(t, false);
  const gate = barrier();

  f.commit(gate, true);

  const pending = f.api.invoke({ operation: 'preferences', value: {
    open: 'internal',
    external: 'system',
    agents: true,
  } });
  const rejected = assert.rejects(pending, /disk/u);

  await gate.entered;
  assert.equal(f.api.snapshot().preferences.agents, false);
  await assert.rejects(() => f.api.invoke({
    operation: 'host-start',
    hostId: 'host-a',
    hostEpoch: 1,
    leaseUntil: 12000
  }), /browser_request_invalid/u);
  gate.release();
  await rejected;
  assert.equal(f.api.snapshot().preferences.agents, false);
});

test('BR-N11: agent не получает protocol/source/owner metadata как model payload', async (t) => {
  const f = await fixture(t);

  await assert.rejects(() => f.execute({ action: 'evaluate', source: 'globalThis' }),
    /browser_action_invalid/u);
  await assert.rejects(() => f.execute({ action: 'open', url: 'file:///tmp/x' }),
    /invalid_browser_url/u);
  await f.api.invoke({
    operation: 'open',
    url: '',
    target: 'internal',
    deduplicate: false
  });
  assert.equal(f.api.snapshot().tabs[0]!.owner, null);
  assert.equal(f.api.snapshot().tabs[0]!.url, '');
  assert.equal(f.api.snapshot().grants.length, 0);
});
test('BR-N12: stalled open ограничен deadline и не держит owner queue после timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const f = await fixture(t);
  const gate = barrier();

  f.navigation(gate);

  const pending = f.execute({ action: 'open', url: 'http://stalled.test/' });

  await gate.entered;
  f.clock(10101);
  t.mock.timers.tick(10001);
  assert.deepEqual(await pending, { ok: false, error: 'outcome_unknown' });
  assert.equal(f.api.snapshot().tabs.length, 0);
  assert.equal([...f.views.values()][0]!.closed, true);

  const next = await f.open();

  assert.equal(f.api.snapshot().tabs[0]!.id, next.tabId);
  gate.release();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(f.api.snapshot().tabs.length, 1);
  assert.equal(f.api.snapshot().tabs[0]!.id, next.tabId);
});

test('BR-N-ZOOM: public percent переводится в Electron factor и проходит state', async (t) => {
  const f = await fixture(t);
  const tab = await f.open();

  await f.api.invoke({
    operation: 'zoom',
    tabId: tab.tabId,
    percent: 125
  });
  assert.equal(f.views.get(tab.tabId)!.zoom, 1.25);

  const snapshot = await f.api.invoke({ operation: 'state' }) as Snapshot;

  assert.equal((snapshot.tabs[0] as unknown as {zoom:number}).zoom, 125);
  await assert.rejects(() => f.api.invoke({
    operation: 'zoom',
    tabId: tab.tabId,
    percent: 301
  }),
    /browser_request_invalid/u);
  await assert.rejects(() => f.api.invoke({
    operation: 'zoom',
    tabId: tab.tabId,
    factor: 1.25
  }),
    /browser_request_invalid/u);
});

test('BR-N-LIMIT: общий лимит действует при пустом списке нового агента', async (t) => {
  const f = await fixture(t);

  for (let index = 0; index < 20; index += 1) {
    const opened = await f.execute({
      action: 'open',
      url: `http://fixture.test/page-${index}`,
    }, 0, 'owner-b') as TabResult;

    assert.equal(opened.ok, true);
  }

  assert.deepEqual(await f.execute({ action: 'list' }), { ok: true, tabs: [] });
  assert.deepEqual(await f.execute({ action: 'open', url: 'http://fixture.test/new' }), {
    ok: false,
    error: 'browser_tab_limit',
  });
  assert.equal(f.api.snapshot().tabs.length, 20);

  const existing = await f.execute({
    action: 'open',
    url: 'http://fixture.test/page-0',
  }, 0, 'owner-b') as TabResult;

  assert.equal(existing.ok, true);
  assert.equal(f.api.snapshot().tabs.length, 20);
  await f.api.invoke({ operation: 'close', tabId: existing.tabId });
  assert.equal((await f.open()).ok, true);
});
