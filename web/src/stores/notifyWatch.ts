import { taskReferenceKey } from '../../../shared/tasks/taskReference.ts';
import { messageRef } from '../ui.ts';
import { uiLocalePort } from '../shared/uiLocalePort.ts';
// Вотчер конвейера: следит, что остановилось на человеке. Отсюда живут
// системные оповещения, сводка топбара и счётчик внимания в сайдбаре.
// Оповещение — только на переходе
// (не ждала → ждёт), чтобы не спамить; сводка пересчитывается на каждой проверке.
// Данные — те же /api/tasks + /api/tasks/:id/graph, что у страницы конвейера; дёргается
// по SSE state-change (AppShell) + редкий страховочный интервал.
import { defineStore } from 'pinia';
import { decodeLiveGraph, decodePipelineTasks, type PipelineNotice,
  type TaskObservation, type LiveGraph } from '../shared/pipelineContracts.ts';
import { api, failureText } from '../shared/apiClient.ts';
import { alertUser, dismissAlert } from '../shared/alerts.ts';
import { stripEmoji, waitingReason } from '../../../shared/pipeline/pipelineWait.ts';
import { silenceReason } from '../../../shared/pipeline/agentActivity.ts';
import {
  pipelineBadgeSummary,
  pipelineTopbarItems,
} from '../shared/pipelineNavBadge.ts';

import {
  publishSandboxPipelineSnapshot,
  markSandboxPipelineSnapshotError,
} from '../shared/sandboxPipelineSnapshot.ts';

let started = false;
let checking = false;
const notified = new Set<string>(); // задачи, о которых уже звонили (чтобы не звонить каждую проверку)
const silenceNotified = new Set<string>(); // то же для молчащих ходов, ключ «задача:этап»
const stallNotified = new Set<string>(); // и для аварий, ключ «задача:вид:этап»

