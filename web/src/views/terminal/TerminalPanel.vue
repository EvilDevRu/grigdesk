<template>
  <div class="term-view" :class="{ compact }">
    <div class="bar">
      <span class="st" :class="status">
        <span class="dot"></span>
        {{ status === 'open' ? 'подключено' : status === 'connecting' ? 'подключение…' : 'отключено' }}
      </span>
      <div class="chips">
        <UiCommandButton class="chip" title="Авторизация Claude" @click="insert('claude\n')">claude login</UiCommandButton>
        <UiCommandButton class="chip" @click="insert('claude --version\n')">claude --version</UiCommandButton>
        <UiCommandButton class="chip" @click="insert('clear\n')">clear</UiCommandButton>
      </div>
      <UiButton v-if="status === 'closed'" class="reconnect" variant="solid" tone="accent"
                @click="reconnect">Переподключить</UiButton>
      <UiButton v-else class="end" tone="danger"
                @click="closeSession({ announce: true })">Завершить сессию</UiButton>
    </div>
    <div ref="host" class="term-host" data-escape-owner="terminal"></div>
  </div>
</template>

<script setup>
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { api } from '../../shared/apiClient.ts';
import { UiButton, UiCommandButton } from '../../ui';

const props = defineProps({
  active: { type: Boolean, default: true },
  compact: { type: Boolean, default: false },
  presentation: { type: String, default: 'page' },
  intents: { type: Array, default: () => [] },
});
const emit = defineEmits(['consume-intent', 'status', 'context']);

const host = ref(null);
const status = ref('closed'); // connecting | open | closed
let term = null;
let fit = null;
let ws = null;
let ro = null;
let disposed = false;
let generation = 0;
let shellReady = false;
let inputDisposable = null;
let resizeFrame = 0;
let lastSize = '';
let processingIntents = false;
const handledIntentIds = new Set();

const clamp = (value, min, max) => Math.min(max, Math.max(min, Math.round(Number(value) || min)));

function sendResize() {
  if (!props.active || !term || !ws || ws.readyState !== WebSocket.OPEN) return;
  const cols = clamp(term.cols, 20, 500);
  const rows = clamp(term.rows, 5, 200);
  const key = `${cols}:${rows}`;
  if (key === lastSize) return;
  lastSize = key;
  ws.send(JSON.stringify({ t: 'resize', cols, rows }));
}

function fitAndResize() {
  if (!props.active || !term || !fit) return;
  try { fit.fit(); } catch { return; }
  if (resizeFrame) cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = 0;
    sendResize();
  });
}

async function ensureTerminal() {
  if (term || disposed) return;
  await nextTick();
  // Несколько watcher'ов могут одновременно ждать один nextTick. После него
  // проверяем term повторно, чтобы не создать два xterm в одном render-site.
  if (term || !host.value || disposed) return;
  term = new Terminal({
    cursorBlink: true,
    fontFamily: 'ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace',
    fontSize: 13,
    lineHeight: 1.2,
    theme: {
      background: '#0a0c10', foreground: '#e7eaf0', cursor: '#5aa2ff',
      selectionBackground: '#2e3742', black: '#0a0c10', brightBlack: '#39424f',
      red: '#f0564c', green: '#3fb950', yellow: '#e0a33a', blue: '#5aa2ff',
      magenta: '#b47cff', cyan: '#37b7c3', white: '#e7eaf0', brightWhite: '#ffffff',
    },
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host.value);
  inputDisposable = term.onData((data) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'in', d: data }));
  });
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => { if (props.active) fitAndResize(); });
    ro.observe(host.value);
  }
  fitAndResize();
}

async function connect() {
  if (disposed || !props.active || status.value === 'connecting'
      || (status.value === 'open' && ws?.readyState === WebSocket.OPEN)) return;
  // Ставим connecting до первого await: параллельные intent/activation-вызовы
  // увидят один общий reconnect и не откроют второй socket.
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
    if (disposed || own !== generation || ws !== socket) return;
    status.value = 'open';
    fitAndResize();
    if (props.active) term.focus();
  };
  socket.onmessage = (ev) => {
    if (disposed || own !== generation || ws !== socket) return;
    term.write(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data));
    if (!shellReady) {
      shellReady = true;
      // Первый вывод означает, что shell поднялся. Короткая пауза даёт readline
      // дорисовать prompt; внешняя команда вставляется без Enter.
      setTimeout(() => {
        if (own === generation && ws === socket) processIntents();
      }, 200);
    }
  };
  socket.onclose = () => {
    if (own !== generation || ws !== socket) return;
    ws = null;
    shellReady = false;
    status.value = 'closed';
    if (!disposed) term.write('\r\n\x1b[90m— сессия завершена. Кнопка «Переподключить» —\x1b[0m\r\n');
  };
  socket.onerror = () => {
    // Браузер обычно пришлёт onclose следом, но контракт WebSocket этого не
    // гарантирует. Сразу отвязываем сломанный socket, чтобы следующий intent
    // не оставил его висеть рядом с единственным reconnect.
    if (own === generation && ws === socket) closeSession();
  };
}

function closeSession({ announce = false } = {}) {
  generation += 1;
  const socket = ws;
  ws = null;
  shellReady = false;
  status.value = 'closed';
  lastSize = '';
  try { socket?.close(); } catch { /* уже закрыт */ }
  if (announce && term && !disposed) {
    term.write('\r\n\x1b[90m— сессия завершена вручную —\x1b[0m\r\n');
  }
}

function reconnect() {
  closeSession();
  term?.reset();
  connect();
}

// Быстрая вставка команды (не выполняет — просто печатает, Enter жмёшь сам).
function insert(cmd) {
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

function unhandledIntents() {
  const current = new Set(props.intents.map((intent) => intent.id));
  for (const id of handledIntentIds) {
    if (!current.has(id)) handledIntentIds.delete(id);
  }
  return props.intents.filter((intent) => !handledIntentIds.has(intent.id));
}

async function processIntents() {
  const pending = unhandledIntents();
  if (!props.active || processingIntents || !pending.length) return;
  await ensureTerminal();
  if (status.value === 'closed') {
    connect();
    return;
  }
  if (status.value !== 'open' || !shellReady || ws?.readyState !== WebSocket.OPEN) return;
  processingIntents = true;
  try {
    for (const intent of pending) {
      if (intent.type === 'insert' && typeof intent.text === 'string' && !insert(intent.text)) return;
      handledIntentIds.add(intent.id);
      emit('consume-intent', intent.id);
    }
  } finally {
    processingIntents = false;
    // Не оставляем intent, который добавился во время обработки снимка очереди.
    if (props.active && unhandledIntents().length) queueMicrotask(processIntents);
  }
}

function focusPanel() { if (props.active) term?.focus(); }
defineExpose({ focus: focusPanel });

watch(() => props.active, async (active) => {
  if (!active) {
    emit('context', null);
    return;
  }
  await ensureTerminal();
  if (status.value === 'closed') await connect();
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
  if (resizeFrame) cancelAnimationFrame(resizeFrame);
  try { ro && ro.disconnect(); } catch { /* ignore */ }
  closeSession();
  try { inputDisposable?.dispose?.(); } catch { /* ignore */ }
  try { term && term.dispose(); } catch { /* ignore */ }
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
