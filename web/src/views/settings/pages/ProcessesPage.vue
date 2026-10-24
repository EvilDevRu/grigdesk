<template>
  <section
    class="settings-processes"
    data-processes-page
    :data-ready="loaded"
  >
    <SettingsScope :scope="t('settings.thisMachine')">{{ t('settings.processActionsTakeEffectImmediately') }}</SettingsScope>
    <div class="settings-process-actions">
      <UiButton data-context="workspace-form-wrap" :disabled="busy || loading" @click="load">{{ t('settings.update') }}</UiButton>
      <UiButton data-context="workspace-form-wrap" :disabled="busy || !freeCount" @click="closeFree">{{ t('settings.stopIdleProcesses') }}</UiButton>
    </div>
    <UiLoadingState v-if="!loaded && !error" :label="t('settings.loadingProcesses')" />
    <SettingsFacts v-else-if="loaded" :items="poolFacts" />
    <p v-if="loaded && !sessions.length">{{ t('settings.noLiveProcessesRightNow') }}</p>
    <article v-for="item in sessions" :key="item.chatKey" :data-running="item.running">
      <h4>{{ resolveUiText(title(item)) }}</h4>
      <p>{{ runLabel(item) }}</p>
      <p>
        PID {{ item.pid ?? t('settings.unknown') }} {{ t('settings.opened') }} {{ minutes(item.openedAt) }} {{ t('settings.minAgo') }}
        {{ item.running ? t('settings.turnRunning') : t('settings.idleMin', { value1: minutes(item.lastUsed) }) }}
        <span v-if="!item.running && item.idleAtMs">
          {{ t('settings.stopsIn') }} {{ Math.max(0, Math.round((item.idleAtMs - now) / 60000)) }} {{ t('settings.min') }}
        </span>
        <span v-if="item.unsolicited">{{ t('settings.maySpeakOnItsOwn') }}</span>
      </p>
      <p v-if="item.cwd">{{ item.cwd }}</p>
      <div class="settings-process-actions">
        <UiButton data-context="workspace-form-wrap" :disabled="busy" @click="actions.openChat(item.chatKey)">{{ t('settings.openChat') }}</UiButton>
        <UiButton data-context="workspace-form-wrap" :disabled="busy" @click="closeOne(item)">{{ t('settings.stopProcess') }}</UiButton>
      </div>
    </article>
    <p v-if="message" role="status">{{ resolveUiText(message) }}</p>
    <p v-if="error" role="alert">{{ resolveUiText(error) }}</p>
  </section>
</template>

<script setup lang="ts">
import {
  t,
  uiLocale,
  messageRef,
  resolveUiText,
  type UiText,
  UiLoadingState,
} from '../../../ui.ts';

import { computed, onBeforeUnmount, ref, watch } from 'vue';
import SettingsScope from '../SettingsScope.vue';
import SettingsFacts from '../SettingsFacts.vue';
import { useRouter } from 'vue-router';
import { UiButton, confirmDialog } from '../../../ui.ts';
import { api, failureText } from '../../../shared/apiClient.ts';
import { useProvidersStore } from '../../../stores/providers.ts';
import { useChatStore } from '../../../stores/chat.ts';
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
const error = ref<UiText>('');
const message = ref<UiText>('');
const now = ref(Date.now());
const freeCount = computed(() => sessions.value.filter((item) => !item.running).length);
const poolFacts = computed(() => [
  { label: t('settings.processFactPool'), value: String(sessions.value.length) },
  { label: t('settings.processFactRunning'), value: String(sessions.value.length - freeCount.value) },
  { label: t('settings.processFactIdle'), value: String(freeCount.value) },
  ...limits.value ? [{
    label: t('settings.processFactLimit'),
    value: t('settings.processFactLimitValue', {
      count: limits.value.maxSessions,
      minutes: Math.round(limits.value.idleMs / 60000),
    }),
  }] : [],
]);
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
}, uiLocale);

function current(): boolean {
  return !disposed && props.active && settings.isOpen && settings.snapshot.sessionId === opening;
}

/**
 * Подпись сохраняет название чата и принадлежность задаче без раскрытия ключа.
 * Для безымянного разговора задача остаётся понятной человеку точкой входа.
 */
function title(item: ProcessView): UiText {
  return item.chatTitle
    ? messageRef('settings.namedProcessChat', {
      chatTitle: item.chatTitle,
      task: item.taskId ? messageRef('settings.task', { itemTaskId: item.taskId }) : '',
    })
    : item.taskId ? messageRef('settings.taskChat', { itemTaskId: item.taskId })
      : messageRef('settings.untitledChat');
}

function runLabel(item: ProcessView): string {
  const provider = (providers.providers as ProviderEntry[]).find((entry) => entry.id === item.executor);

  const mode = provider?.modes?.find((entry) => entry.id === item.permissionMode)?.label;

  return [
    provider?.name || item.executor,
    item.model,
    item.effort ? t('settings.effort2', { itemEffort: item.effort }) : '',
    mode || item.permissionMode,
  ].filter(Boolean).join(' · ');
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
    const warning = item.running ? messageRef('settings.aTurnIsRunningUnsavedWorkWill')
      : messageRef('settings.theNextTurnWillStartItAgain');
    const accepted = await confirmDialog(messageRef('settings.processStopConfirmation', {
      value1: title(item),
      warning,
    }), {
      danger: item.running,
      okText: item.running ? messageRef('settings.stopRunningTurn') : messageRef('settings.stopProcess'),
    });

    if (accepted && current()) {
      version += 1;
      controller?.abort();
      loading.value = false;

      const query = item.running ? '?force=1' : '';

      await api.del(`/api/chat/sessions/${encodeURIComponent(item.chatKey)}${query}`);
      message.value = messageRef('settings.processStoppedConversationSaved');
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
    const accepted = await confirmDialog(messageRef('settings.stopIdleProcessesBusyProcessesWillRemain'), {
      okText: messageRef('settings.stopIdleProcesses'),
    });

    if (accepted && current()) {
      version += 1;
      controller?.abort();
      loading.value = false;

      const result = await api.del('/api/chat/sessions') as { closed: number; skipped?: number };

      message.value = messageRef('settings.stoppedBusyProcessesSkipped', {
        resultClosed: result.closed,
        value2: result.skipped ?? 0,
      });
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
.settings-processes, .settings-processes article {
  display: grid;
  gap: 12px;
  min-width: 0;
}
.settings-process-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.settings-processes p, .settings-processes h4 {
  margin: 0;
  overflow-wrap: anywhere;
}
.settings-processes article {
  padding: 16px 0;
  border-bottom: 1px solid var(--line);
}
.settings-processes article[data-running='true'] {
  border-bottom-color: color-mix(in srgb, var(--accent) 55%, var(--line));
}
.settings-processes article h4 {
  font-size: 13px;
  font-weight: 600;
}
.settings-processes p {
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.6;
}
</style>
