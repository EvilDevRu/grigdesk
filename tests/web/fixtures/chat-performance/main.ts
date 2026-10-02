import { createApp, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import App from './App.vue';
import { useChatStore } from '../../../../web/src/stores/chat.js';
import '../../../../web/src/styles/index.css';

interface Stats {
  mdToText: number;
  mdToHtml: number;
  historicalTurns: number;
  historicalSteps: number;
  stepLists: number;
  put: {
    ms: number;
    prepareMs?: number;
    chars: number;
    sparse: boolean
  }[];
}

const host = window as unknown as {
  __chatPerformanceStats: Stats;
  __performanceSse: (name: string, payload: unknown) => void;
  __chatPerformance: unknown;
};
const pinia = createPinia();

setActivePinia(pinia);

const chat = useChatStore();
const longTasks: {
  startTime: number;
  duration: number;
}[] = [];
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

new PerformanceObserver((list) => {
  longTasks.push(...list.getEntries().map(({
    startTime,
    duration
  }) => ({
    startTime,
    duration
  })));
}).observe({
  type: 'longtask',
  buffered: true
});

/**
 * Счётчики не содержат тексты и сбрасываются после доставки записей observer.
 * Начальный монтаж и отложенная запись учитываются в разных интервалах.
 */
function resetStats(): void {
  host.__chatPerformanceStats = {
    mdToText: 0,
    mdToHtml: 0,
    historicalTurns: 0,
    historicalSteps: 0,
    stepLists: 0,
    put: [],
  };
  longTasks.length = 0;
}

resetStats();
await chat._load();

const target = chat.session('fixture-0');

target.sending = true;
target.turnStartedAt = Date.now();
chat.runtimeRuns = {
  [target.id]: {
    runId: 'current-run',
    active: true,
    source: 'background',
    snapshot: null
  }
};
chat._ensureInTurn(target.id, 'current-run', 'current-turn');
chat.initPerms();
createApp(App).use(pinia).mount('#app');
await nextTick();
await pause(550);

/**
 * Обновления приходят в настоящий callback SSE; записи используют штатный API-клиент.
 * Повтор блока заранее завершён, поэтому повторные события должны быть полным no-op.
 */
function dispatch(kind: string, index: number): void {
  const chatKey = 'fixture-0';
  const runId = 'current-run';

  if (['block', 'draft', 'duplicate'].includes(kind)) {
    host.__performanceSse('chat-assistant-message', {
      chatKey,
      runId,
      block: {
        chatKey,
        runId,
        assistantMessageId: kind === 'duplicate' ? 'fixed-block' : `${kind}-${index}`,
        sequence: kind === 'duplicate' ? 1 : 100 + index,
        revision: 1,
        complete: kind !== 'draft',
        text: kind === 'duplicate' ? 'Завершённый блок' : `Реплика ${index}`,
      },
    });
  } else if (kind === 'step') {
    host.__performanceSse('chat-step', {
      chatKey,
      runId,
      step: {
        k: 'note',
        text: `Шаг ${index}`,
        at: Date.now()
      },
    });
  } else if (kind === 'progress') {
    host.__performanceSse('chat-progress', {
      chatKey,
      runId,
      tokens: index * 100
    });
  } else if (kind === 'reorder') {
    target.updatedAt = Date.now() + index;
  } else if (kind === 'waiting') {
    chat.pending = index % 2 ? {
      fixture: {
        chatKey,
        kind: 'question',
        pid: 'fixture'
      }
    } : {};
  } else if (kind === 'save') {
    chat.setDraft(chatKey, `Черновик ${index}`);
  }
}

/**
 * Один образец разделяет callback, обновление Vue, кадр и debounce до durable ACK.
 * Аудит полной истории выполняет процесс HTTP-приёмника после серии измерений.
 */
async function event(kind: string, index: number) {
  await pause(30);
  resetStats();

  const started = performance.now();

  dispatch(kind, index);

  const handlerMs = performance.now() - started;

  await nextTick();

  const eventMs = performance.now() - started;

  await frame();
  await frame();

  const frameMs = performance.now() - started;

  if (['block', 'save'].includes(kind)) {
    await pause(420);
    await chat._writeChat(target.id);
  }

  const ackMs = performance.now() - started;

  await pause(40);

  return {
    handlerMs,
    eventMs,
    frameMs,
    ackMs,
    stats: structuredClone(host.__chatPerformanceStats),
    longTasks: [...longTasks],
  };
}

dispatch('duplicate', 0);
await nextTick();
await pause(500);
await chat._writeChat(target.id);
resetStats();
host.__chatPerformance = {
  chat,
  event,
  dispatch,
  resetStats
};
