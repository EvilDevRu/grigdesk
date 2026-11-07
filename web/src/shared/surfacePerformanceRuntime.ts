import type { Router } from 'vue-router';
import { normalizeRoute } from '../../../shared/web-log/webLogContracts.ts';
import { SURFACE_KINDS, SURFACE_TARGETS } from '../../../shared/web-log/surfacePerformance.ts';
import type { SurfaceKind } from '../../../shared/web-log/surfacePerformance.ts';
import { createSurfacePerformance } from './surfacePerformance.ts';
import type { SurfaceHandle } from './surfacePerformance.ts';
import type { WebLog } from './webLog.ts';
import { setSurfaceIntentSink } from './surfaceIntents.ts';

const ROOT = '[data-perf-surface]';
const WAIT = '[data-ui-loading]:not([data-variant="inline"]):not([data-perf-failed]),'
  + '[aria-busy="true"],[data-perf-pending]';

type Entry = {
  key: string;
  handle: SurfaceHandle;
  frame?: number;
  nextFrame?: number
};

/**
 * Наблюдатель читает только диагностические атрибуты и наличие видимых ожиданий.
 * Он не читает текст, HTML, value, href/src, DOM содержимого iframe и параметры запросов.
 */
export function installSurfacePerformance(options: {
  log: WebLog;
  router: Router;
  win: Window;
  doc: Document;
  now?: () => number;
  isVisible?: (element: HTMLElement) => boolean;
  afterUpdate: (callback: () => void) => void;
  beforeHidden?: (callback: () => void) => () => void;
}): () => void {
  const { log, router, win, doc } = options;

  if (typeof doc.querySelectorAll !== 'function') {
    return () => {};
  }

  const now = options.now ?? (() => win.performance.now());
  const visible = options.isVisible ?? ((element) => element.getClientRects().length > 0);
  const recorder = createSurfacePerformance({ log, now });
  const entries = new Map<HTMLElement, Entry>();
  const intents = new Map<string, SurfaceHandle>();
  let completed = new WeakMap<HTMLElement, string>();
  let terminal = new WeakMap<HTMLElement, string>();
  let observer: MutationObserver | null = null;
  let enabled = false;
  let disposed = false;
  let queued = false;
  let generation = 0;
  let inputAt: number | undefined;
  let inputTimer: ReturnType<typeof setTimeout> | undefined;
  let navigation: {
    to: object;
    key: string;
    target: string;
    handle: SurfaceHandle;
    committed: boolean;
  } | null = null;

  /**
   * В лог разрешены только цели, объявленные исходным кодом приложения.
   * Пользовательский plugin id и ключи данных превращаются в other до создания span.
   */
  function target(value: unknown): string {
    return typeof value === 'string' && (SURFACE_TARGETS as readonly string[]).includes(value)
      ? value : 'other';
  }

  const removeIntents = setSurfaceIntentSink((intent) => {
    if (!enabled) {
      return () => {};
    }

    const name = target(intent.target);
    const key = `${intent.kind}:${name}:${intent.key}`;

    intents.get(key)?.finish('cancelled');

    const handle = recorder.start({
      kind: intent.kind,
      target: name,
      view: normalizeRoute(router.currentRoute.value.path),
      origin: 'surface',
      start: inputAt,
    });

    if (!handle) {
      return () => {};
    }

    intents.set(key, handle);

    return () => {
      if (intents.get(key) === handle) {
        intents.delete(key);
      }

      handle.finish('cancelled');
    };
  });

  /**
   * Только явная ошибка первоначального чтения принадлежит результату открытия.
   * Сохранённая ошибка при повторе не завершает новый span, пока объявлен pending.
   */
  function failed(root: HTMLElement): boolean {
    const ownVisible = (element: HTMLElement) => visible(element) && element.closest(ROOT) === root;
    const retrying = [root, ...root.querySelectorAll<HTMLElement>('[data-perf-pending]')]
      .some((element) => element.matches('[data-perf-pending]') && ownVisible(element));

    if (retrying) {
      return false;
    }

    const failures = [...root.querySelectorAll<HTMLElement>('[data-perf-error],[data-perf-failed]')];

    if (root.matches('[data-perf-error],[data-perf-failed]')) {
      failures.unshift(root);
    }

    return failures.some(ownVisible);
  }

  /**
   * Вложенный диалог/страница настроек измеряются собственным span.
   * Родительское время описывает его оболочку, не выдаётся за готовность дочерних данных.
   */
  function pending(root: HTMLElement): number {
    if (failed(root)) {
      return 0;
    }

    const candidates = [...root.querySelectorAll<HTMLElement>(WAIT)];

    if (root.matches(WAIT)) {
      candidates.unshift(root);
    }

    return candidates.filter((element) => visible(element) && element.closest(ROOT) === root).length;
  }

  /**
   * Снимаем оба кадра, чтобы callback старой цели не завершил новую поверхность.
   * Удаление DOM не отменяет прикладные запросы и не меняет пользовательское состояние.
   */
  function cancelFrames(entry: Entry): void {
    if (entry.frame !== undefined) {
      win.cancelAnimationFrame(entry.frame);
    }
    if (entry.nextFrame !== undefined) {
      win.cancelAnimationFrame(entry.nextFrame);
    }

    entry.frame = undefined;
    entry.nextFrame = undefined;
  }

  /**
   * Между двумя кадрами вновь проверяем ожидания и принадлежность текущей записи.
   * Это возможность отрисовки, не измерение фактического scanout монитора.
   */
  function frames(root: HTMLElement, entry: Entry): void {
    if (entry.frame !== undefined || entry.nextFrame !== undefined) {
      return;
    }

    const epoch = generation;
    const valid = () => enabled && epoch === generation && entries.get(root) === entry
      && root.isConnected && visible(root) && pending(root) === 0;

    entry.frame = win.requestAnimationFrame(() => {
      entry.frame = undefined;

      if (!valid()) {
        return;
      }

      entry.nextFrame = win.requestAnimationFrame(() => {
        entry.nextFrame = undefined;

        if (!valid()) {
          return;
        }

        const phase = failed(root) ? 'error' : 'ready';

        entry.handle.update(0);
        entry.handle.finish(phase);
        completed.set(root, entry.key);
        terminal.set(root, phase);
        entries.delete(root);

        if (navigation?.handle === entry.handle) {
          navigation = null;
        }
      });
    });
  }

  /**
   * Обычный streaming в уже готовом разделе не сканирует весь документ.
   * Реагируем на новые/снятые корни, их ключи и ожидания незавершённого открытия.
   */
  function relevant(record: MutationRecord): boolean {
    const element = record.target.nodeType === 1 ? record.target as HTMLElement : null;

    if (record.type === 'attributes') {
      if (element && ['data-perf-surface', 'data-perf-target', 'data-perf-key']
        .includes(record.attributeName || '')) {
        completed.delete(element);

        return true;
      }
      if (element && record.attributeName === 'hidden' && element.matches(ROOT)) {
        completed.delete(element);

        return true;
      }

      const root = element?.closest(ROOT) as HTMLElement | null;

      if (root && terminal.get(root) === 'error' && pending(root) > 0) {
        completed.delete(root);

        return true;
      }

      return !!root && entries.has(root);
    }
    if (navigation?.committed || (element && entries.has(element.closest(ROOT) as HTMLElement))) {
      return true;
    }

    return [...record.addedNodes, ...record.removedNodes].some((node) => {
      if (node.nodeType !== 1) {
        return false;
      }

      const changed = node as HTMLElement;

      return changed.matches(ROOT) || !!changed.querySelector(ROOT);
    });
  }

  /**
   * Сканирование запускается только после структурной мутации или смены объявленного
   * ожидания/ключа, а не на каждый кадр и не на изменение текста ленты агента.
   */
  function scan(): void {
    queued = false;

    if (!enabled || !doc.body) {
      return;
    }

    const allRoots = [...doc.querySelectorAll<HTMLElement>(ROOT)];
    const roots = allRoots.filter(visible);
    const current = new Set(roots);

    for (const root of allRoots) {
      if (!current.has(root)) {
        completed.delete(root);
      }
    }

    for (const [root, entry] of entries) {
      if (!current.has(root)) {
        cancelFrames(entry);
        entry.handle.finish('cancelled');

        if (navigation?.handle === entry.handle) {
          navigation = null;
        }

        entries.delete(root);
      }
    }
    for (const root of roots) {
      const rawKind = root.getAttribute('data-perf-surface') || '';

      if (!(SURFACE_KINDS as readonly string[]).includes(rawKind)) {
        continue;
      }

      const kind = rawKind as SurfaceKind;
      const name = target(root.getAttribute('data-perf-target'));
      const key = `${kind}:${name}:${root.getAttribute('data-perf-key') || ''}`;
      let entry = entries.get(root);
      const nav = kind === 'route' && navigation?.committed
        && navigation.target === name ? navigation : null;
      const incoming = nav?.handle ?? intents.get(key);

      if (entry && (entry.key !== key || (incoming && incoming !== entry.handle))) {
        cancelFrames(entry);
        entry.handle.finish('cancelled');
        entries.delete(root);
        entry = undefined;
      }
      if (!entry && (completed.get(root) !== key || incoming)) {
        const handle = incoming ?? recorder.start({
          kind,
          target: name,
          view: normalizeRoute(router.currentRoute.value.path),
          origin: inputAt === undefined ? 'observed' : 'input',
          start: inputAt,
        });

        if (!handle) {
          continue;
        }

        intents.delete(key);
        handle.mounted();
        entry = { key, handle };
        entries.set(root, entry);
      }
      if (entry) {
        const count = pending(root);

        entry.handle.update(count);

        if (count > 0) {
          cancelFrames(entry);
        } else {
          frames(root, entry);
        }
      }
    }
  }

  /**
   * Сотни мутаций одного Vue flush дают одно сканирование после обновления.
   * Callback старого поколения ничего не делает после hidden/off/dispose.
   */
  function schedule(): void {
    if (queued || !enabled) {
      return;
    }

    queued = true;

    const epoch = generation;

    options.afterUpdate(() => {
      if (epoch === generation) {
        scan();
      }
    });
  }

  /**
   * Запоминаем только время текущего input task, без target и содержимого события.
   * Программное открытие получает собственную границу navigation/observed.
   */
  function input(): void {
    if (!enabled) {
      return;
    }

    inputAt = now();
    clearTimeout(inputTimer);
    inputTimer = setTimeout(() => inputAt = undefined, 0);
  }

  /**
   * Ресурсы принадлежат видимому verbose-периоду, не всему времени жизни страницы.
   * Возвращённая страница начинает новое observed-наблюдение без времени сна.
   */
  function sync(): void {
    generation += 1;
    queued = false;
    observer?.disconnect();
    observer = null;
    entries.forEach(cancelFrames);
    entries.clear();
    intents.clear();
    navigation = null;
    clearTimeout(inputTimer);
    inputAt = undefined;

    if (enabled && doc.visibilityState === 'hidden') {
      recorder.suspend();
    } else {
      recorder.clear();
    }

    completed = new WeakMap();
    terminal = new WeakMap();
    enabled = !disposed && log.level() === 'verbose' && doc.visibilityState !== 'hidden'
      && typeof win.requestAnimationFrame === 'function';

    const Observer = (win as Window & { MutationObserver?: typeof MutationObserver }).MutationObserver;

    if (enabled && Observer && doc.body) {
      observer = new Observer((records) => {
        if (records.some(relevant)) {
          schedule();
        }
      });
      observer.observe(doc.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-perf-surface', 'data-perf-target', 'data-perf-key',
          'data-perf-pending', 'data-perf-error', 'data-perf-failed', 'aria-busy', 'hidden'],
      });
      schedule();
    }
  }

  const removeBefore = router.beforeEach((to) => {
    if (!enabled) {
      return;
    }

    navigation?.handle.finish('cancelled');

    const handle = recorder.start({
      kind: 'route',
      target: target(to.name),
      view: normalizeRoute(to.path),
      origin: inputAt === undefined ? 'navigation' : 'input',
      start: inputAt,
    });

    navigation = handle ? {
      to,
      key: to.fullPath,
      target: target(to.name),
      handle,
      committed: false,
    } : null;
  });
  const removeAfter = router.afterEach((to, _from, failure) => {
    if (navigation?.to !== to) {
      return;
    }
    if (failure) {
      navigation.handle.finish('cancelled');
      navigation = null;
    } else {
      navigation.committed = true;
      schedule();
    }
  });
  const removeError = router.onError((_error, to) => {
    if (navigation?.to === to) {
      navigation.handle.finish('error');
      navigation = null;
    }
  });
  const removeLevel = log.subscribeLevel(sync);
  const removeBeforeHidden = options.beforeHidden?.(sync);

  doc.addEventListener('visibilitychange', sync);
  doc.addEventListener('click', input, true);
  sync();

  return () => {
    disposed = true;
    sync();
    removeBefore();
    removeAfter();
    removeError();
    removeLevel();
    removeBeforeHidden?.();
    removeIntents();
    recorder.dispose();
    doc.removeEventListener('visibilitychange', sync);
    doc.removeEventListener('click', input, true);
  };
}
