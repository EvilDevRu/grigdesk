import type { App } from 'vue';
import type { Pinia } from 'pinia';
import type { Router } from 'vue-router';

import { createApiRouteMatcher, isApiRouteTemplate } from '../../../shared/webLogApiRoutes.ts';
import type { WebLogData } from '../../../shared/webLogContracts.ts';
import { diagnosticLevel, DIAGNOSTIC_TIMER_LIMIT_MS }
  from '../../../shared/diagnosticLogging.ts';
import type { DiagnosticLevel } from '../../../shared/diagnosticLogging.ts';
import { createWebLog } from './webLog.ts';
import type { WebLog } from './webLog.ts';
import { attachTransport } from './webLogTransport.ts';
import { installCapture } from './webLogCapture.ts';
import { useWebLogStore } from '../stores/webLog.ts';
import { sseSubscribe } from '../composables/useSse.ts';

const POLICY_STORAGE_KEY = 'cockpit-diagnostic-level-v2';
const ROUTES_STORAGE_KEY = 'cockpit-web-log-api-routes-v1';
const ROUTES_LIMIT = 2000;

// До загрузки живого каталога узнаются только пути входа и самого журнала:
// их отказы возможны раньше, чем сервер отдаст полный список.
const EARLY_API_ROUTES = [
  '/api/auth/state',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/setup',
  '/api/web-log',
  '/api/web-log/routes',
  '/api/settings/factory-debug',
];

type AuthStoreLike = {
  ready: boolean;
  authenticated: boolean;
  logEpoch: number;
  logConfirmation: number;
  logReason: string;
  $subscribe: (fn: () => void, options?: { detached?: boolean }) => () => void;
};

type ApiEvent = 'api.fail' | 'api.slow';

type RuntimeOptions = {
  app: App;
  router: Router;
  pinia: Pinia;
  win: Window;
  doc: Document;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  url: string;
  policyUrl?: string;
  policySse?: boolean;
  routesUrl?: string;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  beacon: (url: string, body: Blob) => boolean;
  isReportedError?: (error: unknown) => boolean;
  layers?: {
    get: () => { id: number; kind: string }[];
    subscribe: (fn: () => void) => () => void;
  };
};

declare const __COCKPIT_SHA__: string;

export type WebLogRuntime = {
  log: WebLog;
  transport: ReturnType<typeof attachTransport>;
  mark: (text: string) => { page: string; seq: number } | null;
  recordApi: (event: ApiEvent, data: Record<string, unknown>) => void;
  attachAuthStore: (store: AuthStoreLike) => void;
  setBoot: (value: string | null) => void;
  onSwUpdateFound: () => void;
  onSwNeedRefresh: () => void;
  refreshPolicy: () => Promise<void>;
  loadApiRoutes: () => Promise<void>;
  applyPolicy: (level: DiagnosticLevel, expiresAt?: number) => void;
  dispose: () => void;
};

let activeRuntime: WebLogRuntime | null = null;

/**
 * Предоставляем UI действующий экземпляр журнала документа.
 * До bootstrap или после dispose возвращается null.
 */
export function getWebLogRuntime(): WebLogRuntime | null {
  return activeRuntime;
}

/**
 * Создаём идентификатор страницы или вкладки без пользовательских данных.
 * Криптографический генератор имеет резерв для старых браузеров.
 */
