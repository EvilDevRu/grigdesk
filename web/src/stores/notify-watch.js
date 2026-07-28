// Вотчер конвейера: следит, что остановилось на человеке. Отсюда живут двое —
// системное оповещение «конвейер отработал и ждёт тебя» и чип на пункте «Конвейер»
// в навигации. Оповещение — только на переходе (не ждала → ждёт), чтобы не спамить;
// состояние для чипа пересчитывается на каждой проверке.
// Данные — те же /api/tasks + /api/tasks/:id/graph, что у страницы конвейера; дёргается
// по SSE state-change (AppShell) + редкий страховочный интервал.
import { defineStore } from 'pinia';
import { api } from '../shared/api-client.js';
import { notify, ensureNotifyPermission } from '../shared/notify.js';
import { waitingReason } from '../shared/pipeline-wait.js';

let started = false;
let checking = false;
const notified = new Set(); // задачи, о которых уже звонили (чтобы не звонить каждую проверку)

export const useNotifyWatchStore = defineStore('notifyWatch', {
  // Две разные беды, поэтому и два списка: waiting — конвейер стоит на воротах и ждёт
  // РЕШЕНИЯ (это штатно, в интерфейсе есть кнопка); stalled — движок упёрся или оборвался
  // (кнопки нет, надо разбираться). Смешивать их в одну цифру нельзя — см. #7800.
  state: () => ({ waiting: [], stalled: [] }),
  getters: {
    // Цифра чипа: сколько ЗАДАЧ требуют человека. Задача может одновременно ждать у ворот
    // и числиться вставшей — в чипе она одна.
    attentionCount: (s) => new Set([...s.waiting, ...s.stalled].map((x) => x.task)).size,
    // Подсказка чипа: сводка + поимённо, чтобы не открывать конвейер ради «кто именно».
    attentionTitle: (s) => {
      const lines = [];
      if (s.waiting.length) {
        lines.push(`⏳ ждут твоего решения: ${s.waiting.length}`);
        lines.push(...s.waiting.map((w) => `#${w.task}: ${w.text}`));
      }
      if (s.stalled.length) {
        lines.push(`🛑 встали: ${s.stalled.length}`);
        lines.push(...s.stalled.map((x) => `#${x.task}: ${x.title}`));
      }
      return lines.join('\n');
    },
  },
  actions: {
    start() {
      if (started) return;
      started = true;
      ensureNotifyPermission();
      this.check(true);
      // Страховка на случай пропущенных SSE (событие дергает check из AppShell)
      setInterval(() => this.check(), 120_000);
    },
    /**
     * silent=true — первичный снимок: заполняем состояние без оповещений
     * (иначе каждый заход в кокпит «оповещал» бы о давно ждущих задачах).
     */
    async check(silent = false) {
      if (checking) return;
      checking = true;
      try {
        const { tasks } = await api.get('/api/tasks');
        const waiting = [];
        const stalled = [];
        for (const t of tasks || []) {
          const id = String(t.task);
          // Затык виден уже в сводке задачи — графа для него не нужно.
          if (t.stall) stalled.push({ task: id, kind: t.stall.kind, title: t.stall.title });
          let g = null;
          try { g = await api.get(`/api/tasks/${id}/graph`); } catch { continue; }
          const w = waitingReason(g);
          if (!w) continue;
          waiting.push({ task: id, text: w.text, premature: w.premature });
          if (!notified.has(id) && !silent) notify(`Конвейер ждёт тебя — #${id}`, w.text, `conveyor-${id}`);
        }
        // Право на звонок возвращается, как только задача ушла с ворот.
        notified.clear();
        waiting.forEach((w) => notified.add(w.task));
        this.waiting = waiting;
        this.stalled = stalled;
      } catch { /* сервер недоступен — оставляем прошлую картину, проверим в следующий раз */ }
      finally { checking = false; }
    },
  },
});
