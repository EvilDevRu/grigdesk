// Нагрузка «мозга» (CPU/RAM) — частый лёгкий опрос для индикатора в шапке.
//
// Опрос идёт строго по одному: следующий ставится после ответа на предыдущий. Раньше
// таймер запускал новый GET каждые три секунды, не дожидаясь прежнего, и при забитых
// соединениях браузера запросы копились десятками. Сбой не стирает метрики: шапка
// показывает последний удачный снимок и отмечает, что он устарел.
import { defineStore } from 'pinia';
import { api } from '../shared/apiClient.ts';

// Опрос сам себе повтор, поэтому одна попытка и короткий таймаут: GET, повисший на
// забитом соединении, за это время честно становится «устарело», а не ждёт минуту.
const POLL_TIMEOUT_MS = 8000;

// Таймер и летящий запрос живут рядом со стором, а не в state: это не данные для
// рендера, и их смена на каждом тике будила бы подписчиков стора.
const runtimes = new WeakMap();

function runtimeOf(store) {
  let runtime = runtimes.get(store);

  if (!runtime) {
    runtime = {
      timer: null,
      inflight: null,
      polling: false,
    };
    runtimes.set(store, runtime);
  }

  return runtime;
}

export const useSystemStore = defineStore('system', {
  // updatedAt — время последнего УДАЧНОГО снимка; stale — последний опрос не удался и
  // цифры на экране не свежие; error — причина для подсказки.
  state: () => ({
    data: null,
    updatedAt: 0,
    stale: false,
    error: '',
  }),
  actions: {
    /**
     * Один запрос на всех: вызов во время летящего опроса присоединяется к нему. Так
     * поздний ответ старого запроса не может перетереть более свежий — их просто нет.
     */
    load() {
      const runtime = runtimeOf(this);

      if (runtime.inflight) {
        return runtime.inflight;
      }

      runtime.inflight = api.get('/api/system', { timeoutMs: POLL_TIMEOUT_MS, retry: false })
        .then((data) => {
          this.data = data;
          this.updatedAt = Date.now();
          this.stale = false;
          this.error = '';
        })
        .catch((error) => {
          // Метрики не стираем: пустота в шапке хуже честной пометки «устарело».
          this.stale = true;
          this.error = error?.message || 'сервер не ответил';
        })
        .finally(() => {
          runtime.inflight = null;
        });

      return runtime.inflight;
    },
    /**
     * Опрос цепочкой: пауза отсчитывается от ответа, поэтому медленный сервер замедляет
     * опрос, а не копит запросы. Повторный старт при живом опросе ничего не делает.
     */
    startPolling(ms = 3000) {
      const runtime = runtimeOf(this);

      if (runtime.polling) {
        return;
      }

      runtime.polling = true;

      const tick = () => {
        runtime.timer = null;

        if (!runtime.polling) {
          return;
        }

        this.load().finally(() => {
          if (!runtime.polling || runtime.timer) {
            return;
          }

          runtime.timer = setTimeout(tick, ms);
          runtime.timer?.unref?.();
        });
      };

      tick();
    },
    // Нужен при потере сессии: иначе опрос молотит в закрытый API и сыпет 401 в консоль.
    // Летящий запрос не отменяется — его ответ ещё обновит метрики, а новый не начнётся.
    stopPolling() {
      const runtime = runtimeOf(this);

      runtime.polling = false;
      clearTimeout(runtime.timer);
      runtime.timer = null;
    },
  },
});
