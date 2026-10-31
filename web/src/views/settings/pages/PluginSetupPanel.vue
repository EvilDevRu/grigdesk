<template>
  <section class="settings-plugin-setup" data-plugin-setup>
    <header class="setup-heading">
      <h4>{{ t('settings.pluginSetupHeading') }}</h4>
      <UiButton :disabled="loading || Boolean(busy)" @click="load">
        {{ t('settings.recheckReadiness') }}
      </UiButton>
    </header>
    <UiInlineMessage v-if="error" tone="danger">{{ error }}</UiInlineMessage>
    <UiLoadingState v-if="loading && !status" :label="t('settings.checkingWhatIsOnTheMachine')"
                    :failed="Boolean(error)">
      <UiSkeletonLayout layout="list" :header="false" />
    </UiLoadingState>
    <section v-for="group in groups" :key="group.id" class="setup-group" :data-setup-group="group.id">
      <header v-if="group.heading" class="setup-group-heading">
        <h5>{{ group.heading }}</h5>
        <p>{{ group.hint }}</p>
      </header>
      <UiDisclosureButton
        v-if="group.collapsible"
        v-model:open="voicesOpen"
        :controls="voicesPanelId"
      >
        {{ t('settings.showcaseSetupVoiceOptions') }}
      </UiDisclosureButton>
      <div
        v-show="!group.collapsible || voicesOpen"
        :id="group.collapsible ? voicesPanelId : undefined"
        class="setup-items"
      >
        <div v-for="item in group.items" :key="item.id" class="setup-item" :data-setup-item="item.id">
          <div class="setup-item-heading">
            <b>{{ item.title }}</b>
            <span class="setup-status" :data-status="item.status">
              <template v-if="item.job?.state === 'running'">
                {{ t('settings.pluginSetupInstalling') }}
              </template>
              <template v-else-if="item.status === 'ready'">
                {{ t('settings.pluginSetupReady') }}
              </template>
              <template v-else-if="item.status === 'blocked'">
                {{ t('settings.pluginSetupBlocked') }}
              </template>
              <template v-else-if="item.status === 'warning'">
                {{ t('settings.pluginSetupWarning') }}
              </template>
              <template v-else>{{ t('settings.pluginSetupUnknown') }}</template>
            </span>
          </div>
          <p class="setup-item-reason">{{ item.reason }}</p>
          <p v-if="item.job && item.job.state !== 'succeeded'" role="status">
            {{ item.job.label }} {{ item.job.error }}
          </p>
          <p v-if="item.action && item.job?.state !== 'running'" class="setup-item-hint">
            {{ item.action.hint }}
          </p>
          <UiButton
            v-if="item.job?.state === 'running'"
            :disabled="Boolean(busy)"
            @click="operate(item, true)"
          >
            {{ t('settings.cancel2') }}
          </UiButton>
          <UiButton
            v-else-if="item.action"
            :disabled="Boolean(busy)"
            @click="operate(item, false)"
          >
            {{ item.action.label }}
          </UiButton>
        </div>
      </div>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, useId, watch, onBeforeUnmount } from 'vue';

import {
  t,
  UiButton,
  UiDisclosureButton,
  UiInlineMessage,
  UiLoadingState,
  UiSkeletonLayout,
} from '../../../ui.ts';
import { usePluginsStore } from '../../../stores/plugins.ts';
import { failureText } from '../../../shared/apiClient.ts';
import type {
  PluginListItem, PluginSetupStatus, PluginSetupItem,
} from '../../../../../shared/plugins/pluginsContracts.ts';

const props = defineProps<{ plugin: PluginListItem; active: boolean }>();
const plugins = usePluginsStore();
const status = ref<PluginSetupStatus | null>(null);
const error = ref('');
const busy = ref('');
const loading = ref(false);
const voicesOpen = ref(false);
const voicesPanelId = useId();
const groups = computed(() => {
  const items = status.value?.items ?? [];

  if (!props.plugin.system || props.plugin.id !== 'showcase') {
    return [{
      id: 'requirements',
      heading: '',
      hint: '',
      collapsible: false,
      items,
    }];
  }

  const voiceItems = items.filter(isVoice);

  return [{
    id: 'recording',
    heading: t('settings.showcaseSetupRecordingHeading'),
    hint: t('settings.showcaseSetupRecordingHint'),
    collapsible: false,
    items: items.filter((item) => !isVoice(item)),
  }, {
    id: 'voices',
    heading: t('settings.showcaseSetupVoicesHeading'),
    hint: t('settings.showcaseSetupVoicesHint'),
    collapsible: true,
    items: voiceItems,
  }].filter((group) => group.items.length > 0);
});

