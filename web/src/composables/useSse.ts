// SSE-поток сервера: ОДИН EventSource на вкладку, подписчики мультиплексируются.
//
// Почему синглтон обязателен: браузерный лимит HTTP/1.1 — 6 соединений на хост.
// Раньше каждый useSse() и пермишены чата открывали СВОЙ EventSource (3 на вкладку);
// две вкладки GrigDesk съедали весь пул, и все fetch вставали в очередь «(ожидает)»
// навсегда — выглядело как «GrigDesk завис», хотя сервер отвечал за миллисекунды.
import { ref, onMounted, onUnmounted } from 'vue';
import { api } from '../shared/apiClient.ts';
import { measureChatPerformance, startChatPerformance } from '../shared/chatPerformance.ts';
import type { RelayChannel } from '../shared/windowRelay.ts';
import { WEB_SSE_SIGNALS } from '../../../shared/web-log/webDiagnostics.ts';
import { summarizeWebError } from '../shared/webDiagnostics.ts';
import { connectionRetryDelay } from '../../../shared/client/connectionRetry.ts';

// Все именованные события сервера — новые добавлять сюда (иначе подписчик их не увидит).
// `as const` не украшение: из списка выводится тип имени, и опечатка в ветке подписчика
// становится ошибкой сборки, а не молчащей веткой (та же грабля, что уже стоила отладки).
const EVENT_NAMES = WEB_SSE_SIGNALS;

// Имя события шины: ровно то, что сервер объявил выше.
export type SseEventName = (typeof EVENT_NAMES)[number];

// Подписчик шины. Тело события недоверенное — его форму знает сам подписчик.
export type SseListener = (name: SseEventName, data: unknown) => void;

const connected = ref(false);
export const sseRetryAt = ref(0);
export const sseRecovering = ref(false);
const listeners = new Set<SseListener>();

type SseLogSink = (
  event: 'sse.open' | 'sse.hello' | 'sse.error' | 'sse.fault',
  data: Record<string, unknown>,
) => void;

let logSink: SseLogSink | null = null;
let es: EventSource | null = null;
let accessEnabled = true;
let retry: ReturnType<typeof setTimeout> | null = null;
let retries = 0;
let openedAt = 0;
let lastClosedAt = 0;
let knownBoot: string | null = null;
let stableTimer: ReturnType<typeof setTimeout> | null = null;

// Роль документа в общем потоке desktop: главное окно — источник, окно карточки — зеркало,
// браузер и Android держат собственный поток вкладки без ретрансляции.
export type SseRelayRole = 'off' | 'source' | 'mirror';

// События, нужные окну карточки: журнал окна, полка и речь. Поток ходов чата и прогресс
// через канал не идут. Новый подписчик внутри карточки — добавить его событие сюда.
const RELAYED_EVENTS: readonly SseEventName[] = [
  'trackers-changed',
  'projects-changed',
  'hello',
  'diagnostic-logging',
  'task-shelf-changed',
  'speech-settings',
  'chat-done',
  'ssh-sessions',
  'ssh-audit',
  'db-sessions',
  'db-queries',
  'db-audit',
];
const SSE_RELAY_NAME = 'grigdesk-sse-v1';
const defaultRelayFactory = (): RelayChannel => new BroadcastChannel(SSE_RELAY_NAME);

let relayRole: SseRelayRole = 'off';
let relayFactory: () => RelayChannel = defaultRelayFactory;
let relay: RelayChannel | null = null;


/**
 * Передаём диагностические события SSE внешнему runtime.
 * Замена обработчика безопасна при повторном запуске приложения.
 */
export function setSseLogSink(sink: SseLogSink | null): void {
  logSink = sink;
}

/**
 * Тестовая уборка единственного потока без ожидания минутного таймера устойчивости:
 * закрываем источник и очищаем все таймеры, фоновых переподключений не остаётся.
 */
export function resetSseForTests(): void {
  es?.close();
  es = null;
  accessEnabled = true;

  if (retry) {
    clearTimeout(retry);
  }

  retry = null;

  if (stableTimer) {
    clearTimeout(stableTimer);
  }

  stableTimer = null;
  connected.value = false;
  sseRetryAt.value = 0;
  sseRecovering.value = false;
  listeners.clear();
  retries = 0;
  openedAt = 0;
  lastClosedAt = 0;
  knownBoot = null;
  closeRelay();
  relayRole = 'off';
  relayFactory = defaultRelayFactory;
}

