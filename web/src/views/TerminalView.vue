<script setup>
import { ref, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api } from '../shared/api-client.js';

// Веб-терминал на «мозге»: PTY через WebSocket. Для авторизации Claude (`claude login`)
// и ручных операций. Один экран = одна сессия (при уходе со страницы — закрывается).

const host = ref(null);
const status = ref('connecting'); // connecting | open | closed
let term = null;
let fit = null;
let ws = null;
let ro = null;
let disposed = false;

function connect() {
  if (!term) return;
  status.value = 'connecting';
  const { cols, rows } = term;
  let u = api.wsUrl('/api/terminal') + `?cols=${cols}&rows=${rows}`;
  if (api.token) u += `&token=${encodeURIComponent(api.token)}`;
  ws = new WebSocket(u);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => { status.value = 'open'; term.focus(); };
  ws.onmessage = (ev) => { term.write(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data)); };
  ws.onclose = () => {
    status.value = 'closed';
    if (!disposed) term.write('\r\n\x1b[90m— сессия завершена. Кнопка «Переподключить» —\x1b[0m\r\n');
  };
  ws.onerror = () => { status.value = 'closed'; };
}

function reconnect() { try { ws && ws.close(); } catch { /* ignore */ } term.reset(); connect(); }

// Быстрая вставка команды (не выполняет — просто печатает, Enter жмёшь сам).
function insert(cmd) {
  if (ws && ws.readyState === 1) { ws.send(JSON.stringify({ t: 'in', d: cmd })); term.focus(); }
}

onMounted(async () => {
  await nextTick();
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
  fit.fit();
  term.onData((d) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'in', d })); });

  // Перерисовка при изменении размера контейнера (шелл держит начальный размер — косметика).
  ro = new ResizeObserver(() => { try { fit.fit(); } catch { /* ignore */ } });
  ro.observe(host.value);

  connect();
});

onBeforeUnmount(() => {
  disposed = true;
  try { ro && ro.disconnect(); } catch { /* ignore */ }
  try { ws && ws.close(); } catch { /* ignore */ }
  try { term && term.dispose(); } catch { /* ignore */ }
});
</script>

<template>
  <div class="term-view">
    <div class="bar">
      <span class="st" :class="status">
        <span class="dot"></span>
        {{ status === 'open' ? 'подключено' : status === 'connecting' ? 'подключение…' : 'отключено' }}
      </span>
      <div class="chips">
        <button class="chip" title="Авторизация Claude" @click="insert('claude\n')">claude login</button>
        <button class="chip" @click="insert('claude --version\n')">claude --version</button>
        <button class="chip" @click="insert('clear\n')">clear</button>
      </div>
      <button v-if="status === 'closed'" class="reconnect" @click="reconnect">Переподключить</button>
    </div>
    <div ref="host" class="term-host"></div>
  </div>
</template>

<style scoped>
.term-view { height: 100%; display: flex; flex-direction: column; min-height: 0; }
.bar { display: flex; align-items: center; gap: 12px; padding: 8px 12px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.st { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; color: var(--ink-mid); }
.st .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--idle); }
.st.open .dot { background: var(--good); box-shadow: 0 0 6px color-mix(in srgb, var(--good) 60%, transparent); }
.st.connecting .dot { background: var(--warn); }
.st.closed .dot { background: var(--bad); }
.chips { display: flex; gap: 6px; flex-wrap: wrap; }
.chip { background: var(--surface-2); border: 1px solid var(--line); color: var(--ink-mid); border-radius: 7px;
  padding: 4px 10px; font-size: 12px; cursor: pointer; font-family: var(--mono); }
.chip:hover { color: var(--ink); border-color: var(--line-2); }
.reconnect { margin-left: auto; background: var(--accent); color: #fff; border: none; border-radius: 8px;
  padding: 5px 14px; font-size: 12.5px; font-weight: 600; cursor: pointer; }
.term-host { flex: 1; min-height: 0; padding: 8px 10px; background: var(--ground); overflow: hidden; }
:deep(.xterm) { height: 100%; }
:deep(.xterm-viewport) { background: transparent !important; }
</style>