let epoch = 0;
let disposed = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let controller: AbortController | null = null;

function isVoice(item: PluginSetupItem): boolean {
  return item.id.startsWith('voice:') || item.id === 'edge' || item.id === 'yandex';
}

function active(): boolean {
  return !disposed && props.active && props.plugin.enabled && Boolean(props.plugin.setup);
}

/**
 * Снятие UI-наблюдения не вызывает отмену server-owned задания.
 * Epoch запрещает старому чтению обновить новое посещение страницы.
 */
function stop(): void {
  epoch += 1;
  controller?.abort();
  controller = null;

  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

function poll(): void {
  if (active() && status.value?.items.some((item) => item.job?.state === 'running')) {
    timer = setTimeout(() => {
      timer = null;
      void load();
    }, 2500);
  }
}

/**
 * Чтение принадлежит посещению страницы; уход отменяет только запрос и UI-таймер.
 * Серверная подготовка продолжает работу и перечитывается при возвращении.
 */
async function load(): Promise<void> {
  if (!active() || loading.value || busy.value) {
    return;
  }

  const version = epoch;
  const id = props.plugin.id;

  loading.value = true;
  controller = new AbortController();

  try {
    const result = await plugins.loadSetup(props.plugin, controller.signal) as PluginSetupStatus;

    if (active() && version === epoch && props.plugin.id === id) {
      status.value = result;
      error.value = '';
    }
  } catch (cause) {
    if (active() && version === epoch) {
      error.value = failureText(cause);
    }
  } finally {
    if (version === epoch) {
      loading.value = false;
      poll();
    }
  }
}

/**
 * Запуск и отмена — немедленные операции по действующему enabled, без общего Apply.
 * Epoch не позволяет старому GET вернуть running после ответа отмены.
 */
async function operate(item: PluginSetupItem, cancel: boolean): Promise<void> {
  if (!active() || busy.value) {
    return;
  }

  stop();

  const version = epoch;

  busy.value = item.id;

  try {
    const result = await (cancel ? plugins.cancelSetup(props.plugin, item.id)
      : plugins.runSetup(props.plugin, item.id)) as PluginSetupStatus;

    if (active() && version === epoch) {
      status.value = result;
      error.value = '';
    }
  } catch (cause) {
    if (active() && version === epoch) {
      error.value = failureText(cause);
    }
  } finally {
    if (version === epoch) {
      busy.value = '';
      loading.value = false;
      poll();
    }
  }
}

watch([() => props.active, () => props.plugin.id, () => props.plugin.enabled], () => {
  stop();
  loading.value = false;
  busy.value = '';
  status.value = null;
  void load();
}, { immediate: true });
onBeforeUnmount(() => {
  disposed = true;
  stop();
});
</script>

<style scoped>
.settings-plugin-setup {
  display: grid;
  gap: 16px;
  min-width: 0;
  padding-block: 20px;
}
.settings-plugin-setup h4,
.settings-plugin-setup h5,
.settings-plugin-setup p {
  margin: 0;
  overflow-wrap: anywhere;
}
.setup-heading,
.setup-item-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px 12px;
}
.setup-heading h4 {
  font-size: 14px;
  font-weight: 600;
}
.setup-group,
.setup-group-heading,
.setup-items,
.setup-item {
  display: grid;
  min-width: 0;
}
.setup-group {
  gap: 10px;
}
.setup-group-heading {
  gap: 4px;
}
.setup-group-heading h5 {
  font-size: 13px;
  font-weight: 600;
}
.setup-item {
  gap: 6px;
  padding-block: 12px;
  border-bottom: 1px solid var(--line);
  font-size: 12px;
  line-height: 1.6;
}
.setup-item:first-child {
  border-top: 1px solid var(--line);
}
.setup-item > .ui-button,
.setup-group > .ui-disclosure-button {
  justify-self: start;
  max-width: 100%;
}
.setup-group-heading p,
.setup-item-hint {
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.6;
}
.setup-status {
  color: var(--ink-mid);
  font-size: 12px;
}
.setup-status[data-status='ready'] {
  color: var(--good);
}
.setup-status[data-status='blocked'],
.setup-status[data-status='warning'] {
  color: var(--warn);
}
</style>