export const useNotifyWatchStore = defineStore('notifyWatch', {
  // Три беды плюс обычная работа. waiting — конвейер стоит на воротах и ждёт
  // РЕШЕНИЯ (это штатно, в интерфейсе есть кнопка); stalled — движок упёрся или оборвался
  // (само не рассосётся, надо разбираться); silent — формально всё идёт, но агент молчит дольше
  // порога, и без звонка это заметно только по сгоревшему лимиту этапа. Причины
  // сохраняются раздельно в подсказке и топбаре. running нужен счётчику выполняемых задач в топбаре,
  // но в цифру внимания не входит.
  state: () => ({
    waiting: [] as PipelineNotice[],
    stalled: [] as PipelineNotice[],
    silent: [] as PipelineNotice[],
    running: [] as PipelineNotice[],
    observedByTask: {} as Record<string, TaskObservation>,
    observedByReference: {} as Record<string, TaskObservation>,
    loadedAt: 0,
    error: null as string | null,
  }),
  getters: {
    // Сводка внимания считает только задачи, требующие человека.
    // Обычные живые ходы сохраняются в отдельном runningCount.
    badgeSummary: (s) => pipelineBadgeSummary(s),
    topbarItems: (s) => pipelineTopbarItems(s, uiLocalePort.value),
    attentionCount(): number {
      return this.badgeSummary.attentionCount;
    },
    // Текстовая сводка: количества и причины поимённо для потребителей стора.
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
    /**
     * Первое чтение заполняет списки молча, далее остаётся прежний редкий интервал.
     * Повторный вызов не создаёт второй таймер наблюдения.
     */
    start() {
      if (started) {
        return;
      }

      started = true;
      this.check(true);
      // Страховка на случай пропущенных SSE (событие дергает check из AppShell)
      setInterval(() => this.check(), 120_000);
    },
    /**
     * silent=true — первичный снимок: заполняем состояние без оповещений
     * (иначе каждый заход в GrigDesk «оповещал» бы о давно ждущих задачах).
     */
    async check(silent = false) {
      if (checking) {
        return;
      }

      checking = true;

      try {
        // Порог молчания приходит вместе со списком: он общий для всех окон и лежит
        // в настройках сервера, а не в голове клиента.
        const { tasks, silenceWindow } = decodePipelineTasks(await api.get('/api/tasks?sources=1'));
        const waiting: PipelineNotice[] = [];
        const stalled: PipelineNotice[] = [];
        const stalledKeys: string[] = [];
        const silentRuns: PipelineNotice[] = [];
        const running: PipelineNotice[] = [];
        const observedByTask: Record<string, TaskObservation> = {};

        for (const t of tasks || []) {
          const id = String(t.task);
          const taskTitle = String(t.title || '').trim();

          if (t.daemonAlive) {
            running.push({ task: id, taskTitle });
          }
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
              alertUser({
                id: `stall-${key}`,
                scope: `task:${id}`,
                tone: 'danger',
                sticky: true,
                title: messageRef(crashed ? 'core.pipelineCrashed' : 'core.pipelineStalled', { id }),
                body: (crashed ? t.stall.hint || t.stall.title : t.stall.title) || '',
                target: { kind: 'pipeline', taskId: id },
              });
            }
          }

          const q = silenceReason(t, silenceWindow!);

          if (q) {
            silentRuns.push({
              task: id,
              taskTitle,
              stage: q.stage,
              text: q.text,
            });
            // Звоним на переходе и отдельно по каждому этапу: следующий узел, зависший
            // так же, — это новая беда, а не продолжение старой.
            const key = `${id}:${q.stage}`;

            if (!silenceNotified.has(key) && !silent) {
              alertUser({
                id: `silence-${key}`,
                scope: `task:${id}`,
                tone: 'warning',
                sticky: true,
                title: messageRef('core.runStalled', { id }),
                body: q.text,
                target: { kind: 'pipeline', taskId: id },
              });
            }
          }

          let g: LiveGraph | null = null;
          let gateKnown = true;

          try {
            g = decodeLiveGraph(await api.get(`/api/tasks/${id}/graph`));
          } catch {
            gateKnown = false;
          }

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

          if (!w) {
            continue;
          }

          waiting.push({
            task: id,
            taskTitle,
            text: w.text,
            premature: w.premature,
          });

          if (!notified.has(id) && !silent) {
            alertUser({
              id: `conveyor-${id}`,
              scope: `task:${id}`,
              tone: 'warning',
              sticky: true,
              title: messageRef('core.pipelineWaiting', { id }),
              body: w.text,
              target: { kind: 'pipeline', taskId: id },
            });
          }
        }
        // Право на звонок возвращается, как только задача ушла с ворот.
        const waitingIds = new Set(waiting.map((entry) => entry.task));

        for (const id of notified) {
          if (!waitingIds.has(id)) {
            dismissAlert(`conveyor-${id}`);
          }
        }

        notified.clear();
        waiting.forEach((w) => notified.add(w.task));
        // Тем же порядком по молчанию: заговорил — забыли, замолчит снова — позвоним.
        const silenceKeys = new Set(silentRuns.map((entry) => `${entry.task}:${entry.stage}`));

        for (const key of silenceNotified) {
          if (!silenceKeys.has(key)) {
            dismissAlert(`silence-${key}`);
          }
        }

        silenceNotified.clear();
        silentRuns.forEach((x) => silenceNotified.add(`${x.task}:${x.stage}`));
        // И по авариям: прогон продолжили — забыли, оборвался снова — позвоним снова.
        for (const key of stallNotified) {
          if (!stalledKeys.includes(key)) {
            dismissAlert(`stall-${key}`);
          }
        }

        stallNotified.clear();
        stalledKeys.forEach((key) => stallNotified.add(key));
        this.waiting = waiting;
        this.stalled = stalled;
        this.silent = silentRuns;
        this.running = running;
        this.observedByTask = observedByTask;
        this.observedByReference = Object.fromEntries((tasks || []).filter((task) => task.source)
          .map((task) => [taskReferenceKey({ id: task.task, source: task.source }),
            observedByTask[String(task.task)]!]));
        this.loadedAt = Date.now();
        this.error = null;
        publishSandboxPipelineSnapshot({
          tasks: (tasks || []).map(({ task, title, profile, readOnly, daemonAlive, result }) => ({
            task,
            title: title || '',
            profile: profile || '',
            readOnly: Boolean(readOnly),
            daemonAlive: Boolean(daemonAlive),
            result: result || null,
          })),
          waiting,
          stalled,
          silent: silentRuns,
          running,
          observedByTask,
          loadedAt: this.loadedAt,
          error: null,
        });
      } catch (error) {
        // Сервер недоступен — оставляем прошлую картину и помечаем источник неизвестным.
        this.error = failureText(error) || 'Конвейер недоступен';
        markSandboxPipelineSnapshotError(this.error);
      }
      finally { checking = false; }
    },
  },
});
