<template>
  <section
    class="settings-processes"
    data-processes-page
    :data-ready="loaded"
  >
    <p>Живые процессы агентов · Операции выполняются сразу, отдельно от «Применить».</p>
    <div class="settings-process-actions">
      <UiButton :disabled="busy || loading" @click="load">Обновить</UiButton>
      <UiButton :disabled="busy || !freeCount" @click="closeFree">Погасить свободные</UiButton>
    </div>
    <p v-if="!loaded">Загружаем процессы…</p>
    <p v-else>
      В пуле: {{ sessions.length }} · ведут ход: {{ sessions.length - freeCount }} · свободны: {{ freeCount }}
    </p>
    <p v-if="loaded && !sessions.length">Сейчас ни одного живого процесса.</p>
    <article v-for="item in sessions" :key="item.chatKey">
      <h4>{{ title(item) }}</h4>
      <p>{{ runLabel(item) }}</p>
      <p>
        PID {{ item.pid ?? 'неизвестен' }} · открыт {{ minutes(item.openedAt) }} мин назад ·
        {{ item.running ? 'Идёт ход' : `Простой ${minutes(item.lastUsed)} мин` }}
        <span v-if="!item.running && item.idleAtMs">
          · погаснет через {{ Math.max(0, Math.round((item.idleAtMs - now) / 60000)) }} мин
        </span>
        <span v-if="item.unsolicited">· может заговорить сам</span>
      </p>
      <p v-if="item.cwd">{{ item.cwd }}</p>
      <div class="settings-process-actions">
        <UiButton :disabled="busy" @click="actions.openChat(item.chatKey)">Открыть чат</UiButton>
        <UiButton :disabled="busy" @click="closeOne(item)">Погасить</UiButton>
      </div>
    </article>
    <p v-if="limits">
      Лимит пула — {{ limits.maxSessions }}, автогашение — через {{ Math.round(limits.idleMs / 60000) }} мин
      простоя.
    </p>
    <p v-if="message" role="status">{{ message }}</p>
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { UiButton, confirmDialog } from '../../../ui.ts';
import { api, failureText } from '../../../shared/apiClient.ts';
import { useProvidersStore } from '../../../stores/providers.js';
import { useChatStore } from '../../../stores/chat.js';
import { useSettingsStore } from '../../../stores/settings.ts';
import { createSettingsActions } from '../../../features/settings/actions.ts';
import { sseSubscribe } from '../../../composables/useSse.ts';
import type { ProviderEntry } from '../../../../../shared/chat/providersContracts.ts';

interface ProcessView {
  chatKey: string;
  chatTitle?: string;
  taskId?: string | number | null;
  executor?: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  running: boolean;
  pid?: number;
  openedAt?: number;
  lastUsed?: number;
  idleAtMs?: number;
  unsolicited?: boolean;
  cwd?: string;
}

const props = defineProps<{ active: boolean }>();
const settings = useSettingsStore();
const providers = useProvidersStore();
const chat = useChatStore();
const router = useRouter();
const sessions = ref<ProcessView[]>([]);
const limits = ref<{ maxSessions: number; idleMs: number } | null>(null);
const loaded = ref(false);
const loading = ref(false);
const busy = ref(false);
const error = ref('');
const message = ref('');
const now = ref(Date.now());
const freeCount = computed(() => sessions.value.filter((item) => !item.running).length);
const opening = settings.snapshot.sessionId;
let timer: ReturnType<typeof setInterval> | null = null;
let controller: AbortController | null = null;
let version = 0;
let disposed = false;
const actions = createSettingsActions({
  requestAction: settings.requestAction,
  notify: (text) => {
    error.value = text;
  },
  openTerminal: async () => false,
  async openChat(key) {
    chat.setActive(key);
    await router.push('/chats');

    return true;
  },
});

function current(): boolean {
  return !disposed && props.active && settings.isOpen && settings.snapshot.sessionId === opening;
}

/**
 * Подпись сохраняет название чата и принадлежность задаче без раскрытия ключа.
 * Для безымянного разговора задача остаётся понятной человеку точкой входа.
 */
function title(item: ProcessView): string {
  return item.chatTitle ? item.chatTitle + (item.taskId ? ` · задача ${item.taskId}` : '')
    : item.taskId ? `Чат задачи ${item.taskId}` : 'Чат без названия';
}

