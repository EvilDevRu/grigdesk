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
    agents,
    search: 'yandex'
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
  const guard = { rect: null as BrowserRect | null };
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
    inputGuard: {
      ready: async () => {},
      show: (rect) => {
        guard.rect = rect;
      },
      hide: () => {
        guard.rect = null;
      },
      dispose: () => {},
    },
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
        preview: () => {
          calls.push({ tabId: id, method: 'preview' });

          return Buffer.from(`frame:${id}`).toString('base64');
        },
        /**
         * Fake снимка использует переданный runtime fence для отдельных CDP чтений.
         * Так отзыв между чтением размеров и захватом проверяется без настоящего Electron.
         */
        async screenshot(send) {
          calls.push({
            tabId: id,
            method: 'capture',
            params: record.rect,
          });

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
            /**
             * DOM-команда агента приходит функцией с payload; фейк подтверждает
             * исполнение, а resolve по-прежнему получает координаты элемента.
             */
            const declaration = String((params as { functionDeclaration?: string }).functionDeclaration ?? '');

            if (declaration.startsWith('function(payload)')) {
              return { result: { value: { ok: true } } };
            }

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
  /**
   * Монтирует панель браузера с фиксированным rect: синтетический ввод по
   * контракту BR-N31 доходит только до показанной вкладки, поэтому тесты ввода
   * обязаны сначала дать вкладке layout.
   */
  const mount = async () => {
    const instance = '44444444-4444-4444-8444-444444444444';
    const rect = {
      x: 0,
      y: 0,
      width: 800,
      height: 600
    };

    await api.invoke({ operation: 'viewport-mount', instance });
    await api.invoke({ operation: 'layout', instance, revision: 1, rect });

    return rect;
  };

  return {
    api,
    guard,
    views,
    calls,
    execute,
    open,
    mount,
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

test('BR-N-activity: native push отмечает вкладку до завершения команды агента', async (t) => {
  const f = await fixture(t);
  const tab = await f.open();
  const other = await f.open('owner-b');
  const gate = barrier();

  f.views.get(tab.tabId)!.gate = { method: 'Runtime.evaluate', barrier: gate };

  const pending = f.execute({ action: 'snapshot', tabId: tab.tabId }, tab.grantEpoch);

  await gate.entered;
  assert.equal(f.api.snapshot().tabs.find((item) => item.id === tab.tabId)!.agentWorking, true);
  assert.equal(f.api.snapshot().tabs.find((item) => item.id === other.tabId)!.agentWorking, false);
  gate.release();
  await pending;
  assert.equal(f.api.snapshot().tabs.find((item) => item.id === tab.tabId)!.agentWorking, false);

  const navigation = barrier();

  f.navigation(navigation);

  const human = f.api.invoke({
    operation: 'navigate',
    tabId: tab.tabId,
    url: 'http://fixture.test/next'
  });

  await navigation.entered;
  assert.equal(f.api.snapshot().tabs.find((item) => item.id === tab.tabId)!.agentWorking, false);
  navigation.release();
  await human;
});

test('BR-N-lock: занятая вкладка защищена native-слоем и от ручных IPC-действий', async (t) => {
  const f = await fixture(t);
  const tab = await f.open();
  const rect = await f.mount();
  const gate = barrier();

  f.views.get(tab.tabId)!.gate = { method: 'Runtime.evaluate', barrier: gate };

  const pending = f.execute({ action: 'snapshot', tabId: tab.tabId }, tab.grantEpoch);

  t.after(() => gate.release());
  await gate.entered;
  assert.deepEqual(f.guard.rect, rect);
  assert.deepEqual(f.views.get(tab.tabId)!.rect, rect, 'сайт остаётся показанным для CDP');

  for (const request of [
    { operation: 'navigate', url: 'http://fixture.test/other' },
    { operation: 'reload' },
    { operation: 'back' },
    { operation: 'forward' },
    { operation: 'zoom', percent: 150 },
    { operation: 'close' },
    { operation: 'move', beforeId: null },
  ]) {
    await assert.rejects(f.api.invoke({ ...request, tabId: tab.tabId }), /browser_tab_busy/u);
  }

  assert.deepEqual(await f.execute({
    action: 'grant',
    human: true,
    tabId: tab.tabId,
    pageEpoch: tab.pageEpoch,
  }, tab.grantEpoch), { ok: false, error: 'browser_tab_busy' });

  const other = await f.open('owner-b');

  assert.equal(f.guard.rect, null, 'другая вкладка остаётся доступна');
  await f.api.invoke({ operation: 'activate', tabId: tab.tabId });
  assert.deepEqual(f.guard.rect, rect);
  f.guard.rect = null;
  f.views.get(tab.tabId)!.events.focused?.();
  assert.deepEqual(f.guard.rect, rect, 'повторный фокус guest восстанавливает shield');
  gate.release();
  await pending;
  assert.equal(f.guard.rect, null);
  await f.api.invoke({
    operation: 'zoom',
    tabId: tab.tabId,
    percent: 150
  });
  assert.equal(f.views.get(tab.tabId)!.zoom, 1.5);
  assert.equal(f.api.snapshot().tabs.some((item) => item.id === other.tabId), true);
});

test('BR-N-lock-revoke: экстренный отзыв работает и ошибка команды снимает блокировку', async (t) => {
  const f = await fixture(t);
  const tab = await f.open();
  const rect = await f.mount();
  const gate = barrier();

  f.views.get(tab.tabId)!.gate = { method: 'Runtime.evaluate', barrier: gate };

  const pending = f.execute({ action: 'snapshot', tabId: tab.tabId }, tab.grantEpoch);

  t.after(() => gate.release());
  await gate.entered;
  await f.api.invoke({ operation: 'pause', tabId: tab.tabId });
  await f.api.invoke({ operation: 'revoke', tabId: tab.tabId });
  assert.deepEqual(f.guard.rect, rect, 'незавершённый эффект продолжает блокировать ручной ввод');
  gate.release();
  assert.deepEqual(await pending, { ok: false, error: 'access_revoked' });
  assert.equal(f.guard.rect, null);
});

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

  await f.mount();
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

test('BR-N30: zoom вкладки масштабирует координаты Input, клик попадает в элемент', async (t) => {
  const f = await fixture(t);
  const tab = await f.open();

  await f.mount();
  const snapshot = await f.execute({ action: 'snapshot', tabId: tab.tabId }, tab.grantEpoch) as {
    pageEpoch: number;
  };

  f.views.get(tab.tabId)!.zoom = 2;

  assert.deepEqual(await f.execute({
    action: 'click',
    tabId: tab.tabId,
    ref: 'e1',
    pageEpoch: snapshot.pageEpoch
  }, tab.grantEpoch), { ok: true });

  const events = f.calls.filter((call) => call.method === 'Input.dispatchMouseEvent');

  assert.ok(events.length >= 2);
  assert.deepEqual(events.map((event) => (event.params as { x: number; y: number }).x), [20, 20]);
  assert.deepEqual(events.map((event) => (event.params as { x: number; y: number }).y), [20, 20]);

  f.views.get(tab.tabId)!.zoom = 1;

  assert.deepEqual(await f.execute({
    action: 'click',
    tabId: tab.tabId,
    ref: 'e1',
    pageEpoch: snapshot.pageEpoch
  }, tab.grantEpoch), { ok: true });

  const plain = f.calls.filter((call) => call.method === 'Input.dispatchMouseEvent').slice(-2);

  assert.deepEqual(plain.map((event) => (event.params as { x: number; y: number }).x), [10, 10]);
});

test('BR-N31: ввод — native по показанной вкладке, DOM без смонтированной панели', async (t) => {
  const f = await fixture(t);
  const first = await f.open();
  const snapshot = await f.execute({ action: 'snapshot', tabId: first.tabId }, first.grantEpoch) as {
    pageEpoch: number;
  };

  /**
   * Панель браузера не смонтирована: команда исполняется в DOM страницы через
   * isolated world — без синтетических событий окна и без показа вкладки.
   */
  const domCalls = f.calls.length;

  assert.deepEqual(await f.execute({
    action: 'click',
    tabId: first.tabId,
    ref: 'e1',
    pageEpoch: snapshot.pageEpoch
  }, first.grantEpoch), { ok: true });

  const afterDom = f.calls.slice(domCalls);

  assert.ok(afterDom.some((call) => call.method === 'Runtime.callFunctionOn'
    && String((call.params as { functionDeclaration?: string }).functionDeclaration ?? '')
      .startsWith('function(payload)')));
  assert.equal(afterDom.some((call) => call.method.startsWith('Input.')), false);
  assert.equal(f.views.get(first.tabId)!.rect, null);

  /**
   * Со смонтированной панелью ввод активирует вкладку: render показывает её
   * с rect панели и команда идёт системными событиями ввода.
   */
  const rect = await f.mount();
  const nativeCalls = f.calls.length;

  assert.deepEqual(await f.execute({
    action: 'click',
    tabId: first.tabId,
    ref: 'e1',
    pageEpoch: snapshot.pageEpoch
  }, first.grantEpoch), { ok: true });

  assert.ok(f.calls.slice(nativeCalls).some((call) => call.method === 'Input.dispatchMouseEvent'));
  assert.deepEqual(f.views.get(first.tabId)!.rect, rect);

  /**
   * Открытие второй вкладки активирует её и скрывает первую; ввод в первую
   * возвращает ей активность и показ, не оставляя ввод в отсоединённом view.
   */
  const second = await f.execute({
    action: 'open',
    url: 'http://fixture.test/second'
  }, 0) as TabResult;

  assert.equal(second.ok, true);
  assert.notEqual(second.tabId, first.tabId);
  assert.equal(f.views.get(first.tabId)!.rect, null);
  assert.deepEqual(await f.execute({
    action: 'click',
    tabId: first.tabId,
    ref: 'e1',
    pageEpoch: snapshot.pageEpoch
  }, first.grantEpoch), { ok: true });
  assert.deepEqual(f.views.get(first.tabId)!.rect, rect);
  assert.equal(f.views.get(second.tabId)!.rect, null);

  /**
   * После размонтирования панели ввод снова уходит в DOM-путь: приёмка фабрики
   * не зависит от того, открыт ли инструмент браузера. Повторный mount новым
   * instance не восстанавливает layout до явной команды.
   */
  await f.api.invoke({ operation: 'viewport-unmount', instance: '44444444-4444-4444-8444-444444444444' });
  await f.api.invoke({ operation: 'viewport-mount', instance: '55555555-5555-4555-8555-555555555555' });
  const againDom = f.calls.length;

  assert.deepEqual(await f.execute({
    action: 'click',
    tabId: first.tabId,
    ref: 'e1',
    pageEpoch: snapshot.pageEpoch
  }, first.grantEpoch), { ok: true });
  assert.equal(f.calls.slice(againDom).some((call) => call.method.startsWith('Input.')), false);
  assert.equal(f.views.get(first.tabId)!.rect, null);
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

  await f.mount();
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

test('BR-N32: снимок скрытого guest не показывает его и не отменяет новый layout', async (t) => {
  const f = await fixture(t);
  const tab = await f.open();
  const view = f.views.get(tab.tabId)!;
  const gate = barrier();

  t.after(() => gate.release());
  view.captureWithCdp = true;
  view.gate = { method: 'Page.getLayoutMetrics', barrier: gate };

  const pending = f.execute({ action: 'screenshot', tabId: tab.tabId }, tab.grantEpoch);

  await gate.entered;
  assert.equal(f.calls.find((call) => call.method === 'capture')!.params, null);
  await f.mount();
  gate.release();
  await pending;
  assert.notEqual(view.rect, null, 'завершение снимка не отменяет новый layout');
  assert.deepEqual(await f.execute({ action: 'close', tabId: tab.tabId }, tab.grantEpoch), { ok: true });
});

test('BR-N33: зависший снимок не отзывает grant и не оставляет поздний сторож', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const f = await fixture(t);
  const tab = await f.open();
  const view = f.views.get(tab.tabId)!;
  const gate = barrier();

  t.after(() => gate.release());
  view.captureWithCdp = true;
  view.gate = { method: 'Page.captureScreenshot', barrier: gate };

  const pending = f.execute({ action: 'screenshot', tabId: tab.tabId }, tab.grantEpoch);

  await gate.entered;
  t.mock.timers.tick(10001);
  assert.deepEqual(await pending, { ok: false, error: 'browser_capture_failed' });
  assert.deepEqual(await f.execute({ action: 'console', tabId: tab.tabId }, tab.grantEpoch), {
    ok: true,
    console: [{ level: 'error', text: 'fixture error' }],
    untrusted: true,
  });
  gate.release();
});

test('BR-N35: свежий кадр за две секунды укладывается в общий срок снимка', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const f = await fixture(t);
  const tab = await f.open();
  const view = f.views.get(tab.tabId)!;
  const gate = barrier();

  t.after(() => gate.release());
  view.captureWithCdp = true;
  view.gate = { method: 'Page.captureScreenshot', barrier: gate };

  const pending = f.execute({ action: 'screenshot', tabId: tab.tabId }, tab.grantEpoch);

  await gate.entered;
  t.mock.timers.tick(2100);
  gate.release();

  const result = await pending as { format?: string };

  assert.equal(result.format, 'grigdesk-work-content-v1');
});

test('BR-N34: длинная серия по трём вкладкам сохраняет grants после навигаций и снимков', async (t) => {
  const f = await fixture(t);
  const tabs: TabResult[] = [];

  for (let index = 0; index < 3; index += 1) {
    tabs.push(await f.execute({ action: 'open', url: `http://fixture.test/${index}` }) as TabResult);
  }

  for (let index = 0; index < 12; index += 1) {
    const tab = tabs[index % tabs.length]!;
    const view = f.views.get(tab.tabId)!;

    view.events.start();
    view.events.navigated(`http://fixture.test/section-${index}`);

    const observation = await f.execute({ action: 'snapshot', tabId: tab.tabId }, tab.grantEpoch) as {
      ok: boolean;
      pageEpoch: number;
    };

    assert.equal(observation.ok, true);

    for (const action of ['click', 'fill'] as const) {
      assert.deepEqual(await f.execute({
        action,
        tabId: tab.tabId,
        pageEpoch: observation.pageEpoch,
        ref: 'e1',
        ...(action === 'fill' ? { text: 'проверка' } : {}),
      }, tab.grantEpoch), { ok: true });
    }

    const shot = await f.execute({ action: 'screenshot', tabId: tab.tabId }, tab.grantEpoch) as {
      format: string;
    };

    assert.equal(shot.format, 'grigdesk-work-content-v1');
    assert.equal(view.rect, null);
  }

  assert.equal(f.api.snapshot().grants.length, 3);
  assert.equal(f.api.snapshot().grants.every((grant) => !grant.paused && grant.grantEpoch === 1), true);
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
    search: 'yandex',
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

test('BR-N-move: native snapshot сохраняет порядок, grant и активную страницу', async (t) => {
  const f = await fixture(t);
  const first = await f.open('owner-a');
  const second = await f.open('owner-b');
  const third = await f.open('owner-c');
  const grants = f.api.snapshot().grants;

  await f.api.invoke({
    operation: 'move',
    tabId: third.tabId,
    beforeId: first.tabId,
  });
  assert.deepEqual(f.api.snapshot().tabs.map((tab) => tab.id), [third.tabId, first.tabId, second.tabId]);
  assert.equal(f.api.snapshot().active, third.tabId);
  assert.deepEqual(f.api.snapshot().grants, [grants[2], grants[0], grants[1]]);
  await f.api.invoke({
    operation: 'move',
    tabId: third.tabId,
    beforeId: null,
  });
  assert.deepEqual(f.api.snapshot().tabs.map((tab) => tab.id), [first.tabId, second.tabId, third.tabId]);
  await assert.rejects(() => f.api.invoke({
    operation: 'move',
    tabId: first.tabId,
    beforeId: 'missing',
  }),
    /browser_tab_missing/u);
  await assert.rejects(() => f.api.invoke({
    operation: 'move',
    tabId: first.tabId,
    beforeId: 1,
  }),
    /browser_request_invalid/u);
  assert.equal([...f.views.values()].some((view) => view.closed), false);
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

test('BR-N-COVER: подложка принадлежит текущим viewport и вкладке, grant сохраняется', async (t) => {
  const f = await fixture(t);
  const tab = await f.open();
  const rect = await f.mount();
  const instance = '44444444-4444-4444-8444-444444444444';
  const cover = {
    operation: 'cover',
    instance,
    revision: 2,
  };

  assert.equal(f.api.hide({ ...cover, instance: 'old-instance' }), null);
  assert.deepEqual(f.views.get(tab.tabId)!.rect, rect);
  assert.equal(f.api.hide({ ...cover, revision: 1 }), null);
  assert.deepEqual(f.views.get(tab.tabId)!.rect, rect);
  assert.equal(f.api.hide(cover), Buffer.from(`frame:${tab.tabId}`).toString('base64'));
  assert.equal(f.views.get(tab.tabId)!.rect, null);
  assert.equal(f.api.hide({ ...cover, revision: 3 }), null, 'скрытая вкладка не отдаёт старый кадр');
  assert.equal(f.calls.filter((call) => call.method === 'preview').length, 1);
  assert.equal(f.api.snapshot().tabs[0]!.grantEpoch, tab.grantEpoch);
  await f.api.invoke({
    operation: 'layout',
    instance,
    revision: 4,
    rect,
  });
  assert.deepEqual(f.views.get(tab.tabId)!.rect, rect);
  f.api.documentChanged();
  assert.equal(f.api.hide({ ...cover, revision: 5 }), null);
});

test('BR-N-LIMIT: больше 20 вкладок разных владельцев открываются без общего лимита', async (t) => {
  const f = await fixture(t);

  for (let index = 0; index < 20; index += 1) {
    const opened = await f.execute({
      action: 'open',
      url: `http://fixture.test/page-${index}`,
    }, 0, 'owner-b') as TabResult;

    assert.equal(opened.ok, true);
  }

  assert.deepEqual(await f.execute({ action: 'list' }), { ok: true, tabs: [] });
  assert.equal((await f.open()).ok, true);
  await f.api.invoke({
    operation: 'open',
    url: '',
    target: 'internal',
  });
  assert.equal(f.api.snapshot().tabs.length, 22);

  const existing = await f.execute({
    action: 'open',
    url: 'http://fixture.test/page-0',
  }, 0, 'owner-b') as TabResult;

  assert.equal(existing.ok, true);
  assert.equal(f.api.snapshot().tabs.length, 22);
  await f.api.invoke({ operation: 'close', tabId: existing.tabId });
  assert.equal((await f.open()).ok, true);
});

test('BR-N-IDLE: обращение к странице продлевает срок, list и state не мешают очистке', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const f = await fixture(t);
  const tab = await f.open();
  let time = 100;

  /**
   * Живой host продлевает lease каждые пять секунд независимо от команд агента.
   * Эти heartbeat не должны продлевать срок простоя самой вкладки.
   */
  async function advance(ms: number): Promise<void> {
    for (let remaining = ms; remaining > 0; remaining -= 5000) {
      const step = Math.min(remaining, 5000);

      time += step;
      f.clock(time);
      await f.api.invoke({
        operation: 'host-start',
        hostId: 'host-a',
        hostEpoch: 1,
        leaseUntil: time + 15000,
      });
      t.mock.timers.tick(step);
    }
  }

  await advance(240000);
  assert.equal((await f.execute({ action: 'console', tabId: tab.tabId }, tab.grantEpoch) as
    { ok: boolean }).ok, true);
  await advance(60000);
  assert.equal((await f.execute({ action: 'list' }) as { tabs: unknown[] }).tabs.length, 1);
  await f.api.invoke({ operation: 'state' });
  await advance(240000);
  assert.equal(f.api.snapshot().tabs.length, 0);
  assert.equal(f.views.get(tab.tabId)!.closed, true);
});

test('BR-N-reconnect: новый open восстанавливает собственную вкладку после потери host', async (t) => {
  const f = await fixture(t);
  const tab = await f.open();

  await f.api.invoke({
    operation: 'host-stop',
    hostId: 'host-a',
    hostEpoch: 1
  });
  await f.api.invoke({
    operation: 'host-start',
    hostId: 'host-a',
    hostEpoch: 1,
    leaseUntil: 15100
  });
  assert.deepEqual(await f.execute({ action: 'list' }), { ok: true, tabs: [] });
  assert.deepEqual(await f.execute({ action: 'console', tabId: tab.tabId }, tab.grantEpoch),
    { ok: false, error: 'access_revoked' });

  const reopened = await f.open();

  assert.equal(reopened.tabId, tab.tabId);
  assert.ok(reopened.grantEpoch > tab.grantEpoch);
  assert.equal((await f.execute({ action: 'snapshot', tabId: tab.tabId }, reopened.grantEpoch) as
    { ok: boolean }).ok, true);
  assert.equal(f.api.snapshot().tabs.length, 1);
});

test('BR-N-reconnect-deny: технический reconnect не отменяет решения человека', async (t) => {
  for (const operation of ['revoke', 'pause'] as const) {
    for (const before of [true, false]) {
      const f = await fixture(t);
      const tab = await f.open();

      if (before) {
        await f.api.invoke({ operation, tabId: tab.tabId });
      }

      await f.api.invoke({
        operation: 'host-stop',
        hostId: 'host-a',
        hostEpoch: 1
      });

      if (!before) {
        await f.api.invoke({ operation, tabId: tab.tabId });
      }

      await f.api.invoke({
        operation: 'host-start',
        hostId: 'host-a',
        hostEpoch: 1,
        leaseUntil: 15100
      });
      assert.deepEqual(await f.execute({ action: 'open', url: 'http://fixture.test/' }),
        { ok: false, error: 'access_revoked' });
    }
  }
});

test('BR-N-reconnect-origin: другой origin отменяет восстановление', async (t) => {
  const f = await fixture(t);
  const tab = await f.open();

  await f.api.invoke({
    operation: 'host-stop',
    hostId: 'host-a',
    hostEpoch: 1
  });
  f.views.get(tab.tabId)!.events.navigated('http://other.test/');
  f.views.get(tab.tabId)!.events.navigated('http://fixture.test/');
  await f.api.invoke({
    operation: 'host-start',
    hostId: 'host-a',
    hostEpoch: 1,
    leaseUntil: 15100
  });
  assert.deepEqual(await f.execute({ action: 'open', url: 'http://fixture.test/' }),
    { ok: false, error: 'access_revoked' });
});

test('BR-N-reconnect-transfer: переданная вкладка не восстанавливается', async (t) => {
  const f = await fixture(t);
  const tab = await f.open();

  await f.execute({
    action: 'grant',
    human: true,
    tabId: tab.tabId,
    pageEpoch: tab.pageEpoch
  }, tab.grantEpoch, 'owner-b');
  await f.api.invoke({
    operation: 'host-start',
    hostId: 'host-b',
    hostEpoch: 2,
    leaseUntil: 15100
  });

  const result = await f.api.invoke({
    operation: 'execute',
    command: {
      action: 'open',
      url: 'http://fixture.test/',
      owner: 'owner-a',
      requestId: 'new-host-open',
      hostId: 'host-b',
      hostEpoch: 2,
      grantEpoch: 0,
      deadline: 10100
    }
  });

  assert.deepEqual(result, { ok: false, error: 'access_revoked' });
});
