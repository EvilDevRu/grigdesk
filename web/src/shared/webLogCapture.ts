import { isNavigationFailure, NavigationFailureType } from 'vue-router';

import type { App, ComponentPublicInstance } from 'vue';
import type { Pinia } from 'pinia';
import type { NavigationFailure, Router } from 'vue-router';

import { vueErrorSource } from '../../../shared/web-log/webLogContracts.ts';
import type { WebLogData } from '../../../shared/web-log/webLogContracts.ts';
import type { WebLog } from './webLog.ts';
import { summarizeWebError as summarizeError } from './webDiagnostics.ts';

type CaptureOptions = {
  app: App;
  router: Router;
  pinia: Pinia;
  log: WebLog;
  win: Window;
  doc: Document;
  onHidden?: () => void;
  onVisible?: () => void;
  // Ошибка, уже записанная как api.fail, не повторяется записью store.error.
  isReportedError?: (error: unknown) => boolean;
};

/** Имя компонента: явное `name` либо имя SFC, которое Vue кладёт в `__name`. */
function componentName(instance: ComponentPublicInstance | null): string {
  const options = instance?.$options as { name?: unknown; __name?: unknown } | undefined;
  const name = options?.name ?? options?.__name;

  return typeof name === 'string' ? name : 'other';
}

/**
 * Исход перехода роутера по типу отказа vue-router. Адрес назначения и текст
 * причины в запись не идут — только одно из четырёх значений каталога.
 */
function navigationResult(failure: NavigationFailure | void | undefined): string {
  if (!failure) {
    return 'success';
  }
  if (isNavigationFailure(failure, NavigationFailureType.cancelled)) {
    return 'cancelled';
  }
  if (isNavigationFailure(failure, NavigationFailureType.duplicated)) {
    return 'duplicated';
  }

  return 'aborted';
}

/**
 * Категория неудавшегося ресурса без самого адреса: файл сборки, свой ресурс,
 * чужой origin, data: или blob:. Адрес файла сборки проверит контракт отдельно.
 */
function resourceCategory(source: string | null, origin: string): string {
  if (!source) {
    return 'other';
  }
  if (source.startsWith('data:')) {
    return 'data';
  }
  if (source.startsWith('blob:')) {
    return 'blob';
  }

  try {
    const url = origin ? new URL(source, origin) : new URL(source);

    if (url.origin !== origin) {
      return 'external';
    }

    return /^\/assets\/[^/]+\.(?:js|css)$/u.test(url.pathname) ? 'chunk-load' : 'resource';
  } catch {
    return 'other';
  }
}

/**
 * Область интерфейса, где оказался фокус: топбар, диалог или прочее.
 * Ни текст, ни значения полей, ни атрибуты цели не читаются.
 */
function focusContext(target: Element): string {
  if (target.closest?.('header.topbar')) {
    return 'topbar';
  }
  if (target.closest?.('dialog, [role="dialog"], [aria-modal="true"]')) {
    return 'dialog';
  }

  return 'other';
}

/**
 * Ставим ловушки до первой навигации, первого store и mount. Обработчики
 * берут только разрешённые признаки; произвольные тексты отбрасывает контракт.
 */
