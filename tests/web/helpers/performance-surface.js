import { setImmediate } from 'node:timers/promises';
import { createWebLog } from '../../../web/src/shared/webLog.ts';
import { installSurfacePerformance } from '../../../web/src/shared/surfacePerformanceRuntime.ts';

/**
 * Подменяются только геометрия и кадры happy-dom, сами страницы остаются настоящими.
 * Ошибки и ожидания приходят через существующие API-границы fixture.
 */
export function measured(t, wrapper, target, kind = 'settings',
  surfaceEl = wrapper.element?.parentElement ?? null) {
  const win = window;
  const root = surfaceEl;
  const frames = new Map();
  const previous = [win.requestAnimationFrame, win.cancelAnimationFrame];
  let serial = 0;

  win.requestAnimationFrame = (callback) => {
    frames.set(serial += 1, callback);

    return serial;
  };
  win.cancelAnimationFrame = (id) => frames.delete(id);
  root.setAttribute('data-perf-surface', kind);
  root.setAttribute('data-perf-target', target);
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });

  const log = createWebLog({
    now: () => new Date(),
    monotonicNow: () => 0,
    pageId: 'page-aaaaaaaaaaaaaaaa',
    tabId: 'tab-bbbbbbbbbbbbbbbb',
    version: 'dev',
    context: () => ({
      route: '/pipeline',
      vis: 'visible',
      boot: null
    }),
    level: 'verbose',
  });
  const stop = installSurfacePerformance({
    log,
    win,
    doc: document,
    router: {
      currentRoute: { value: { path: '/pipeline' } },
      beforeEach: () => () => {},
      afterEach: () => () => {},
      onError: () => () => {},
    },
    now: () => 0,
    isVisible: () => true,
    afterUpdate: (callback) => queueMicrotask(callback),
  });

  t.after(() => {
    stop();
    [win.requestAnimationFrame, win.cancelAnimationFrame] = previous;
    root.removeAttribute('data-perf-surface');
    root.removeAttribute('data-perf-target');
  });

  return {
    log,
    /**
     * Дожидается доставки DOM-мутаций и двух управляемых кадров.
     * Это проверяет готовность поверхности без ожидания реального времени.
     */
    async paint() {
      // Доставка MutationObserver в happy-dom идёт нативным таймером, а не микротаской:
      // без ожидания whenAsyncComplete кадры сбросятся раньше доставки записей.
      await win.happyDOM.whenAsyncComplete();
      await setImmediate();
      await setImmediate();

      for (let index = 0; index < 2; index += 1) {
        const batch = [...frames.values()];

        frames.clear();
        batch.forEach((callback) => callback(0));
      }
    },
  };
}
