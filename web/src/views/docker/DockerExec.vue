<template>
  <div class="docker-exec">
    <div class="docker-exec__bar">
      <span class="docker-exec__status" :class="status" role="status">{{ statusLabel }}</span>
      <UiButton v-if="status === 'closed'" @click="connect">Переподключить</UiButton>
    </div>
    <div ref="host" class="docker-exec__host" data-escape-owner="docker-exec"></div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

import { parseDockerExecMessage } from '../../../../shared/dockerContracts';
import type { DockerContainer, DockerExecInput } from '../../../../shared/dockerContracts';
import { api } from '../../shared/api-client.js';
import { UiButton } from '../../ui';

type ExecStatus = 'connecting' | 'open' | 'closed' | 'error';

const props = withDefaults(defineProps<{
  container: DockerContainer;
  active?: boolean;
}>(), {
  active: true,
});

const host = ref<HTMLElement | null>(null);
const status = ref<ExecStatus>('closed');

let term: Terminal | null = null;
let fit: FitAddon | null = null;
let socket: WebSocket | null = null;
let observer: ResizeObserver | null = null;
let disposed = false;
let generation = 0;
let lastSize = '';

const statusLabel = computed(() => ({
  connecting: 'подключаюсь…',
  open: `${props.container.name} — оболочка открыта`,
  closed: 'сессия закрыта',
  error: 'не удалось запустить оболочку',
}[status.value]));

function sendInput(message: DockerExecInput): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

/**
 * Размер отправляется только открытому сокету и только после изменения.
 * Повторные наблюдения раскладки не нагружают Docker одинаковыми запросами.
 */
function sendResize(): void {
  if (!term || socket?.readyState !== WebSocket.OPEN) {
    return;
  }

  const key = `${term.cols}:${term.rows}`;

  if (key === lastSize) {
    return;
  }

  lastSize = key;
  sendInput({
    t: 'resize',
    cols: term.cols,
    rows: term.rows,
  });
}

/**
 * Скрытый или ещё не измеренный хост может отклонить подгонку xterm.
 * Успешный замер передаётся оболочке, отказ не прерывает её работу.
 */
function fitTerminal(): void {
  if (!term || !fit) {
    return;
  }

  try {
    fit.fit();
  } catch {
    return;
  }

  sendResize();
}

/**
 * xterm создаётся один раз на компонент: пересоздание при каждой смене контейнера
 * теряет размер, фокус и заводит второй экземпляр в том же узле.
 */
async function ensureTerminal(): Promise<void> {
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
    lineHeight: 1.3,
    theme: {
      background: '#0a0c10',
      foreground: '#e7eaf0',
      cursor: '#5aa2ff',
    },
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host.value);
  term.onData((data) => {
    sendInput({ t: 'in', d: data });
  });

  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => fitTerminal());
    observer.observe(host.value);
  }

  fitTerminal();
}

/**
 * Закрытие сначала инвалидирует обработчики старого поколения, затем сокет.
 * Терминал остаётся живым для следующего подключения.
 */
function disconnect(): void {
  generation += 1;

  try {
    socket?.close();
  } catch {
    // Уже закрытый сокет не мешает сменить контейнер или размонтировать панель.
  }

  socket = null;
  lastSize = '';
}

/**
 * JSON сервера описывает отказ, а остальные строки относятся к выводу оболочки.
 * Неподходящий JSON и обычный текст сохраняются в терминале без потери данных.
 */
function writeText(terminal: Terminal, data: string): void {
  try {
    const message = parseDockerExecMessage(JSON.parse(data));

    status.value = 'error';
    terminal.write(`\r\n\x1b[31m${message.message}\x1b[0m\r\n`);
  } catch {
    terminal.write(data);
  }
}

/**
 * Каждый поток пишет только в свой экземпляр терминала, пока его поколение актуально.
 * Двоичный вывод принимается как ArrayBuffer согласно binaryType соединения.
 */
function receive(event: MessageEvent<unknown>, own: number, terminal: Terminal): void {
  if (generation !== own) {
    return;
  }

  if (typeof event.data === 'string') {
    writeText(terminal, event.data);

    return;
  }

  if (event.data instanceof ArrayBuffer) {
    terminal.write(new Uint8Array(event.data));
  }
}

/**
 * Переподключение сохраняет xterm, но открывает новое поколение WebSocket.
 * Поздние события закрытого потока не меняют состояние новой сессии.
 */
async function connect(): Promise<void> {
  const id = props.container.id;

  if (!id || disposed) {
    return;
  }

  disconnect();
  status.value = 'connecting';
  await ensureTerminal();

  const terminal = term;

  if (!terminal || disposed) {
    return;
  }

  terminal.reset();

  const own = ++generation;
  const query = new URLSearchParams({
    id,
    cols: String(terminal.cols),
    rows: String(terminal.rows),
  });
  const next = new WebSocket(api.wsUrl(`/api/docker/exec?${query.toString()}`));

  next.binaryType = 'arraybuffer';
  socket = next;
  next.onopen = () => {
    if (generation !== own) {
      return;
    }

    status.value = 'open';
    lastSize = '';
    sendResize();
    terminal.focus();
  };
  next.onmessage = (event: MessageEvent<unknown>) => receive(event, own, terminal);
  next.onclose = () => {
    if (generation !== own) {
      return;
    }
    if (status.value !== 'error') {
      status.value = 'closed';
    }
  };
}

watch(() => props.container.id, (id) => {
  if (id && props.active) {
    connect();
  } else {
    disconnect();
  }
}, { immediate: true });

watch(() => props.active, (active) => {
  if (active) {
    fitTerminal();
  }
});

onBeforeUnmount(() => {
  disposed = true;
  disconnect();
  observer?.disconnect();
  term?.dispose();
  term = null;
});
</script>

<style scoped>
.docker-exec {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
  flex-direction: column;
}

.docker-exec__bar {
  display: flex;
  align-items: center;
  min-height: 44px;
  flex-wrap: wrap;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
  gap: 10px 12px;
}

.docker-exec__status {
  min-width: 0;
  flex: 1 1 180px;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.docker-exec__status.open {
  color: var(--good);
}

.docker-exec__status.error {
  color: var(--bad);
}

.docker-exec__host {
  min-width: 0;
  min-height: 0;
  flex: 1;
  padding: 8px;
  background: var(--ground);
}
</style>
