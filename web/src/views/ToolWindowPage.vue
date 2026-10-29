<template>
  <main class="tool-window-page">
    <header class="tool-window-titlebar">
      <span>{{ item?.label || 'GrigDesk' }}</span>
      <div class="tool-window-actions">
        <UiButton v-if="panelReady" :disabled="returning" @click="returnToColumn">
          {{ t('core.returnTool') }}
        </UiButton>
        <UiButton @click="closeWindow">{{ t('core.closeTool') }}</UiButton>
      </div>
    </header>
    <p v-if="error" role="alert">{{ error }}</p>
    <component :is="item.component" v-if="initialized && !returning && item?.component"
               ref="panel" v-bind="item.panelProps || {}" :active="true" :compact="false"
               presentation="page" :intents="intents"
               @consume-intent="consume" @context="receiver?.context($event)" />
    <component :is="panelLoading(id)" v-else-if="!error" :label="t('core.toolWaiting')" />
  </main>
</template>

<script setup lang="ts">
import { panelLoading } from '../shared/tools/panelLoading.ts';

import { toolWindowText } from '../shared/tools/toolWindowMessages.ts';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import {
  UiButton,
  t,
} from '../ui.ts';
import { useAuthStore } from '../stores/auth.ts';
import { usePluginsStore } from '../stores/plugins.ts';
import { toolById } from '../shared/tools/registry.ts';
import { createToolWindowReceiver } from '../shared/tools/toolWindowRelay.ts';
import type { SurfaceDocument } from '../../../shared/desktop/surfaceContract.ts';
import type { ToolPanelHandle, ToolWindowState } from '../shared/tools/toolWindowState.ts';
import { registryToolId } from '../shared/tools/toolWindowState.ts';
import { setCodeWindowAction } from '../shared/tools/toolWindowActions.ts';

const props = defineProps<{ target: SurfaceDocument | null; ready: boolean }>();
const auth = useAuthStore();
const plugins = usePluginsStore();
const id = computed(() => registryToolId(props.target?.id ?? ''));
const item = computed(() => toolById(plugins, id.value));
const initialized = ref(false);
const returning = ref(false);
const panelReady = ref(false);
const error = ref('');
const panel = ref<ToolPanelHandle | null>(null);
const intents = ref<Record<string, unknown>[]>([]);
const pendingCommands = new Map<number, { seq: number; epoch: string }>();
let intentId = 0;
let receiver: ReturnType<typeof createToolWindowReceiver> | null = null;
let saved: ToolWindowState = {};
const readyTimer = setInterval(() => receiver?.ready(), 1000);

/**
 * Состояние импортируется после единственного mount registry-панели.
 * До init документ содержит только шапку, поэтому соединения не дублируются.
 */
async function importState(state: ToolWindowState) {
  await plugins.load?.();

  if (!item.value?.component) {
    error.value = toolWindowText('toolUnavailable');

    throw new Error(error.value);
  }

  saved = state;
  initialized.value = true;
  await nextTick();

  const transfersState = ['code', 'shelf', 'ssh', 'db', 'docker'].includes(id.value);

  for (let attempt = 0; attempt < 200
    && (!panel.value || transfersState && !panel.value.importState); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  if (transfersState && !panel.value?.importState) {
    throw new Error(toolWindowText('toolStateNotReady'));
  }

  await panel.value?.importState?.(state);
  panelReady.value = true;
}

watch(() => props.ready && auth.authenticated, (ready) => {
  if (!ready || receiver || props.target?.kind !== 'tool' || !props.target.instance) {
    return;
  }

  receiver = createToolWindowReceiver({
    origin: location.origin,
    scope: auth.clientScope || '',
    target: { kind: 'tool', id: id.value },
    instance: props.target.instance,
    channel: new BroadcastChannel('grigdesk-tool-windows-v1'),
    importState,
    enqueue: (intent, seq, epoch) => {
      const id = ++intentId;

      pendingCommands.set(id, { seq, epoch });
      intents.value.push({ ...intent, id });
    },
    returned: async (accepted, message) => {
      if (accepted) {
        window.close();
      } else {
        error.value = message || toolWindowText('toolReturnFailed');
        returning.value = false;
        await importState(saved);
      }
    },
  });
  setCodeWindowAction((action) => receiver?.mainAction(action));
}, { immediate: true });

/**
 * Локальный id не повторяется после перезагрузки main и смены его эпохи.
 * Поздний consume старой команды не подтверждает новый такой же seq.
 */
function consume(id: number) {
  const command = pendingCommands.get(id);

  intents.value = intents.value.filter((intent) => intent.id !== id);
  pendingCommands.delete(id);

  if (command) {
    receiver?.consume(command.seq, command.epoch);
  }
}

/**
 * Исходная панель снимается до запроса возврата, сохраняя снимок для отказа.
 * Закрытие документа возможно только после подтверждения нового владельца.
 */
async function returnToColumn() {
  try {
    saved = await panel.value?.exportState?.() ?? { id: id.value };
    returning.value = true;
    await nextTick();
    receiver?.returnState(saved);
  } catch (reason) {
    error.value = String(reason);
  }
}

function closeWindow() {
  window.close();
}

onBeforeUnmount(() => {
  clearInterval(readyTimer);
  receiver?.dispose();
  setCodeWindowAction(null);
});
</script>

<style scoped>
.tool-window-page {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100dvh;
  min-width: 0;
  overflow: hidden;
}
.tool-window-titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex: none;
  padding: 4px 8px;
  -webkit-app-region: drag;
}
.tool-window-actions :deep(button) {
  -webkit-app-region: no-drag;
}
.tool-window-actions {
  display: flex;
  gap: 8px;
  -webkit-app-region: no-drag;
}
.tool-window-page > :deep(.panel) {
  flex: 1;
  min-height: 0;
}
</style>