/**
 * Публикуем только типизированные признаки состояния SSE.
 * Ошибка подписчика не прерывает восстановление потока.
 */
function report(
  event: 'sse.open' | 'sse.hello' | 'sse.error' | 'sse.fault',
  data: Record<string, unknown>,
): void {
  try {
    logSink?.(event, data);
  } catch {
    /* журнал не влияет на поток */
  }
}

/**
 * Сбой доставки сохраняет имя сигнала и этап, но не тело и не текст исключения.
 * Контракт журнала повторно проверяет закрытые имена на клиенте и сервере.
 */
function reportFault(signal: SseEventName, phase: 'parse' | 'subscriber' | 'relay', error: unknown): void {
  const summary = summarizeWebError(error);

  report('sse.fault', {
    signal,
    phase,
    name: summary.name,
    error: summary,
  });
}

/**
 * Роль задаёт вход приложения до первого подписчика; тест передаёт свою фабрику канала.
 * Смена роли и HMR освобождают прежние канал, поток и таймеры переподключения.
 */
export function configureSseRelay(
  role: SseRelayRole,
  factory: () => RelayChannel = defaultRelayFactory,
): void {
  closeRelay();
  es?.close();
  es = null;
  connected.value = false;
  sseRetryAt.value = 0;
  sseRecovering.value = false;

  if (retry) {
    clearTimeout(retry);
    retry = null;
  }

  if (stableTimer) {
    clearTimeout(stableTimer);
    stableTimer = null;
  }

  relayRole = role;
  relayFactory = factory;
}

/**
 * Канал ретрансляции закрывается вместе с обработчиком: поздние сообщения не доходят.
 * Повторный вызов без канала ничего не делает.
 */
function closeRelay(): void {
  if (!relay) {
    return;
  }

  relay.onmessage = null;
  relay.close();
  relay = null;
}

/**
 * Событие доходит до подписчиков одинаково из своего потока и из ретрансляции.
 * hello обновляет метку запуска сервера для журнала окна в обоих режимах.
 */
function deliver(name: SseEventName, data: unknown): void {
  const finish = startChatPerformance('sse.dispatch');

  if (name === 'hello') {
    const hello = data && typeof data === 'object' ? (data as { bootId?: unknown }) : {};
    const value =
      typeof hello.bootId === 'string' && /^[A-Za-z0-9_-]{8,64}$/u.test(hello.bootId)
        ? hello.bootId
        : null;
    const changed = knownBoot !== null && value !== null && knownBoot !== value;

    knownBoot = value;
    report('sse.hello', { boot: value, changed });
  }

  for (const fn of listeners) {
    try {
      const result: unknown = fn(name, data);

      if (result && typeof (result as Promise<unknown>).then === 'function') {
        void Promise.resolve(result).catch((error) => reportFault(name, 'subscriber', error));
      }
    } catch (error) {
      reportFault(name, 'subscriber', error);
    }
  }

  finish();
}

/**
 * Главный документ отдаёт уже разобранное событие окнам карточек того же origin.
 * Канал создаётся при первом событии; сбой ретрансляции не мешает своим подписчикам.
 */
function publish(name: SseEventName, data: unknown): void {
  try {
    relay ??= relayFactory();
    relay.postMessage({
      version: 1,
      name,
      data,
    });
  } catch (error) {
    reportFault(name, 'relay', error);
  }
}

/**
 * Окно карточки не открывает своё соединение: события приходят от главного документа.
 * Принимаются только известные имена в точной форме, ответ в канал не отправляется.
 */
function ensureMirror(): void {
  if (relay || !accessEnabled) {
    return;
  }

  const channel = relayFactory();

  relay = channel;
  connected.value = true;
  channel.onmessage = ({ data }) => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return;
    }

    const message = data as Record<string, unknown>;
    const name = RELAYED_EVENTS.find((item) => item === message.name);

    if (name && message.version === 1 && Object.keys(message).length === 3 && 'data' in message) {
      deliver(name, message.data);
    }
  };
}

/**
 * Поднимает единственное соединение вкладки, если его ещё нет. Повторный вызов
 * безопасен и обязателен: подписчики появляются в разное время, а поток один.
 */
