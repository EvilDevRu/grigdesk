<template>
  <section class="settings-plugin-setup" data-plugin-setup>
    <h4>{{ t('settings.readiness') }}</h4>
    <p v-if="error" role="alert">{{ error }}</p>
    <UiLoadingState v-if="loading && !status" :label="t('settings.checkingWhatIsOnTheMachine')"
                    :failed="Boolean(error)">
      <UiSkeletonLayout layout="list" :header="false" />
    </UiLoadingState>
    <div v-for="item in status?.items ?? []" :key="item.id">
      <b>{{ item.title }}</b>
      <p>{{ item.reason }}</p>
      <p v-if="item.job">{{ item.job.label }} {{ item.job.error }}</p>
      <p v-else-if="item.action">{{ item.action.hint }}</p>
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
    <UiButton :disabled="loading || Boolean(busy)" @click="load">{{ t('settings.recheckReadiness') }}</UiButton>
  </section>
</template>

<script setup lang="ts">
import { UiSkeletonLayout } from '../../../ui';

import { t } from '../../../ui.ts';

import { ref, watch, onBeforeUnmount } from 'vue';
import {
  UiButton,
  UiLoadingState,
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
let epoch = 0;
let disposed = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let controller: AbortController | null = null;

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
.settings-plugin-setup { display: grid; gap: 12px; min-width: 0; }
</style>
