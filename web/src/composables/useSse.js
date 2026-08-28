// SSE-поток сервера: ОДИН EventSource на вкладку, подписчики мультиплексируются.
//
// Почему синглтон обязателен: браузерный лимит HTTP/1.1 — 6 соединений на хост.
// Раньше каждый useSse() и пермишены чата открывали СВОЙ EventSource (3 на вкладку);
// две вкладки кокпита съедали весь пул, и все fetch вставали в очередь «(ожидает)»
// навсегда — выглядело как «кокпит завис», хотя сервер отвечал за миллисекунды.
import { ref, onMounted, onUnmounted } from 'vue';
import { api } from '../shared/api-client.js';

// Все именованные события сервера — новые добавлять сюда (иначе подписчик их не увидит).
const EVENT_NAMES = [
  'hello', 'state-change', 'providers-update', 'cockpit-update',
  'chat-permission', 'chat-question', 'chat-permission-done',
  'ssh-permission', 'ssh-sessions', 'ssh-audit',
  'chat-step', 'chat-progress', 'chat-done', 'chat-orphan', 'chat-turn-start', 'chat-sessions',
  'chat-store', 'chat-store-meta',
  'speech-settings',
  'inbox-changed', 'telegram-status', 'task-shelf-changed', 'arbiter-live',
  'gateway-setup',
];

const connected = ref(false);
const listeners = new Set(); // fn(name, data)
let es = null;
let retry = null;

function ensure() {
  if (es) return;
  // withCredentials — чтобы сессионная cookie уходила и при VITE_BRAIN_URL на другом origin.
  es = new EventSource(api.eventsUrl(), { withCredentials: true });
  es.onopen = () => { connected.value = true; };
  es.onerror = () => {
    connected.value = false;
    es.close();
    es = null;
    retry = setTimeout(ensure, 3000); // авто-переподключение
  };
  for (const name of EVENT_NAMES) {
    es.addEventListener(name, (e) => {
      let data = null;
      try { data = JSON.parse(e.data); } catch { /* событие без тела */ }
      for (const fn of listeners) {
        try { fn(name, data); } catch { /* один сломанный подписчик не мешает остальным */ }
      }
    });
  }
}

/**
 * Подписка вне Vue-компонентов (сторы): возвращает функцию отписки.
 * Соединение живёт до конца вкладки — не закрываем при нуле подписчиков
 * (AppShell подписан всегда).
 */
export function sseSubscribe(fn) {
  listeners.add(fn);
  ensure();
  return () => listeners.delete(fn);
}

/** Подписка из компонента: живёт от mount до unmount. Возвращает { connected }. */
export function useSse(onEvent) {
  let off = null;
  onMounted(() => { off = sseSubscribe((name, data) => onEvent?.(name, data)); });
  onUnmounted(() => { off?.(); });
  return { connected };
}
