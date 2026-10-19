<template>
  <template v-if="shell.present">
    <UiTopbarPanel v-model:open="open" title="Машины" trigger-mode="click">
      <template #trigger>
        <UiButton v-tooltip="label" variant="ghost" :aria-label="label" :aria-expanded="open"
                  class="connection-trigger">
          <svg class="connection-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="1.7" aria-hidden="true">
            <path :d="icon" />
          </svg>
          <span class="connection-dot" :data-status="shell.status" />
          <span class="connection-label">{{ label }}</span>
        </UiButton>
      </template>
      <div data-connection-menu class="connection-menu">
        <UiInlineMessage v-if="error" tone="danger">{{ error }}</UiInlineMessage>
        <template v-for="(profile, index) in shell.profiles" :key="profile.id">
          <div v-if="index" class="connection-separator" role="separator" />
          <UiButton variant="text"
                    :aria-current="profile.id === shell.profile?.id ? 'true' : undefined"
                    @click="select(profile.id)">
            {{ profile.name }}{{ profile.id === shell.profile?.id ? ' ✓' : '' }}
          </UiButton>
        </template>
        <UiButton variant="text" @click="addMachine">Добавить машину</UiButton>
        <UiButton v-if="!disconnected" variant="text" @click="disconnect">Отключиться</UiButton>
        <UiButton v-else variant="text" @click="connect">Подключиться</UiButton>
        <UiButton variant="text" @click="showAll">Все машины…</UiButton>
      </div>
    </UiTopbarPanel>
    <AddMachineDialog v-model:open="adding" />
  </template>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import { CONNECTION_TEXT } from '../../../../shared/client/clientShell.ts';
import { UiButton, UiInlineMessage, UiTopbarPanel, useUiLayer, vTooltip } from '../../ui.ts';
import { useShellStore } from '../../stores/shell.ts';
import { failureText } from '../apiClient.ts';
import AddMachineDialog from './AddMachineDialog.vue';

withDefaults(defineProps<{ icon?: string }>(), { icon: '' });

const shell = useShellStore();
const open = ref(false);
const adding = ref(false);
const error = ref('');
const now = ref(Date.now());
const disconnected = computed(() => typeof shell.detail !== 'string'
  && shell.detail?.code === 'disconnected');
const retrySeconds = computed(() => typeof shell.detail !== 'string'
  ? Math.max(0, Math.ceil(((shell.detail?.retryAt ?? 0) - now.value) / 1000)) : 0);
let clock: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
  clock = setInterval(() => now.value = Date.now(), 1000);
});
onBeforeUnmount(() => clearInterval(clock));

const statusText = computed(() => {
  if (disconnected.value) {
    return 'отключено';
  }

  if (shell.status === 'incompatible') {
    return typeof shell.detail !== 'string' && shell.detail?.code === 'server_upgrade_required'
      ? 'нужно обновить сервер' : 'нужно обновить приложение';
  }

  const retry = retrySeconds.value > 0 ? ` · повтор через ${retrySeconds.value} с` : '';

  return CONNECTION_TEXT[shell.status] + retry;
});
const label = computed(() => `${shell.profile?.name ?? 'Машины'} · ${statusText.value}`);

useUiLayer('popover', {
  enabled: open,
  onEscape: () => {
    open.value = false;

    return true;
  },
});

function addMachine(): void {
  open.value = false;
  adding.value = true;
}

function showAll(): void {
  open.value = false;
  shell.showConnections = true;
}

/**
 * Выбор машины выполняется оболочкой, которая владеет портом и ключами профиля.
 * Ошибка остаётся в открытом меню и не скрывает доступные действия.
 */
async function select(id: string): Promise<void> {
  try {
    if (id !== shell.profile?.id) {
      await shell.selectProfile(id);
    }

    open.value = false;
  } catch (failure) {
    error.value = failureText(failure, 'Не удалось выбрать машину.');
  }
}

/**
 * Ручное подключение снимает запрет повтора, установленный отключением.
 * Сетевую попытку выполняет оболочка без повторного выбора текущего origin.
 */
async function connect(): Promise<void> {
  try {
    await shell.connect();
    open.value = false;
  } catch (failure) {
    error.value = failureText(failure, 'Не удалось подключиться.');
  }
}

/**
 * Явное отключение запрещает фоновые повторы до следующего действия человека.
 * Состояние обновит long-poll, а меню закрывается только после принятого действия.
 */
async function disconnect(): Promise<void> {
  try {
    await shell.disconnect();
    open.value = false;
  } catch (failure) {
    error.value = failureText(failure, 'Не удалось отключиться.');
  }
}
</script>

<style scoped>
.connection-icon {
  width: 16px;
  height: 16px;
  flex: none;
}
.connection-label {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.connection-menu {
  display: grid;
  gap: 4px;
}
.connection-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ink-mid);
}
.connection-dot[data-status="online"] {
  background: var(--good);
}
.connection-dot[data-status="revoked"], .connection-dot[data-status="identityMismatch"] {
  background: var(--bad);
}
.connection-dot[data-status="offline"], .connection-dot[data-status="connecting"],
.connection-dot[data-status="locked"] {
  background: var(--warn);
}
.connection-dot[data-status="incompatible"] {
  background: var(--bad);
}
.connection-separator {
  height: 1px;
  background: var(--line);
}
@media (max-width: 1100px) {
  .connection-label {
    display: none;
  }
}
</style>
