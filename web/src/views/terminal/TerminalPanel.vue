<template>
  <div class="term-view" :class="{ compact }">
    <div class="bar">
      <span class="st" :class="status">
        <span class="dot"></span>
        {{ status === 'open' ? 'подключено' : status === 'connecting' ? 'подключение…' : 'отключено' }}
      </span>
      <UiPopover placement="bottom-start" aria-label="Быстрые команды терминала">
        <template #trigger><UiButton variant="text">Команды</UiButton></template>
        <template #default="{ close }">
          <div class="ui-action-menu">
            <UiCommandButton @click="insert('claude\n'); close('action')">claude login</UiCommandButton>
            <UiCommandButton @click="insert('claude --version\n'); close('action')">
              claude --version
            </UiCommandButton>
            <UiCommandButton @click="insert('clear\n'); close('action')">clear</UiCommandButton>
          </div>
        </template>
      </UiPopover>
      <UiButton v-if="status === 'closed'" class="reconnect" variant="solid" tone="accent"
                @click="reconnect">Переподключить</UiButton>
      <UiButton v-else class="end" tone="danger"
                @click="closeSession({ announce: true })" aria-label="Завершить сессию">Завершить</UiButton>
    </div>
    <div ref="host" class="term-host" data-escape-owner="terminal"></div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import type { PropType } from 'vue';
import { Terminal } from '@xterm/xterm';
import type { IDisposable } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

import { api } from '../../shared/apiClient.ts';
import { UiButton, UiCommandButton, UiPopover } from '../../ui';

interface TerminalIntent extends Record<string, unknown> {
  id: number;
}

type TerminalStatus = 'connecting' | 'open' | 'closed';

const props = defineProps({
  active: { type: Boolean, default: true },
  compact: { type: Boolean, default: false },
  presentation: { type: String, default: 'page' },
  intents: { type: Array as PropType<TerminalIntent[]>, default: () => [] },
});

const emit = defineEmits<{
  'consume-intent': [id: number];
  status: [value: { status: TerminalStatus }];
  context: [value: { id: 'terminal'; presentation: string } | null];
}>();

const host = ref<HTMLElement | null>(null);
const status = ref<TerminalStatus>('closed');
let term: Terminal | null = null;
let fit: FitAddon | null = null;
let ws: WebSocket | null = null;
let ro: ResizeObserver | null = null;
let disposed = false;
let generation = 0;
let shellReady = false;
let inputDisposable: IDisposable | null = null;
let resizeFrame = 0;
let lastSize = '';
let processingIntents = false;
const handledIntentIds = new Set<number>();

const clamp = (value: unknown, min: number, max: number) => (
  Math.min(max, Math.max(min, Math.round(Number(value) || min)))
);

/**
 * Передаёт размер только активной панели с открытым сокетом.
 * Повтор того же размера не создаёт ещё одно сообщение терминалу.
 */
function sendResize() {
  if (!props.active || !term || !ws || ws.readyState !== WebSocket.OPEN) {
    return;
  }

  const cols = clamp(term.cols, 20, 500);
  const rows = clamp(term.rows, 5, 200);
  const key = `${cols}:${rows}`;

  if (key === lastSize) {
    return;
  }

  lastSize = key;
  ws.send(JSON.stringify({
    t: 'resize',
    cols,
    rows,
  }));
}

/**
 * Сначала подгоняет xterm к доступному месту, затем сообщает размер PTY.
 * Несколько изменений раскладки объединяются в один кадр браузера.
 */
function fitAndResize() {
  if (!props.active || !term || !fit) {
    return;
  }

  try {
    fit.fit();
  } catch {
    return;
  }

  if (resizeFrame) {
    cancelAnimationFrame(resizeFrame);
  }

  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = 0;
    sendResize();
  });
}

/**
 * Создаёт один xterm после появления хоста в DOM.
 * Повторная проверка после nextTick объединяет параллельные watcher-вызовы.
 */
