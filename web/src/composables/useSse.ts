// SSE-поток сервера: ОДИН EventSource на вкладку, подписчики мультиплексируются.
//
// Почему синглтон обязателен: браузерный лимит HTTP/1.1 — 6 соединений на хост.
// Раньше каждый useSse() и пермишены чата открывали СВОЙ EventSource (3 на вкладку);
// две вкладки кокпита съедали весь пул, и все fetch вставали в очередь «(ожидает)»
// навсегда — выглядело как «кокпит завис», хотя сервер отвечал за миллисекунды.
import { ref, onMounted, onUnmounted } from 'vue';
import { api } from '../shared/apiClient.ts';

// Все именованные события сервера — новые добавлять сюда (иначе подписчик их не увидит).
// `as const` не украшение: из списка выводится тип имени, и опечатка в ветке подписчика
// становится ошибкой сборки, а не молчащей веткой (та же грабля, что уже стоила отладки).
const EVENT_NAMES = [
  'hello', 'state-change', 'providers-update', 'providers-usage', 'cockpit-update',
  'chat-permission', 'chat-question', 'chat-permission-done',
  'ssh-permission', 'ssh-sessions', 'ssh-audit',
  'db-permission', 'db-sessions', 'db-queries', 'db-audit',
  'chat-step', 'chat-progress', 'chat-done', 'chat-orphan', 'chat-turn-start', 'chat-sessions',
  'chat-session',
  'chat-store', 'chat-store-meta',
  'speech-settings',
  'inbox-changed', 'telegram-status', 'task-shelf-changed', 'arbiter-live',
  'sandboxes-changed', 'sandbox-progress',
  'showcase-changed', 'showcase-progress', 'showcase-voice',
  'gateway-setup',
] as const;

// Имя события шины: ровно то, что сервер объявил выше.
export type SseEventName = typeof EVENT_NAMES[number];

// Подписчик шины. Тело события недоверенное — его форму знает сам подписчик.
export type SseListener = (name: SseEventName, data: unknown) => void;

const connected = ref(false);
const listeners = new Set<SseListener>();
let es: EventSource | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;

/**
 * Поднимает единственное соединение вкладки, если его ещё нет. Повторный вызов
 * безопасен и обязателен: подписчики появляются в разное время, а поток один.
 */
function ensure(): void {
  if (es) {
    return;
  }

  // withCredentials — чтобы сессионная cookie уходила и при VITE_BRAIN_URL на другом origin.
  es = new EventSource(api.eventsUrl(), { withCredentials: true });

  const source = es;

  source.onopen = () => {
    connected.value = true;
  };

  source.onerror = () => {
    connected.value = false;
    source.close();
    es = null;
    retry = setTimeout(ensure, 3000); // авто-переподключение
  };

  for (const name of EVENT_NAMES) {
    source.addEventListener(name, (e: MessageEvent<string>) => {
      let data: unknown = null;

      try {
        data = JSON.parse(e.data);
      } catch { /* событие без тела */ }

      for (const fn of listeners) {
        try {
          fn(name, data);
        } catch { /* один сломанный подписчик не мешает остальным */ }
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
