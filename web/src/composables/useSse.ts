// SSE-поток сервера: ОДИН EventSource на вкладку, подписчики мультиплексируются.
//
// Почему синглтон обязателен: браузерный лимит HTTP/1.1 — 6 соединений на хост.
// Раньше каждый useSse() и пермишены чата открывали СВОЙ EventSource (3 на вкладку);
// две вкладки GrigDesk съедали весь пул, и все fetch вставали в очередь «(ожидает)»
// навсегда — выглядело как «GrigDesk завис», хотя сервер отвечал за миллисекунды.
import { ref, onMounted, onUnmounted } from 'vue';
import { api } from '../shared/apiClient.ts';
import type { RelayChannel } from '../shared/windowRelay.ts';

// Все именованные события сервера — новые добавлять сюда (иначе подписчик их не увидит).
// `as const` не украшение: из списка выводится тип имени, и опечатка в ветке подписчика
// становится ошибкой сборки, а не молчащей веткой (та же грабля, что уже стоила отладки).
const EVENT_NAMES = [
  'hello',
  'state-change',
  'providers-update',
  'provider-install',
  'providers-usage',
  'grigdesk-update',
  'chat-permission',
  'chat-question',
  'chat-permission-done',
  'ssh-permission',
  'ssh-sessions',
  'ssh-audit',
  'db-permission',
  'db-sessions',
  'db-queries',
  'db-audit',
  'chat-step',
  'chat-progress',
  'chat-done',
  'chat-orphan',
  'chat-turn-start',
  'chat-run-metadata',
  'chat-in-turn',
  'chat-assistant-message',
  'chat-sessions',
  'chat-session',
  'chat-store',
  'chat-store-meta',
  'speech-settings',
  'diagnostic-logging',
  'inbox-changed',
  'telegram-status',
  'mobile-changed',
  'task-shelf-changed',
  'grigdesk-tasks-changed',
  'arbiter-live',
  'sandboxes-changed',
  'sandbox-progress',
  'projects-changed',
  'routes-draft-changed',
  'routes-catalog-changed',
  'showcase-changed',
  'showcase-progress',
  'showcase-build-progress',
  'showcase-voice',
  'usage-forecast',
  'studio-changed',
  'studio-progress',
] as const;

// Имя события шины: ровно то, что сервер объявил выше.
export type SseEventName = (typeof EVENT_NAMES)[number];

// Подписчик шины. Тело события недоверенное — его форму знает сам подписчик.
export type SseListener = (name: SseEventName, data: unknown) => void;

const connected = ref(false);
const listeners = new Set<SseListener>();

type SseLogSink = (
  event: 'sse.open' | 'sse.hello' | 'sse.error',
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
  event: 'sse.open' | 'sse.hello' | 'sse.error',
  data: Record<string, unknown>,
): void {
  try {
    logSink?.(event, data);
  } catch {
    /* журнал не влияет на поток */
  }
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
      fn(name, data);
    } catch {
      /* один сломанный подписчик не мешает остальным */
    }
  }
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
  } catch {
    /* окно карточки получит следующее событие */
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
    connected.value = true;
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
    connected.value = false;

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
      retry = setTimeout(ensure, 3000);
    } // авто-переподключение
  };

  for (const name of EVENT_NAMES) {
    source.addEventListener(name, (e: MessageEvent<string>) => {
      let data: unknown = null;

      try {
        data = JSON.parse(e.data);
      } catch {
        /* событие без тела */
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

  if (retry) {
    clearTimeout(retry);
    retry = null;
  }

  if (stableTimer) {
    clearTimeout(stableTimer);
    stableTimer = null;
  }
}