function ensure(): void {
  if (relayRole === 'mirror') {
    ensureMirror();

    return;
  }


  if (es || !accessEnabled) {
    return;
  }

  // События используют тот же origin и сессионную cookie, что и остальной API.
  es = new EventSource(api.eventsUrl(), { withCredentials: true });

  const source = es;

  source.onopen = () => {
    if (es !== source) {
      return;
    }

    connected.value = true;
    sseRetryAt.value = 0;
    sseRecovering.value = false;
    openedAt = performance.now();
    report('sse.open', { gapMs: lastClosedAt ? Math.max(0, openedAt - lastClosedAt) : 0, retries });

    if (stableTimer) {
      clearTimeout(stableTimer);
    }

    stableTimer = setTimeout(() => {
      retries = 0;
      stableTimer = null;
    }, 60_000);
  };

  source.onerror = () => {
    if (es !== source) {
      return;
    }

    connected.value = false;
    sseRecovering.value = true;

    if (stableTimer) {
      clearTimeout(stableTimer);
    }

    stableTimer = null;
    report('sse.error', {
      uptimeMs: openedAt ? Math.max(0, performance.now() - openedAt) : 0,
      retries,
    });
    lastClosedAt = performance.now();
    retries += 1;
    source.close();
    es = null;

    if (accessEnabled) {
      const delay = connectionRetryDelay(retries - 1);

      sseRetryAt.value = Date.now() + delay;
      retry = setTimeout(() => {
        retry = null;
        sseRetryAt.value = 0;
        ensure();
      }, delay);
    } // авто-переподключение
  };

  for (const name of EVENT_NAMES) {
    source.addEventListener(name, (e: MessageEvent<string>) => {
      let data: unknown = null;

      try {
        data = measureChatPerformance('sse.decode', () => JSON.parse(e.data),
          () => ({ chars: e.data.length }));
      } catch (error) {
        if (e.data) {
          reportFault(name, 'parse', error);
        }
      }

      deliver(name, data);

      if (relayRole === 'source' && RELAYED_EVENTS.includes(name)) {
        publish(name, data);
      }
    });
  }
}

/**
 * Подписка вне Vue-компонентов (сторы): возвращает функцию отписки.
 * Соединение живёт до конца вкладки — не закрываем при нуле подписчиков
 * (AppShell подписан всегда).
 */
export function sseSubscribe(fn: SseListener): () => void {
  listeners.add(fn);
  ensure();

  return () => {
    listeners.delete(fn);
  };
}

/**
 * Подписка из компонента: живёт от mount до unmount и возвращает `{ connected }`.
 * Само соединение при этом не закрывается — оно общее на вкладку.
 */
export function useSse(onEvent?: SseListener) {
  let off: (() => void) | null = null;

  onMounted(() => {
    off = sseSubscribe((name, data) => onEvent?.(name, data));
  });

  onUnmounted(() => {
    off?.();
  });

  return { connected };
}

/**
 * Явное действие пропускает ожидание, сохраняя единственный поток и его подписчиков.
 * Отозванный доступ и окна-зеркала не могут открыть самостоятельное соединение.
 */
export function reconnectSse(): void {
  if (!accessEnabled || relayRole === 'mirror') {
    return;
  }

  if (retry) {
    clearTimeout(retry);
    retry = null;
  }

  if (stableTimer) {
    clearTimeout(stableTimer);
    stableTimer = null;
  }

  es?.close();
  es = null;
  connected.value = false;
  sseRetryAt.value = 0;
  sseRecovering.value = true;
  ensure();
}

/**
 * Отзыв доступа гасит поток и его таймер, сохраняя подписчиков рабочего документа.
 * Возврат подтверждённого входа поднимает одну общую связь без перемонтирования экрана.
 */
export function setSseEnabled(enabled: boolean): void {
  accessEnabled = enabled;

  if (enabled) {
    if (listeners.size > 0) {
      ensure();
    }

    return;
  }

  es?.close();
  es = null;
  closeRelay();
  connected.value = false;
  sseRetryAt.value = 0;
  sseRecovering.value = false;

  if (retry) {
    clearTimeout(retry);
    retry = null;
  }

  if (stableTimer) {
    clearTimeout(stableTimer);
    stableTimer = null;
  }
}