async function ensureTerminal() {
  if (term || disposed) {
    return;
  }

  await nextTick();

  if (term || !host.value || disposed) {
    return;
  }

  term = new Terminal({
    cursorBlink: true,
    fontFamily: 'ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace',
    fontSize: 13,
    lineHeight: 1.2,
    theme: {
      background: '#0a0c10',
      foreground: '#e7eaf0',
      cursor: '#5aa2ff',
      selectionBackground: '#2e3742',
      black: '#0a0c10',
      brightBlack: '#39424f',
      red: '#f0564c',
      green: '#3fb950',
      yellow: '#e0a33a',
      blue: '#5aa2ff',
      magenta: '#b47cff',
      cyan: '#37b7c3',
      white: '#e7eaf0',
      brightWhite: '#ffffff',
    },
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host.value);
  inputDisposable = term.onData((data) => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ t: 'in', d: data }));
    }
  });

  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => {
      if (props.active) {
        fitAndResize();
      }
    });
    ro.observe(host.value);
  }

  fitAndResize();
}

/**
 * Поднимает один сокет для текущего поколения панели.
 * Только строка и ArrayBuffer подтверждают готовность shell и попадают в xterm.
 */
async function connect() {
  if (disposed || !props.active || status.value === 'connecting'
      || (status.value === 'open' && ws?.readyState === WebSocket.OPEN)) {
    return;
  }

  // Ставим connecting до первого await, чтобы параллельный вызов не открыл второй сокет.
  status.value = 'connecting';
  await ensureTerminal();

  if (!term || disposed || !props.active) {
    status.value = 'closed';

    return;
  }

  const own = ++generation;

  shellReady = false;
  lastSize = '';
  fitAndResize();

  const { cols, rows } = term;
  const u = api.wsUrl('/api/terminal') + `?cols=${cols}&rows=${rows}`;
  const socket = new WebSocket(u);

  ws = socket;
  socket.binaryType = 'arraybuffer';
  socket.onopen = () => {
    if (disposed || own !== generation || ws !== socket) {
      return;
    }

    status.value = 'open';
    fitAndResize();

    if (props.active) {
      term?.focus();
    }
  };
  socket.onmessage = (ev: MessageEvent<unknown>) => {
    if (disposed || own !== generation || ws !== socket) {
      return;
    }
    if (typeof ev.data !== 'string' && !(ev.data instanceof ArrayBuffer)) {
      return;
    }

    term?.write(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data));

    if (!shellReady) {
      shellReady = true;
      // Первый вывод означает, что shell поднялся. Пауза оставляет readline время
      // дорисовать prompt; внешняя команда по-прежнему вставляется без Enter.
      setTimeout(() => {
        if (own === generation && ws === socket) {
          processIntents();
        }
      }, 200);
    }
  };
  socket.onclose = () => {
    if (own !== generation || ws !== socket) {
      return;
    }

    ws = null;
    shellReady = false;
    status.value = 'closed';

    if (!disposed) {
      term?.write('\r\n\x1b[90m— сессия завершена. Кнопка «Переподключить» —\x1b[0m\r\n');
    }
  };
  socket.onerror = () => {
    // Браузер обычно пришлёт onclose следом, но это не гарантировано.
    // Сломанный сокет отвязывается до следующего намерения переподключения.
    if (own === generation && ws === socket) {
      closeSession();
    }
  };
}

/**
 * Отвязывает сокет и делает его поздние события неактуальными.
 * Ручное завершение дополнительно оставляет строку в терминале.
 */
function closeSession({ announce = false } = {}) {
  generation += 1;

  const socket = ws;

  ws = null;
  shellReady = false;
  status.value = 'closed';
  lastSize = '';

  try {
    socket?.close();
  } catch { /* уже закрыт */ }

  if (announce && term && !disposed) {
    term.write('\r\n\x1b[90m— сессия завершена вручную —\x1b[0m\r\n');
  }
}

function reconnect() {
  closeSession();
  term?.reset();
  connect();
}

