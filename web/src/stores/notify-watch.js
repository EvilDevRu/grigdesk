// Вотчер оповещений: следит за конвейером и сообщает, когда задача остановилась
// на человеке (gate в статусе wait/premature) — «конвейер отработал и ждёт тебя».
// Срабатывает на переходе (не ждала → ждёт), чтобы не спамить. Данные — те же
// /api/tasks + /api/tasks/:id/graph, что у страницы конвейера; дергается по SSE
// state-change (AppShell) + редкий страховочный интервал.
import { defineStore } from 'pinia';
import { api } from '../shared/api-client.js';
import { notify, ensureNotifyPermission } from '../shared/notify.js';

let started = false;
let checking = false;
const prevWaiting = new Map(); // task → текст причины

function waitingOf(graph) {
  const statuses = graph?.statuses || {};
  for (const [nid, s] of Object.entries(statuses)) {
    if ((s === 'wait' || s === 'premature') && nid.startsWith('gate_')) {
      const label = graph.nodes?.[nid]?.[1] || nid;
      return String(label).replace(/[\u{1F000}-\u{1FAFF}☀-➿]/gu, '').trim();
    }
  }
  return null;
}

export const useNotifyWatchStore = defineStore('notifyWatch', {
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
     * silent=true — первичный снимок: запоминаем текущее состояние без оповещений
     * (иначе каждый заход в кокпит «оповещал» бы о давно ждущих задачах).
     */
    async check(silent = false) {
      if (checking) return;
      checking = true;
      try {
        const { tasks } = await api.get('/api/tasks');
        const seen = new Set();
        for (const t of tasks || []) {
          const id = String(t.task);
          seen.add(id);
          let w = null;
          try { w = waitingOf(await api.get(`/api/tasks/${id}/graph`)); } catch { continue; }
          if (w && !prevWaiting.has(id) && !silent) {
            notify(`Конвейер ждёт тебя — #${id}`, w, `conveyor-${id}`);
          }
          if (w) prevWaiting.set(id, w);
          else prevWaiting.delete(id);
        }
        for (const id of [...prevWaiting.keys()]) if (!seen.has(id)) prevWaiting.delete(id);
      } catch { /* сервер недоступен — проверим в следующий раз */ }
      finally { checking = false; }
    },
  },
});