function runLabel(item: ProcessView): string {
  const provider = (providers.providers as ProviderEntry[]).find((entry) => entry.id === item.executor);

  const mode = provider?.modes?.find((entry) => entry.id === item.permissionMode)?.label;

  return [provider?.name || item.executor, item.model, item.effort ? `Усилие ${item.effort}` : '',
    mode || item.permissionMode].filter(Boolean).join(' · ');
}

function minutes(at: number | undefined): number {
  return Math.max(0, Math.round((now.value - (at ?? now.value)) / 60000));
}

/**
 * Чтение и SSE обновляют список только в текущем посещении страницы.
 * Уход прерывает свой GET, поздний ответ не возвращает уже погашенный процесс.
 */
async function load(): Promise<void> {
  if (!current() || loading.value) {
    return;
  }

  const attempt = ++version;

  controller = new AbortController();
  loading.value = true;

  try {
    const result = await api.get('/api/chat/sessions', { signal: controller.signal }) as {
      sessions?: ProcessView[];
      maxSessions: number;
      idleMs: number;
    };

    if (current() && version === attempt) {
      sessions.value = (result.sessions ?? []).filter((item) => typeof item.chatKey === 'string');
      limits.value = { maxSessions: result.maxSessions, idleMs: result.idleMs };
      loaded.value = true;
    }
  } catch (cause) {
    if (current() && version === attempt) {
      error.value = failureText(cause);
    }
  } finally {
    if (version === attempt) {
      loading.value = false;
    }
  }
}

/**
 * Индивидуальное погашение подтверждается, с отдельным предупреждением об идущем ходе.
 * Отмена диалога не вызывает DELETE; согласие закрытой страницы также не действует.
 */
async function closeOne(item: ProcessView): Promise<void> {
  if (busy.value || !current()) {
    return;
  }

  busy.value = true;

  try {
    const accepted = await confirmDialog(`Погасить процесс чата «${title(item)}»?`
      + (item.running ? ' Сейчас идёт ход; незаписанная работа потеряется.'
        : ' Следующий ход поднимет его заново.'), {
      danger: item.running,
      okText: item.running ? 'Погасить с ходом' : 'Погасить',
    });

    if (accepted && current()) {
      version += 1;
      controller?.abort();
      loading.value = false;

      const query = item.running ? '?force=1' : '';

      await api.del(`/api/chat/sessions/${encodeURIComponent(item.chatKey)}${query}`);
      message.value = 'Процесс погашен. Разговор сохранён.';
      await load();
    }
  } catch (cause) {
    error.value = failureText(cause);
  } finally {
    busy.value = false;
  }
}

/**
 * Массовая операция подтверждается отдельно и сохраняет занятые ходом процессы.
 * Фактический счётчик берётся из ответа сервера, а не числа строк до запроса.
 */
async function closeFree(): Promise<void> {
  if (busy.value || !freeCount.value || !current()) {
    return;
  }

  busy.value = true;

  try {
    const accepted = await confirmDialog('Погасить свободные процессы? Занятые ходом останутся.', {
      okText: 'Погасить свободные',
    });

    if (accepted && current()) {
      version += 1;
      controller?.abort();
      loading.value = false;

      const result = await api.del('/api/chat/sessions') as { closed: number; skipped?: number };

      message.value = `Погашено: ${result.closed}. Занятых пропущено: ${result.skipped ?? 0}.`;
      await load();
    }
  } catch (cause) {
    error.value = failureText(cause);
  } finally {
    busy.value = false;
  }
}

const unsubscribe = sseSubscribe((name) => {
  if (name === 'chat-sessions' && current()) {
    void load();
  }
});

watch(() => props.active, (active) => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }

  version += 1;
  controller?.abort();
  loading.value = false;

  if (active && current()) {
    void load();
    timer = setInterval(() => {
      now.value = Date.now();
    }, 30000);
  }
}, { immediate: true });
onBeforeUnmount(() => {
  disposed = true;
  version += 1;
  controller?.abort();
  unsubscribe();

  if (timer) {
    clearInterval(timer);
  }
});
</script>

<style scoped>
.settings-processes, .settings-processes article { display: grid; gap: 12px; min-width: 0; }
.settings-process-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.settings-processes p, .settings-processes h4 { margin: 0; overflow-wrap: anywhere; }
</style>
