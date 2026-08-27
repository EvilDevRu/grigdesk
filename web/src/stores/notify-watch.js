// Вотчер конвейера: следит, что остановилось на человеке. Отсюда живут двое —
// системное оповещение «конвейер отработал и ждёт тебя», чип на пункте «Конвейер»
// и общий счётчик активных прогонов в топбаре. Оповещение — только на переходе
// (не ждала → ждёт), чтобы не спамить; сводка пересчитывается на каждой проверке.
// Данные — те же /api/tasks + /api/tasks/:id/graph, что у страницы конвейера; дёргается
// по SSE state-change (AppShell) + редкий страховочный интервал.
import { defineStore } from 'pinia';
import { api } from '../shared/api-client.js';
import { notify } from '../shared/notify.js';
import { stripEmoji, waitingReason } from '../shared/pipeline-wait.js';
import { silenceReason } from '../shared/agent-activity.js';
import {
  pipelineBadgeSummary,
  pipelineTopbarItems,
} from '../shared/pipeline-nav-badge.js';

let started = false;
let checking = false;
const notified = new Set(); // задачи, о которых уже звонили (чтобы не звонить каждую проверку)
const silenceNotified = new Set(); // то же для молчащих ходов, ключ «задача:этап»
const stallNotified = new Set(); // и для аварий, ключ «задача:вид:этап»

export const useNotifyWatchStore = defineStore('notifyWatch', {
  // Три разные беды плюс обычная работа, поэтому списки раздельные: waiting — конвейер стоит на воротах и ждёт
  // РЕШЕНИЯ (это штатно, в интерфейсе есть кнопка); stalled — движок упёрся или оборвался
  // (само не рассосётся, надо разбираться); silent — формально всё идёт, но агент молчит дольше
  // порога, и без звонка это заметно только по сгоревшему лимиту этапа. Смешивать их
  // в одну цифру нельзя. running нужен синему сектору и общему числу в топбаре,
  // но в цифру внимания не входит.
  state: () => ({
    waiting: [],
    stalled: [],
    silent: [],
    running: [],
    observedByTask: {},
    loadedAt: 0,
    error: null,
  }),
  getters: {
    // Число в центре — только задачи, требующие человека. Обычные живые ходы участвуют
    // в синем секторе круга, но это число не увеличивают.
    badgeSummary: (s) => pipelineBadgeSummary(s),
    topbarItems: (s) => pipelineTopbarItems(s),
    attentionCount() { return this.badgeSummary.attentionCount; },
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
      if (s.silent.length) {
        lines.push(`💤 молчат: ${s.silent.length}`);
        lines.push(...s.silent.map((x) => `#${x.task}: ${x.text}`));
      }
      const summary = pipelineBadgeSummary(s);
      if (summary.runningCount) {
        const attention = new Set([...s.waiting, ...s.stalled, ...s.silent].map((x) => x.task));
        const running = s.running.filter((x) => !attention.has(x.task));
        lines.push(`🔵 в работе: ${summary.runningCount}`);
        lines.push(...running.map((x) => `#${x.task}`));
      }
      return lines.join('\n');
    },
  },
  actions: {
    start() {
      if (started) return;
      started = true;
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
        // Порог молчания приходит вместе со списком: он общий для всех окон и лежит
        // в настройках сервера, а не в голове клиента.
        const { tasks, silenceWindow } = await api.get('/api/tasks');
        const waiting = [];
        const stalled = [];
        const stalledKeys = [];
        const silentRuns = [];
        const running = [];
        const observedByTask = {};
        for (const t of tasks || []) {
          const id = String(t.task);
          const taskTitle = String(t.title || '').trim();
          if (t.daemonAlive) running.push({ task: id, taskTitle });
          // Затык виден уже в сводке задачи — графа для него не нужно.
          if (t.stall) {
            stalled.push({
              task: id,
              taskTitle,
              kind: t.stall.kind,
              title: t.stall.title,
              hint: t.stall.hint || '',
            });
            // Авария — самая громкая из трёх бед, и единственная, которая НЕ звонила вовсе:
            // чип её считал, тултип показывал, а оповещения не было. Прогон, умерший на
            // глазах (выключили машину, погиб демон), не имел права молчать.
            // Ключ несёт вид и этап: другой узел, вставший так же, — новая беда, а не эта.
            const key = `${id}:${t.stall.kind}:${t.stall.stage || ''}`;
            stalledKeys.push(key);
            if (!stallNotified.has(key) && !silent) {
              const crashed = t.stall.kind === 'crashed';
              // У аварии заголовок карточки общий («оборвался»), а полезное — подсказка;
              // у затыка наоборот: заголовок называет узел и причину.
              notify(
                `${crashed ? 'Конвейер оборвался' : 'Конвейер встал'} — #${id}`,
                (crashed ? t.stall.hint || t.stall.title : t.stall.title) || '',
                `stall-${key}`,
              );
            }
          }
          const q = silenceReason(t, silenceWindow);
          if (q) {
            silentRuns.push({ task: id, taskTitle, stage: q.stage, text: q.text });
            // Звоним на переходе и отдельно по каждому этапу: следующий узел, зависший
            // так же, — это новая беда, а не продолжение старой.
            const key = `${id}:${q.stage}`;
            if (!silenceNotified.has(key) && !silent) {
              notify(`Ход завис — #${id}`, q.text, `silence-${key}`);
            }
          }
          let g = null;
          let gateKnown = true;
          try { g = await api.get(`/api/tasks/${id}/graph`); } catch { gateKnown = false; }
          const w = gateKnown ? waitingReason(g) : null;
          const currentStage = g?.progress?.current || null;
          const progressDone = Number(g?.progress?.done);
          const progressTotal = Number(g?.progress?.total);
          observedByTask[id] = {
            attempt: t.attempt || null,
            daemon: t.daemonAlive ? 'running' : 'stopped',
            result: t.result || null,
            stall: t.stall?.title || null,
            gateKnown,
            gate: w?.text || null,
            progress: Number.isSafeInteger(progressDone) && progressDone >= 0
              && Number.isSafeInteger(progressTotal) && progressTotal >= 0
              ? { done: progressDone, total: progressTotal }
              : null,
            stage: currentStage
              ? {
                id: currentStage,
                label: stripEmoji(g?.nodes?.[currentStage]?.[1]) || currentStage,
                state: g?.statuses?.[currentStage] || null,
              }
              : null,
          };
          if (!w) continue;
          waiting.push({
            task: id,
            taskTitle,
            text: w.text,
            premature: w.premature,
          });
          if (!notified.has(id) && !silent) notify(`Конвейер ждёт тебя — #${id}`, w.text, `conveyor-${id}`);
        }
        // Право на звонок возвращается, как только задача ушла с ворот.
        notified.clear();
        waiting.forEach((w) => notified.add(w.task));
        // Тем же порядком по молчанию: заговорил — забыли, замолчит снова — позвоним.
        silenceNotified.clear();
        silentRuns.forEach((x) => silenceNotified.add(`${x.task}:${x.stage}`));
        // И по авариям: прогон продолжили — забыли, оборвался снова — позвоним снова.
        stallNotified.clear();
        stalledKeys.forEach((key) => stallNotified.add(key));
        this.waiting = waiting;
        this.stalled = stalled;
        this.silent = silentRuns;
        this.running = running;
        this.observedByTask = observedByTask;
        this.loadedAt = Date.now();
        this.error = null;
      } catch (error) {
        // Сервер недоступен — оставляем прошлую картину и помечаем источник неизвестным.
        this.error = error?.message || 'Конвейер недоступен';
      }
      finally { checking = false; }
    },
  },
});
