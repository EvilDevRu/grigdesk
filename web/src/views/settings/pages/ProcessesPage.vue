<template>
  <section
    class="settings-processes"
    :data-perf-pending="!loaded && loading ? '' : undefined"
    :data-perf-error="!loaded && error && !loading ? '' : undefined"
    data-processes-page
    :data-ready="loaded"
  >
    <SettingsScope :scope="t('settings.thisMachine')">
      {{ t('settings.processActionsTakeEffectImmediately') }}
    </SettingsScope>
    <SettingsLoading v-if="!loaded && !error" :label="t('settings.loadingProcesses')"
                     area="processes" page-id="system.processes" />
    <div v-else-if="loaded" class="settings-process-overview">
      <dl class="settings-process-metrics">
        <div v-for="fact in poolFacts" :key="fact.label" :data-running="fact.running">
          <dt>{{ fact.label }}</dt>
          <dd>{{ fact.value }}</dd>
        </div>
      </dl>
      <p v-if="limits" class="settings-process-policy">
        <span>{{ t('settings.processFactLimit') }}</span>
        {{ t('settings.processFactLimitValue', {
          count: limits.maxSessions,
          minutes: Math.round(limits.idleMs / 60000),
        }) }}
      </p>
    </div>
    <div class="settings-process-toolbar">
      <h4>{{ t('settings.liveProcesses') }}</h4>
      <div class="settings-process-actions">
        <UiButton
          data-context="workspace-form-wrap"
          :loading="loading"
          :disabled="busy"
          @click="load"
        >
          {{ t('settings.update') }}
        </UiButton>
        <UiButton
          data-context="workspace-form-wrap"
          :disabled="busy || !freeCount"
          @click="closeFree"
        >
          {{ t('settings.stopIdleProcesses') }}
        </UiButton>
      </div>
    </div>
    <SettingsEmpty
      v-if="loaded && !sessions.length"
      :heading="t('settings.noLiveProcessesRightNow')"
    />
    <div v-if="sessions.length" class="settings-process-list">
      <article v-for="item in sessions" :key="item.chatKey" :data-running="item.running">
        <header class="settings-process-heading">
          <h5>{{ resolveUiText(title(item)) }}</h5>
          <span class="settings-process-status" :data-running="item.running">
            <span aria-hidden="true" />
            {{ item.running ? t('settings.turnRunning') : t('settings.processStatusIdle') }}
          </span>
        </header>
        <p class="settings-process-provider">{{ runLabel(item) }}</p>
        <div class="settings-process-meta">
          <span class="settings-process-pid">PID {{ item.pid ?? t('settings.unknown') }}</span>
          <span>{{ t('settings.processOpenedAgo', { minutes: minutes(item.openedAt) }) }}</span>
          <span v-if="!item.running">
            {{ t('settings.idleMin', { value1: minutes(item.lastUsed) }) }}
          </span>
          <span v-if="!item.running && item.idleAtMs">
            {{ t('settings.processStopsIn', {
              minutes: Math.max(0, Math.round((item.idleAtMs - now) / 60000)),
            }) }}
          </span>
          <span v-if="item.unsolicited">{{ t('settings.processCanSpeak') }}</span>
        </div>
        <footer class="settings-process-footer">
          <p v-if="item.cwd" class="settings-process-path">{{ item.cwd }}</p>
          <div class="settings-process-actions">
            <UiButton
              data-context="workspace-form-wrap"
              :disabled="busy"
              @click="actions.openChat(item.chatKey)"
            >
              {{ t('settings.openChat') }}
            </UiButton>
            <UiButton
              variant="ghost"
              data-context="workspace-form-wrap"
              :disabled="busy"
              @click="closeOne(item)"
            >
              {{ t('settings.stopProcess') }}
            </UiButton>
          </div>
        </footer>
      </article>
    </div>
    <UiInlineMessage v-if="message">{{ resolveUiText(message) }}</UiInlineMessage>
    <UiInlineMessage v-if="error" tone="danger">{{ resolveUiText(error) }}</UiInlineMessage>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import {
  UiButton,
  UiInlineMessage,
  confirmDialog,
  t,
  uiLocale,
  messageRef,
  resolveUiText,
  type UiText,
  type MessageRef,
} from '../../../ui.ts';