function randomId(prefix: string, win: Window): string {
  const uuid = win.crypto?.randomUUID?.();

  if (uuid) {
    return `${prefix}-${uuid}`;
  }

  const bytes = new Uint8Array(16);

  if (win.crypto?.getRandomValues) {
    win.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }

  return `${prefix}-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Группируем user agent по известному семейству браузеров.
 * Полная строка user agent в журнал не попадает.
 */
function browserFamily(ua: string): string {
  if (/Edg\//u.test(ua)) {
    return 'Edge';
  }
  if (/Firefox\//u.test(ua)) {
    return 'Firefox';
  }
  if (/Chrome\//u.test(ua)) {
    return 'Chrome';
  }
  if (/Safari\//u.test(ua)) {
    return 'Safari';
  }

  return 'other';
}

/**
 * Группируем user agent по известному семейству ОС.
 * Неизвестная платформа получает общую категорию.
 */
function osFamily(ua: string): string {
  if (/Android/u.test(ua)) {
    return 'Android';
  }
  if (/iPhone|iPad/u.test(ua)) {
    return 'iOS';
  }
  if (/Windows/u.test(ua)) {
    return 'Windows';
  }
  if (/Mac OS/u.test(ua)) {
    return 'macOS';
  }
  if (/Linux/u.test(ua)) {
    return 'Linux';
  }

  return 'other';
}

/**
 * Управляет ли Service Worker этим документом. Это отличает окно на старой
 * сборке из кэша от окна, загруженного напрямую, когда чанк не нашёлся.
 */
function serviceWorkerState(win: Window): string {
  const serviceWorker = win.navigator?.serviceWorker;

  if (!serviceWorker) {
    return 'unsupported';
  }

  return serviceWorker.controller ? 'active' : 'none';
}

/**
 * Каталог шаблонов из ответа сервера или из storage. Недоверенный вход:
 * берём только строки допустимой формы и отвергаем слишком длинный список.
 */
function routeList(value: unknown): string[] | null {
  const body = value && typeof value === 'object' ? value as { routes?: unknown } : {};

  if (!Array.isArray(body.routes) || body.routes.length > ROUTES_LIMIT) {
    return null;
  }

  return body.routes.filter(isApiRouteTemplate);
}

/**
 * Runtime принадлежит документу, а не AppShell. Его создают до app.use(router)
 * и mount, поэтому первый сбой рендера остаётся видимым в журнале.
 */
export function createWebLogRuntime(options: RuntimeOptions): WebLogRuntime {
  activeRuntime?.dispose();

  const { win, doc, router, app, pinia } = options;
  const storage = options.storage;
  const getUiLayers = options.layers?.get ?? (() => []);
  const subscribeUiLayers = options.layers?.subscribe ?? (() => () => undefined);
  const pageId = randomId('page', win);
  let tabId = randomId('tab', win);

  try {
    const existing = storage?.getItem('cockpit-web-log-tab-v1');

    if (existing && /^tab-[A-Za-z0-9_-]{8,64}$/u.test(existing)) {
      tabId = existing;
    } else {
      storage?.setItem('cockpit-web-log-tab-v1', tabId);
    }
  } catch {
    /* sessionStorage может быть отключён */
  }

  let boot: string | null = null;
  let authStore: AuthStoreLike | null = null;
  let policyTimer: ReturnType<typeof setInterval> | null = null;
  let policyExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  let stopPolicySse: (() => void) | null = null;
  let policyRequest = 0;
  let routesRequest = 0;
  let disposed = false;
  let cachedLevel: DiagnosticLevel | null = null;
  let policyExpiresAt = 0;
  let applyingPolicy = false;
  let matchApiRoute = createApiRouteMatcher(EARLY_API_ROUTES);

  if (options.policyUrl) {
    try {
      const text = storage?.getItem(POLICY_STORAGE_KEY);
      const saved: unknown = text ? JSON.parse(text) : null;

      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        const value = saved as { level?: unknown; expiresAt?: unknown };
        const level = diagnosticLevel(value.level);
        const expiresAt = value.expiresAt;

        if (level !== null && Number.isSafeInteger(expiresAt) &&
          typeof expiresAt === 'number' && expiresAt >= 0) {
          const expired = expiresAt > 0 && expiresAt * 1000 <= Date.now();

          policyExpiresAt = expired ? 0 : expiresAt;
          cachedLevel = expired ? 'off' : level;
        }
      }
    } catch {
      /* недоступный storage оставляет уровень неизвестным */
    }
  }

  try {
    const saved = storage?.getItem(ROUTES_STORAGE_KEY);
    const routes = saved ? routeList(JSON.parse(saved)) : null;

    if (routes) {
      matchApiRoute = createApiRouteMatcher([...EARLY_API_ROUTES, ...routes]);
    }
  } catch {
    /* повреждённый каталог заменит следующая загрузка с сервера */
  }

  const auth = () => ({
    ready: !!authStore?.ready,
    authenticated: !!authStore?.authenticated,
    epoch: authStore?.logEpoch ?? 0,
    confirmation: authStore?.logConfirmation ?? 0,
  });
  const log = createWebLog({
    now: () => new Date(),
    monotonicNow: () => win.performance?.now?.() ?? Date.now(),
    pageId,
    tabId,
    version:
      typeof __COCKPIT_SHA__ === 'string' && /^[a-f0-9]{7,40}$/u.test(__COCKPIT_SHA__)
        ? __COCKPIT_SHA__
        : 'dev',
    context: () => ({
      route: router.currentRoute?.value?.path ?? 'other',
      vis: doc.visibilityState === 'hidden' ? 'hidden' : 'visible',
      boot,
    }),
    level: options.policyUrl ? cachedLevel : 'verbose',
  });
  const transport = attachTransport(log, {
    fetch: options.fetch,
    url: options.url,
    storage,
    beacon: options.beacon,
    auth,
  });
  const oldGlobal = (win as Window & { __cockpitLog?: unknown }).__cockpitLog;
  const sweepTimer = setInterval(() => log.sweep(), 30_000);

  /**
   * Храним подтверждённый уровень вместе со сроком действия только в этой вкладке.
   * После F5 истёкший уровень нельзя использовать даже без связи с сервером.
   */
  function persistPolicy(level: DiagnosticLevel | null): void {
    try {
      if (level === null) {
        storage?.removeItem(POLICY_STORAGE_KEY);
      } else {
        storage?.setItem(POLICY_STORAGE_KEY,
          JSON.stringify({ level, expiresAt: policyExpiresAt }));
      }
    } catch {
      /* недоступный storage не меняет действующую политику */
    }
  }

  /**
   * Применяем только уровень общего контракта. Транспорт сам очищает очередь
   * через подписку на единственную политику ядра.
   */
  function applyPolicy(level: DiagnosticLevel, expiresAt?: number): void {
    if (diagnosticLevel(level) === null) {
      return;
    }

    policyRequest += 1;

    const validExpiry = typeof expiresAt === 'number' &&
      Number.isSafeInteger(expiresAt) && expiresAt > 0 ? expiresAt : 0;
    const effective = validExpiry > 0 && validExpiry * 1000 <= Date.now()
      ? 'off'
      : level;

    policyExpiresAt = effective === 'off' ? 0 : validExpiry;
    applyingPolicy = true;

    try {
      log.setLevel(effective);
    } finally {
      applyingPolicy = false;
    }

    persistPolicy(effective);

    if (policyExpiryTimer) {
      clearTimeout(policyExpiryTimer);
      policyExpiryTimer = null;
    }

    if (policyExpiresAt > Date.now() / 1000) {
      policyExpiryTimer = setTimeout(() => {
        applyPolicy('off');
        void refreshPolicy();
      }, Math.min(DIAGNOSTIC_TIMER_LIMIT_MS,
        policyExpiresAt * 1000 - Date.now() + 10));
    }

    void transport.flush();
  }

  const stopPolicyStorage = log.subscribeLevel((level) => {
    if (policyExpiryTimer) {
      clearTimeout(policyExpiryTimer);
      policyExpiryTimer = null;
    }

    // Ответ приёмника и logout могут изменить уровень без applyPolicy.
    // При таком переходе старый TTL больше нельзя приписывать новому уровню.
    if (!applyingPolicy) {
      policyExpiresAt = 0;
    }

    persistPolicy(level);
  });

  if (options.policyUrl && cachedLevel !== null && policyExpiresAt > 0) {
    applyPolicy(cachedLevel, policyExpiresAt);
  }

  /**
   * Читаем JSON настройки напрямую, вне наблюдаемого API-клиента, с таймаутом.
   * Неуспех возвращает null и не порождает диагностическое событие.
   */
  async function readJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await options.fetch(url, {
        method: 'GET',
        credentials: 'include',
        signal: controller.signal,
      });

      return response.ok ? await response.json() : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Читаем глобальный уровень. Неуспех оставляет последний подтверждённый
   * уровень; ответ, пришедший после смены auth-эпохи или новой политики, отброшен.
   */
  async function refreshPolicy(): Promise<void> {
    if (!options.policyUrl || !authStore?.authenticated || disposed) {
      return;
    }

    const request = ++policyRequest;
    const epoch = authStore.logEpoch;
    const body = await readJson(options.policyUrl);
    const view = body && typeof body === 'object'
      ? body as { effective?: unknown; expiresAt?: unknown }
      : {};
    const level = diagnosticLevel(view.effective);

    if (
      level !== null && request === policyRequest &&
      !disposed && authStore?.authenticated && authStore.logEpoch === epoch
    ) {
      applyPolicy(level,
        typeof view.expiresAt === 'number' ? view.expiresAt : undefined);
    }
  }

  /**
   * Живой каталог шаблонов /api с сервера. Его хранит sessionStorage, чтобы после
   * F5 ранние отказы API сразу получили шаблон пути, а не `other`.
   */
  async function loadApiRoutes(): Promise<void> {
    if (!options.routesUrl || !authStore?.authenticated || disposed) {
      return;
    }

    const request = ++routesRequest;
    const routes = routeList(await readJson(options.routesUrl));

    if (!routes || request !== routesRequest || disposed) {
      return;
    }

    matchApiRoute = createApiRouteMatcher([...EARLY_API_ROUTES, ...routes]);

    try {
      storage?.setItem(ROUTES_STORAGE_KEY, JSON.stringify({ routes }));
    } catch {
      /* каталог останется в памяти до конца документа */
    }
  }

  function onPolicyVisibility(): void {
    if (doc.visibilityState === 'visible') {
      void refreshPolicy();
    }
  }

  if (options.policyUrl) {
    policyTimer = setInterval(() => {
      void refreshPolicy();
    }, 60_000);
    doc.addEventListener('visibilitychange', onPolicyVisibility);
  }

  /** Ручная отметка человека сразу просит отправку, не дожидаясь интервала. */
  function mark(text: string) {
    const key = log.mark(text);

    if (key) {
      void transport.flush();
    }

    return key;
  }

  /**
   * Отказ или медленный ответ API: реальный путь сводится к шаблону каталога
   * здесь, до записи, поэтому id и query в журнал не попадают.
   */
  function recordApi(event: ApiEvent, data: Record<string, unknown>): void {
    const path = typeof data.path === 'string' ? matchApiRoute(data.path) : 'other';

    log.record(event, {
      ...data,
      path,
    } as WebLogData[ApiEvent]);
  }

  const publicHandle = {
    mark,
    dump: () => log.dump(),
  };

  (win as Window & { __cockpitLog?: unknown }).__cockpitLog = publicHandle;

  const stopCapture = installCapture({
    app,
    router,
    pinia,
    log,
    win,
    doc,
    onHidden: transport.onHidden,
    onVisible: transport.onVisible,
    isReportedError: options.isReportedError,
  });

  let previousLayers = new Map<number, string>();

  /**
   * Сравниваем предыдущий и текущий набор активных UI-слоёв.
   * Фиксируем только вид слоя и переход, без содержимого DOM.
   */
  function syncLayers(): void {
    const current = getUiLayers();
    const next = new Map(current.map((layer) => [layer.id, layer.kind]));

    for (const [id, kind] of previousLayers) {
      if (!next.has(id)) {
        log.record('ui.layer', {
          op: 'close',
          kind,
          id,
          depth: current.length,
        });
      }
    }
    for (const [id, kind] of next) {
      if (!previousLayers.has(id)) {
        log.record('ui.layer', {
          op: 'open',
          kind,
          id,
          depth: current.length,
        });
      }
    }

    previousLayers = next;
  }

  const stopLayers = subscribeUiLayers(syncLayers);
  const ua = win.navigator?.userAgent ?? '';

  log.record('app.start', {
    browser: browserFamily(ua),
    os: osFamily(ua),
    w: win.innerWidth ?? 0,
    h: win.innerHeight ?? 0,
    dpr: win.devicePixelRatio ?? 1,
    standalone: !!win.matchMedia?.('(display-mode: standalone)').matches,
    wasDiscarded: !!(doc as Document & { wasDiscarded?: boolean }).wasDiscarded,
    sw: serviceWorkerState(win),
    queued: transport.status().pendingCount,
    storage: transport.status().storageAvailable,
  });

  let stopAuth: (() => void) | null = null;
  let stopLog: (() => void) | null = null;
  let stopLevelStatus: (() => void) | null = null;
  let stopDelivery: (() => void) | null = null;

  /**
   * Переносим счётчики ядра и транспорта в Pinia для панели.
   * Панель получает копии состояния, не управляя очередью.
   */
  function updateStatus(): void {
    if (!authStore) {
      return;
    }

    const state = useWebLogStore(pinia);
    const ring = log.status();
    const delivery = transport.status();

    state.setStatus({
      ringCount: ring.count,
      ringFrom: ring.from,
      ringTo: ring.to,
      pendingCount: delivery.pendingCount,
      storageAvailable: delivery.storageAvailable,
      paused: delivery.paused,
      lastError: delivery.lastError,
      lossCount: Object.values(ring.loss).reduce((sum, value) => sum + value, 0),
      level: ring.level,
    });
  }

  /**
   * Подключаем состояние авторизации после установки ранних ловушек.
   * Смена эпохи очищает старые записи и отменяет старые ответы.
   */
  function attachAuthStore(store: AuthStoreLike): void {
    authStore = store;

    let previous = `${store.ready}:${store.authenticated}:${store.logReason}`;
    let previousConfirmation = store.logConfirmation;
    let previousEpoch = store.logEpoch;

    stopAuth?.();
    stopAuth = store.$subscribe(
      () => {
        transport.authChanged();

        if (store.logEpoch !== previousEpoch) {
          previousEpoch = store.logEpoch;
          policyRequest += 1;
          routesRequest += 1;
          log.setLevel(null);
        }

        if (store.authenticated && store.logConfirmation > previousConfirmation) {
          previousConfirmation = store.logConfirmation;
          void refreshPolicy();
          void loadApiRoutes();
        }

        if (options.policyUrl && options.policySse && store.authenticated && !stopPolicySse) {
          stopPolicySse = sseSubscribe((name) => {
            if (name === 'diagnostic-logging' || name === 'hello') {
              void refreshPolicy();
            }
          });
        } else if (!store.authenticated && stopPolicySse) {
          stopPolicySse();
          stopPolicySse = null;
        }

        const current = `${store.ready}:${store.authenticated}:${store.logReason}`;

        if (current !== previous) {
          previous = current;
          log.record('auth.change', {
            ready: store.ready,
            authenticated: store.authenticated,
            reason: store.logReason || 'load',
          });
        }

        updateStatus();
        void transport.flush();
      },
      { detached: true },
    );
    stopLog?.();
    stopLog = log.subscribe(updateStatus);
    stopLevelStatus?.();
    stopLevelStatus = log.subscribeLevel(updateStatus);
    stopDelivery?.();
    stopDelivery = transport.subscribeDelivery(updateStatus);
    updateStatus();
    void refreshPolicy();
    void loadApiRoutes();
  }

  /** Новый процесс сервера мог сменить таблицу маршрутов: каталог перечитывается. */
  function setBoot(value: string | null): void {
    const restarted = boot !== null && value !== null && value !== boot;

    boot = value;

    if (restarted) {
      void loadApiRoutes();
    }
  }

  function onSwUpdateFound(): void {
    log.record('sw.updatefound', {});
  }

  function onSwNeedRefresh(): void {
    log.record('sw.needRefresh', {});
  }

  /**
   * Останавливаем ловушки, транспорт и подписки runtime.
   * Повторный вызов безопасен и не оставляет таймеров.
   */
  function dispose(): void {
    if (disposed) {
      return;
    }

    disposed = true;
    stopAuth?.();
    stopLog?.();
    stopLevelStatus?.();
    stopDelivery?.();
    stopPolicySse?.();
    stopPolicyStorage();
    stopLayers();
    clearInterval(sweepTimer);

    if (policyTimer) {
      clearInterval(policyTimer);
    }

    if (policyExpiryTimer) {
      clearTimeout(policyExpiryTimer);
    }

    if (options.policyUrl) {
      doc.removeEventListener('visibilitychange', onPolicyVisibility);
    }

    stopCapture();
    transport.dispose();
    (win as Window & { __cockpitLog?: unknown }).__cockpitLog = oldGlobal;

    if (activeRuntime === runtime) {
      activeRuntime = null;
    }
  }

  const runtime = {
    log,
    transport,
    mark,
    recordApi,
    attachAuthStore,
    setBoot,
    onSwUpdateFound,
    onSwNeedRefresh,
    refreshPolicy,
    loadApiRoutes,
    applyPolicy,
    dispose,
  };

  activeRuntime = runtime;

  return runtime;
}
