// Подписка на SSE-поток сервера с авто-переподключением.
// Возвращает { connected }; вызывает onEvent(name, data) на каждое событие.
import { ref, onMounted, onUnmounted } from 'vue';
import { api } from '../shared/api-client.js';

export function useSse(onEvent) {
  const connected = ref(false);
  let es = null;
  let retry = null;

  function connect() {
    // withCredentials — чтобы сессионная cookie уходила и при VITE_BRAIN_URL на другом origin
    // (для того же origin браузер отправляет её и так).
    es = new EventSource(api.eventsUrl(), { withCredentials: true });
    es.onopen = () => { connected.value = true; };
    es.onerror = () => {
      connected.value = false;
      es.close();
      // переподключение через 3 с
      retry = setTimeout(connect, 3000);
    };
    // именованные события сервера
    for (const name of ['hello', 'state-change', 'providers-update']) {
      es.addEventListener(name, (e) => {
        let data = null;
        try { data = JSON.parse(e.data); } catch { /* пусто */ }
        onEvent?.(name, data);
      });
    }
  }

  onMounted(connect);
  onUnmounted(() => { if (retry) clearTimeout(retry); if (es) es.close(); });

  return { connected };
}
