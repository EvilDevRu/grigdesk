import { createApp, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import App from './App.vue';
import { mdToHtml, mdToText } from '../../../../web/src/shared/md.ts';
import { useChatStore } from '../../../../web/src/stores/chat.ts';
import '../../../../web/src/styles/index.css';

interface Stats {
  mdToText: number;
  mdToHtml: number;
  lexMarkdown: number;
  mdTokensToHtml: number;
  highlightCode: number;
  renderMermaid: number;
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
    lexMarkdown: 0,
    mdTokensToHtml: 0,
    highlightCode: 0,
    renderMermaid: 0,
    historicalTurns: 0,
    historicalSteps: 0,
    stepLists: 0,
    put: [],
  };
  longTasks.length = 0;
}

resetStats();
await chat._load();
await chat.ensureChatMessages('fixture-0');

const loadedSession = chat.session('fixture-0');

if (!loadedSession || !chat.isChatMessagesLoaded('fixture-0')
  || loadedSession.messages.reduce((count, message) => count + (message.steps?.length || 0), 0) !== 7500) {
  throw new Error('Фикстура производительности должна загрузить полную историю из 7500 шагов');
}

const target = loadedSession;

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

  if (['block', 'draft', 'duplicate', 'conflict'].includes(kind)) {
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

  if (['block', 'save', 'conflict'].includes(kind)) {
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

/**
 * Контроль обязан упасть с именем исчезнувшего узла при изменении шаблона.
 * Поиск ограничен текущей репликой, чтобы старая история не дала ложный успех.
 */
function requiredElement<T extends Element>(parent: ParentNode, selector: string): T {
  const element = parent.querySelector<T>(selector);

  if (!element) {
    throw new Error(`Positive control: отсутствует ${selector}`);
  }

  return element;
}

/**
 * Один и тот же текущий ответ дописывается через SSE: закрытие запускает новую
 * схему, а хвост сохраняет готовые блоки, раскрытие и показанный исходник.
 */
async function control() {
  const fence = '```';
  const long = Array.from({ length: 30 }, (_, index) => `строка ${index}`).join('\n');
  const head = `Контроль\n\n${fence}ts\nconst control = 1;\n${fence}\n\n` +
    `${fence}text\n${long}\n${fence}\n\n`;
  const open = `${head}${fence}mermaid\nflowchart TD\n A-->B`;
  const send = async (text: string, revision: number) => {
    host.__performanceSse('chat-assistant-message', {
      chatKey: target.id,
      runId: 'current-run',
      block: {
        chatKey: target.id,
        runId: 'current-run',
        assistantMessageId: 'control-stream',
        sequence: 10,
        revision,
        complete: false,
        text,
      },
    });
    await nextTick();
    await pause(800);
  };

  resetStats();
  dispatch('step', 0);
  mdToHtml('Контроль HTML');
  mdToText('Контроль превью');
  await send(open, 1);

  const reply = [...document.querySelectorAll('.cs .msg.assistant .agent-reply')].at(-1);

  if (!reply?.textContent?.includes('const control = 1;')) {
    throw new Error('Positive control: текущая реплика агента не появилась');
  }

  (reply.querySelector('[data-role="chat-reply-expand"]') as HTMLElement)?.click();
  await nextTick();

  const code = requiredElement(reply, '.md-fence[data-lang="ts"]');

  code.setAttribute('data-perf-kept', 'yes');
  requiredElement<HTMLElement>(reply, '[data-context="md-fence-expand"]').click();
  await nextTick();

  const initial = structuredClone(host.__chatPerformanceStats);

  resetStats();
  await send(`${open}\n${fence}`, 2);

  for (let attempt = 0; attempt < 100 && !reply.querySelector('.md-diagram__image'); attempt += 1) {
    await pause(100);
  }

  const closed = structuredClone(host.__chatPerformanceStats);

  requiredElement<HTMLElement>(reply, '[data-context="md-diagram-code"]').click();
  await nextTick();
  resetStats();
  await send(`${open}\n${fence}\n\nХвост`, 3);

  return {
    initial,
    closed,
    tail: structuredClone(host.__chatPerformanceStats),
    kept: reply.querySelector('.md-fence[data-lang="ts"]') === code,
    expanded: !requiredElement(reply, '.md-fence[data-lang="text"]').classList
      .contains('md-fence--collapsed'),
    showingCode: !!reply.querySelector('[data-context="md-diagram-show"]'),
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
  resetStats,
  control
};
