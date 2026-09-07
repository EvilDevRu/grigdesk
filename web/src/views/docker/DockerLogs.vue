<template>
  <div class="docker-logs">
    <div class="docker-logs__bar">
      <div class="docker-logs__filter">
        <UiSearchInput
          v-model="filter"
          placeholder="Найти строку в логах"
          aria-label="Фильтр строк лога"
        />
      </div>
      <UiCheckbox v-model="follow">Автопрокрутка</UiCheckbox>
      <span class="docker-logs__status" :class="status" role="status">{{ statusLabel }}</span>
    </div>

    <div ref="host" class="docker-logs__body" @scroll="onScroll">
      <p v-if="!visible.length" class="docker-logs__empty">
        {{ lines.length ? 'По этому запросу строки не найдены.' : 'Логов пока нет.' }}
      </p>
      <p
        v-for="line in visible"
        :key="line.key"
        class="docker-logs__line"
        :class="{ 'is-stderr': line.stream === 'stderr' }"
      >{{ line.text }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';

import { parseDockerLogMessage } from '../../../../shared/dockerContracts';
import type { DockerContainer, DockerLogFrame, DockerLogMessage } from '../../../../shared/dockerContracts';
import { api } from '../../shared/api-client.js';
import { UiCheckbox, UiSearchInput } from '../../ui';

type LogStatus = 'connecting' | 'open' | 'closed' | 'error';

interface LogLine extends DockerLogFrame {
  key: number;
}

const props = defineProps<{ container: DockerContainer }>();

// Лента лога живёт в памяти вкладки, и держать в ней весь журнал контейнера
// незачем: экран показывает хвост, а полная история есть у самого демона.
const MAX_LINES = 5000;

const host = ref<HTMLElement | null>(null);
const lines = ref<LogLine[]>([]);
const filter = ref('');
const follow = ref(true);
const status = ref<LogStatus>('connecting');

let socket: WebSocket | null = null;
let sequence = 0;

const statusLabel = computed(() => ({
  connecting: 'подключаюсь…',
  open: 'поток открыт',
  closed: 'поток закрыт',
  error: 'ошибка',
}[status.value]));

const visible = computed(() => {
  const needle = filter.value.trim().toLowerCase();

  if (!needle) {
    return lines.value;
  }

  return lines.value.filter((line) => line.text.toLowerCase().includes(needle));
});

/**
 * Прокрутка отпускается, как только человек сам ушёл вверх: догонять чужой курсор
 * автопрокруткой — самый быстрый способ сделать логи нечитаемыми.
 */
function onScroll(): void {
  const element = host.value;

  if (!element) {
    return;
  }

  const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 40;

  if (!atBottom && follow.value) {
    follow.value = false;
  }
}

/**
 * Новая порция строк меняет высоту после отрисовки Vue. Прокрутка учитывает
 * готовую разметку и сохраняет ручное отключение слежения.
 */
async function scrollToBottom(): Promise<void> {
  if (!follow.value) {
    return;
  }

  await nextTick();

  const element = host.value;

  if (element) {
    element.scrollTop = element.scrollHeight;
  }
}

/**
 * Лента получает только проверенные кадры и обрезается до последнего хвоста.
 * Ключи строк растут независимо от удаления старых записей.
 */
function push(batch: DockerLogFrame[]): void {
  const next = lines.value.concat(batch.map((frame) => ({
    key: ++sequence,
    stream: frame.stream,
    // Демон отдаёт строки с переводом в конце — в разметке он лишний.
    text: frame.text.replace(/\n$/u, ''),
  })));

  lines.value = next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
  scrollToBottom();
}

/**
 * Просмотрщик освобождает соединение перед переключением и при размонтировании.
 * Повторное закрытие не мешает завершить локальную очистку ссылки.
 */
function disconnect(): void {
  try {
    socket?.close();
  } catch {
    // Уже закрытый сокет не мешает переключению контейнера.
  }

  socket = null;
}

/**
 * Сообщение сокета проходит проверку контракта до обращения к полям.
 * Повреждённый кадр пропускается, чтобы следующие строки оставались доступны.
 */
function receive(event: MessageEvent<unknown>): void {
  if (typeof event.data !== 'string') {
    return;
  }

  let message: DockerLogMessage;

  try {
    message = parseDockerLogMessage(JSON.parse(event.data));
  } catch {
    return;
  }

  if (message.t === 'log') {
    push(message.lines);
  }
  if (message.t === 'end') {
    status.value = 'closed';
  }
  if (message.t === 'error') {
    status.value = 'error';
    push([{ stream: 'stderr', text: message.message || 'поток логов оборвался' }]);
  }
}

/**
 * Смена контейнера закрывает прежний поток и сбрасывает видимый хвост.
 * Жизненным циклом соединения владеет только этот просмотрщик.
 */
function connect(id: string): void {
  disconnect();
  lines.value = [];
  status.value = 'connecting';
  socket = new WebSocket(api.wsUrl(`/api/docker/logs?id=${encodeURIComponent(id)}`));
  socket.onopen = () => {
    status.value = 'open';
  };
  socket.onmessage = receive;
  socket.onclose = () => {
    if (status.value !== 'error') {
      status.value = 'closed';
    }
  };
}

watch(() => props.container.id, (id) => {
  if (id) {
    connect(id);
  } else {
    disconnect();
  }
}, { immediate: true });

watch(follow, (value) => {
  if (value) {
    scrollToBottom();
  }
});

onBeforeUnmount(disconnect);
</script>

<style scoped>
.docker-logs {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
  flex-direction: column;
}

.docker-logs__bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
  gap: 10px 12px;
}

.docker-logs__filter {
  min-width: 0;
  flex: 1 1 200px;
}

.docker-logs__status {
  color: var(--ink-mid);
  margin-left: auto;
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.docker-logs__status.open {
  color: var(--good);
}

.docker-logs__status.error {
  color: var(--bad);
}

.docker-logs__body {
  min-width: 0;
  min-height: 0;
  flex: 1;
  padding: 12px;
  background: var(--ground);
  overflow: auto;
}

.docker-logs__empty {
  margin: 8px 0;
  color: var(--ink-mid);
  font-size: 12px;
}

.docker-logs__line {
  margin: 0;
  color: var(--ink);
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.docker-logs__line.is-stderr {
  color: var(--bad);
}
@container docker-panel (max-width: 560px) {
  .docker-logs__filter {
    flex-basis: 100%;
  }
}
</style>