/**
 * Вставляет текст команды в открытую сессию, сохраняя прежний протокол ввода.
 * Ошибка отправки закрывает сессию; повтор намерения дождётся переподключения.
 */
function insert(cmd: string) {
  if (ws?.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ t: 'in', d: cmd }));
      term?.focus();

      return true;
    } catch {
      closeSession();
    }
  }

  return false;
}

/**
 * Удаляет подтверждения намерений, уже снятых владельцем очереди.
 * Оставшиеся id защищают текущий снимок от повторной вставки.
 */
function unhandledIntents() {
  const current = new Set(props.intents.map((intent) => intent.id));

  for (const id of handledIntentIds) {
    if (!current.has(id)) {
      handledIntentIds.delete(id);
    }
  }

  return props.intents.filter((intent) => !handledIntentIds.has(intent.id));
}

/**
 * Обрабатывает один снимок очереди после подтверждённого запуска shell.
 * Новые намерения дочитываются микрозадачей без второго обработчика очереди.
 */
async function processIntents() {
  const pending = unhandledIntents();

  if (!props.active || processingIntents || !pending.length) {
    return;
  }

  await ensureTerminal();

  if (status.value === 'closed') {
    connect();

    return;
  }
  if (status.value !== 'open' || !shellReady || ws?.readyState !== WebSocket.OPEN) {
    return;
  }

  processingIntents = true;

  try {
    for (const intent of pending) {
      if (intent.type === 'insert' && typeof intent.text === 'string' && !insert(intent.text)) {
        return;
      }

      handledIntentIds.add(intent.id);
      emit('consume-intent', intent.id);
    }
  } finally {
    processingIntents = false;

    if (props.active && unhandledIntents().length) {
      queueMicrotask(processIntents);
    }
  }
}

function focusPanel() {
  if (props.active) {
    term?.focus();
  }
}

defineExpose({ focus: focusPanel });

watch(() => props.active, async (active) => {
  if (!active) {
    emit('context', null);

    return;
  }

  await ensureTerminal();

  if (status.value === 'closed') {
    await connect();
  }

  await nextTick();
  fitAndResize();
  processIntents();
}, { immediate: true });
watch(() => props.intents, processIntents, { deep: true });
watch(status, (value) => emit('status', { status: value }), { immediate: true });
watch(
  [() => props.active, () => props.presentation],
  ([active, presentation]) => emit('context', active ? { id: 'terminal', presentation } : null),
  { immediate: true },
);

const closeForReload = () => closeSession();

onMounted(() => window.addEventListener('beforeunload', closeForReload));
onBeforeUnmount(() => {
  disposed = true;
  window.removeEventListener('beforeunload', closeForReload);

  if (resizeFrame) {
    cancelAnimationFrame(resizeFrame);
  }

  try {
    ro && ro.disconnect();
  } catch { /* наблюдатель уже снят */ }

  closeSession();

  try {
    inputDisposable?.dispose?.();
  } catch { /* подписка уже снята */ }

  try {
    term && term.dispose();
  } catch { /* терминал уже снят */ }
});
</script>

<style scoped>
.term-view { height: 100%; display: flex; flex-direction: column; min-height: 0; }
.bar { display: flex; align-items: center; gap: 12px; padding: 8px 12px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.st { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; color: var(--ink-mid); }
.st .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--idle); }
.st.open .dot { background: var(--good); box-shadow: 0 0 6px color-mix(in srgb, var(--good) 60%, transparent); }
.st.connecting .dot { background: var(--warn); }
.st.closed .dot { background: var(--bad); }
.chips { display: flex; gap: 6px; flex-wrap: wrap; }
.reconnect, .end { margin-left: auto; }
.term-host { flex: 1; min-height: 0; padding: 8px 10px; background: var(--ground); overflow: hidden; }
:deep(.xterm) { height: 100%; }
:deep(.xterm-viewport) { background: transparent !important; }
.term-view.compact .bar { gap: 8px; padding: 7px var(--tool-dock-actions-space, 9px) 7px 9px; }
</style>