export function installCapture(options: CaptureOptions): () => void {
  const { app, router, pinia, log, win, doc } = options;
  const cleanup: (() => void)[] = [];
  const actionStops = new Set<() => void>();
  const actionTimers = new Set<ReturnType<typeof setTimeout>>();
  let actionEpoch = 0;
  let disposed = false;
  let navStarted = 0;
  const monotonic = () => win.performance?.now?.() ?? Date.now();
  const previousErrorHandler = app.config.errorHandler;

  // Заданный errorHandler отключает штатный console.error Vue, поэтому без
  // прежнего обработчика ошибка печатается сама: DevTools её по-прежнему видят.
  app.config.errorHandler = (
    error: unknown,
    instance: ComponentPublicInstance | null,
    info: string,
  ) => {
    log.record('vue.error', {
      error: summarizeError(error),
      info: vueErrorSource(info),
      component: componentName(instance),
    });

    if (previousErrorHandler) {
      previousErrorHandler(error, instance, info);
    } else {
      console.error(error);
    }
  };
  cleanup.push(() => {
    app.config.errorHandler = previousErrorHandler;
  });

  /**
   * Различаем ошибку загрузки ресурса и ошибку скрипта.
   * В обоих случаях сохраняем только проекцию разрешённых полей.
   */
  const onWindowError = (event: Event) => {
    const target = event.target as HTMLElement | null;

    if (target && event.target !== win) {
      const source = (target as HTMLScriptElement).src || (target as HTMLLinkElement).href || null;

      log.record('res.error', {
        tag: target.tagName,
        category: resourceCategory(source, win.location?.origin ?? ''),
        src: source,
      });

      return;
    }

    const errorEvent = event as ErrorEvent;

    log.record('js.error', {
      error: summarizeError(errorEvent.error),
      source: errorEvent.filename || null,
      line: errorEvent.lineno || 0,
      col: errorEvent.colno || 0,
    });
  };

  win.addEventListener('error', onWindowError, true);
  cleanup.push(() => win.removeEventListener('error', onWindowError, true));

  const onRejection = (event: Event) => {
    log.record('js.rejection', {
      error: summarizeError((event as PromiseRejectionEvent).reason),
    });
  };

  win.addEventListener('unhandledrejection', onRejection);
  cleanup.push(() => win.removeEventListener('unhandledrejection', onRejection));

  cleanup.push(
    router.beforeEach(() => {
      navStarted = monotonic();
    }),
  );
  cleanup.push(
    router.afterEach((to, from, failure) => {
      log.record('router.nav', {
        from: from.path,
        to: to.path,
        ms: Math.max(0, monotonic() - navStarted),
        result: navigationResult(failure),
      });
    }),
  );
  cleanup.push(
    router.onError((error, to) => {
      log.record('router.error', { to: to?.path ?? 'other', error: summarizeError(error) });
    }),
  );

  pinia.use(({ store }) => {
    // Обновление панели журнала вызывается самой записью: его повторное наблюдение
    // могло бы запустить рекурсию при ошибке или медленной обработке статуса.
    if (disposed || store.$id === 'webLog') {
      return;
    }

    const stop = store.$onAction(({ name, onError, after }) => {
      const epoch = actionEpoch;
      const started = log.level() === 'verbose' ? monotonic() : null;
      let finished = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      /**
       * Только медленные действия дополняют журнал; аргументы и результат не читаются.
       * Смена уровня или dispose отсекает завершение прежнего поколения наблюдений.
       */
      function finish(outcome: 'success' | 'error'): void {
        finished = true;
        clearTimeout(timer);

        if (timer) {
          actionTimers.delete(timer);
        }
        if (started === null || disposed || epoch !== actionEpoch || log.level() !== 'verbose') {
          return;
        }

        const ms = Math.max(0, monotonic() - started);

        if (ms >= 500) {
          log.record('store.slow', {
            store: store.$id,
            action: name,
            ms,
            outcome,
          });
        }
      }

      // Синхронные actions завершаются до микрозадачи и не создают таймер на каждый вызов.
      // Незавершённое действие оставляет одну отметку даже без исхода Promise.
      if (started !== null) {
        queueMicrotask(() => {
          if (finished || disposed || epoch !== actionEpoch || log.level() !== 'verbose'
            || actionTimers.size >= 128) {
            return;
          }

          timer = setTimeout(() => {
            actionTimers.delete(timer!);

            if (!finished && !disposed && epoch === actionEpoch && log.level() === 'verbose') {
              log.record('store.pending', {
                store: store.$id,
                action: name,
                ms: Math.max(0, monotonic() - started),
              });
            }
          }, Math.max(0, 3000 - (monotonic() - started)));
          actionTimers.add(timer);
        });
      }

      after?.(() => finish('success'));
      onError((error) => {
        finish('error');

        if (options.isReportedError?.(error)) {
          return;
        }

        log.record('store.error', {
          store: store.$id,
          action: name,
          error: summarizeError(error),
        });
      });
    }, true);

    actionStops.add(stop);
  });
  cleanup.push(() => {
    for (const stop of actionStops) {
      stop();
    }

    actionStops.clear();
  });

  const clearActionTimers = () => {
    actionEpoch += 1;
    actionTimers.forEach(clearTimeout);
    actionTimers.clear();
  };

  cleanup.push(log.subscribeLevel(clearActionTimers), clearActionTimers);

  const listen = (target: EventTarget, name: string, handler: EventListener) => {
    target.addEventListener(name, handler);
    cleanup.push(() => target.removeEventListener(name, handler));
  };

  listen(doc, 'visibilitychange', () => {
    const state = doc.visibilityState === 'hidden' ? 'hidden' : 'visible';

    log.record('page.visibility', { state });

    if (state === 'hidden') {
      options.onHidden?.();
    } else {
      options.onVisible?.();
    }
  });
  listen(doc, 'freeze', () => {
    log.record('page.freeze', {});
    options.onHidden?.();
  });
  listen(doc, 'resume', () => {
    log.record('page.resume', {});
    options.onVisible?.();
  });
  listen(win, 'pagehide', (event) => {
    log.record('app.pagehide', { persisted: !!(event as PageTransitionEvent).persisted });
    options.onHidden?.();
  });
  listen(win, 'pageshow', (event) => {
    log.record('page.show', { persisted: !!(event as PageTransitionEvent).persisted });
    options.onVisible?.();
  });
  listen(win, 'online', () => log.record('net.online', {}));
  listen(win, 'offline', () => log.record('net.offline', {}));
  listen(doc, 'focusin', (event) => {
    const target = event.target as Element | null;

    if (!target) {
      return;
    }

    log.record('ui.focus', { target: { tag: target.tagName || 'OTHER', context: focusContext(target) } });
  });

  const serviceWorker = win.navigator?.serviceWorker;

  if (serviceWorker) {
    listen(serviceWorker, 'controllerchange', () => log.record('sw.controllerchange', {}));
  }

  return () => {
    if (disposed) {
      return;
    }

    disposed = true;

    for (const stop of cleanup.reverse()) {
      stop();
    }
  };
}

export type CaptureLogData = WebLogData;