import SettingsEmpty from '../SettingsEmpty.vue';
import SettingsLoading from '../SettingsLoading.vue';
import SettingsScope from '../SettingsScope.vue';
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
  {
    label: t('settings.processFactPool'),
    value: sessions.value.length,
    running: false,
  },
  {
    label: t('settings.processFactRunning'),
    value: sessions.value.length - freeCount.value,
    running: true,
  },
  {
    label: t('settings.processFactIdle'),
    value: freeCount.value,
    running: false,
  },
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
    if (!await chat.revealChat(key)) {
      return false;
    }

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
function title(item: ProcessView): MessageRef {
  return item.chatTitle
    ? messageRef('settings.namedProcessChat', {
      chatTitle: item.chatTitle,
      task: item.taskId ? messageRef('settings.task', { itemTaskId: item.taskId }) : '',
    })
    : item.taskId ? messageRef('settings.taskChat', { itemTaskId: item.taskId })
      : messageRef('settings.untitledChat');
}

/**
 * Сведения об исполнителе остаются в отдельной строке под названием чата.
 * Неизвестные модель и режим показываются как пришли, без потери данных реестра.
 */
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
.settings-processes {
  container: settings-processes / inline-size;
  display: grid;
  gap: 16px;
  align-content: start;
  min-width: 0;
}
.settings-process-overview {
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--surface-2) 50%, var(--surface));
}
.settings-process-metrics {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin: 0;
  padding: 16px 0;
}
.settings-process-metrics > div {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding: 0 18px;
}
.settings-process-metrics > div + div {
  border-left: 1px solid var(--line);
}
.settings-process-metrics dt {
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 18px;
}
.settings-process-metrics dd {
  margin: 0;
  font-size: 26px;
  font-weight: 600;
  line-height: 32px;
  font-variant-numeric: tabular-nums;
}
.settings-process-metrics [data-running='true'] dd {
  color: var(--accent);
}
.settings-process-policy {
  padding: 10px 18px;
  border-top: 1px solid var(--line);
}
.settings-process-policy > span {
  margin-right: 8px;
  color: var(--ink);
}
.settings-process-toolbar,
.settings-process-heading,
.settings-process-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
  min-width: 0;
}
.settings-process-toolbar {
  flex-wrap: wrap;
}
.settings-process-toolbar h4 {
  font-size: 14px;
  font-weight: 600;
  line-height: 20px;
}
.settings-process-actions {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  gap: 8px;
  max-width: 100%;
}
.settings-process-list {
  min-width: 0;
  margin-top: -8px;
  border-top: 1px solid var(--line);
}
.settings-process-list article {
  display: grid;
  gap: 6px;
  min-width: 0;
  padding: 16px 0;
  border-bottom: 1px solid var(--line);
}
.settings-process-heading {
  align-items: flex-start;
}
.settings-process-status {
  display: flex;
  flex: none;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: var(--ink-mid);
  font-size: 11px;
  font-weight: 500;
  line-height: 18px;
}
.settings-process-status > span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.settings-process-status[data-running='true'] {
  background: color-mix(in srgb, var(--accent) 10%, var(--surface));
  color: var(--accent);
}
.settings-process-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 18px;
}
.settings-process-pid {
  font-variant-numeric: tabular-nums;
}
.settings-process-footer {
  margin-top: 4px;
}
.settings-process-path {
  flex: 1;
  min-width: 0;
  font-family: var(--mono);
}
.settings-processes p,
.settings-processes h4,
.settings-processes h5 {
  margin: 0;
  overflow-wrap: anywhere;
}
.settings-processes h5 {
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  line-height: 20px;
}
.settings-processes p {
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.6;
}
@container settings-processes (max-width: 480px) {
  .settings-process-metrics > div {
    padding: 0 12px;
  }
  .settings-process-policy {
    padding: 10px 12px;
  }
  .settings-process-footer {
    flex-wrap: wrap;
  }
  .settings-process-path {
    flex-basis: 100%;
  }
}
@container settings-processes (max-width: 340px) {
  .settings-process-heading {
    flex-direction: column;
    gap: 6px;
  }
  .settings-process-metrics dt {
    font-size: 11px;
  }
}
</style>
