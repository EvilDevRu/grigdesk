<template>
  <template v-if="shell.present">
    <UiTopbarPanel v-model:open="open" title="Машины" trigger-mode="click">
      <template #trigger>
        <UiButton v-tooltip="label" variant="ghost" :aria-label="label" :aria-expanded="open"
                  data-context="connection-trigger">
          <template #leading>
            <span class="connection-symbol">
              <svg class="connection-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   stroke-width="1.7" aria-hidden="true">
                <path :d="icon" />
              </svg>
              <ConnectionStatus class="connection-trigger-dot" :status="shell.status"
                                :disconnected="disconnected" compact aria-hidden="true" />
            </span>
          </template>
          <span class="connection-label">{{ shell.profile?.name ?? 'Машины' }}</span>
          <template #trailing>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
                 aria-hidden="true"><path d="m8 10 4 4 4-4" /></svg>
          </template>
        </UiButton>
      </template>
      <template #meta>{{ shell.profiles.length }}</template>
      <div data-connection-menu class="connection-menu">
        <UiInlineMessage v-if="error" tone="danger">{{ error }}</UiInlineMessage>
        <div class="connection-profiles">
          <UiButton v-for="profile in shell.profiles" :key="profile.id" variant="ghost"
                    data-context="connection-machine" :aria-label="profile.name"
                    :aria-current="profile.id === shell.profile?.id ? 'true' : undefined"
                    @click="select(profile.id)">
            <span class="connection-machine-icon" aria-hidden="true">
              <svg class="connection-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   stroke-width="1.6">
                <path v-if="profile.kind === 'local'" d="M3 4h18v12H3z M8 20h8 M12 16v4" />
                <path v-else d="M5 3h14v18H5z M5 12h14 M8 7h2 M8 16h2" />
              </svg>
            </span>
            <span class="connection-machine-copy">
              <strong>{{ profile.name }}</strong>
              <span class="connection-machine-detail">
                <span>{{ profile.kind === 'local' ? 'Локальная' : 'Удалённая' }}</span>
                <span aria-hidden="true">·</span>
                <ConnectionStatus :status="profile.id === shell.profile?.id ? shell.status : profile.status"
                                  :text="profile.id === shell.profile?.id ? statusText : undefined"
                                  :disconnected="profile.id === shell.profile?.id && disconnected" />
              </span>
            </span>
            <svg v-if="profile.id === shell.profile?.id" class="connection-check" viewBox="0 0 24 24"
                 fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
              <path d="m5 12 4 4L19 6" />
            </svg>
          </UiButton>
          <p v-if="!shell.profiles.length" class="connection-empty">Добавьте первую машину для подключения.</p>
        </div>
        <UiButton variant="ghost" data-context="connection-action" @click="addMachine">
          <template #leading>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
                 aria-hidden="true"><path d="M12 5v14 M5 12h14" /></svg>
          </template>
          Добавить машину
        </UiButton>
      </div>
      <template #footer>
        <UiButton variant="ghost" data-context="connection-action" @click="showAll">
          Все машины
          <template #trailing>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
                 aria-hidden="true"><path d="M5 12h14 m-5-5 5 5-5 5" /></svg>
          </template>
        </UiButton>
        <UiButton v-if="shell.profile" variant="ghost" data-context="connection-action"
                  :tone="disconnected ? 'accent' : 'neutral'"
                  @click="disconnected ? connect() : disconnect()">
          <template #leading>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
                 aria-hidden="true"><path d="M12 3v9 M7 5.5a8 8 0 1 0 10 0" /></svg>
          </template>
          {{ disconnected ? 'Подключиться' : 'Отключиться' }}
        </UiButton>
      </template>
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
import ConnectionStatus from './ConnectionStatus.vue';

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
  display: block;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.connection-menu {
  display: grid;
  gap: 8px;
}

.connection-symbol {
  position: relative;
  display: flex;
}

.connection-trigger-dot {
  position: absolute;
  right: -3px;
  bottom: -2px;
  padding: 2px;
  border-radius: 50%;
  background: var(--topbar);
}

.connection-profiles {
  display: grid;
  gap: 4px;
}

.connection-machine-icon {
  display: grid;
  flex: none;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 7px;
  background: var(--surface-2);
  color: var(--ink-mid);
}

.connection-machine-copy {
  display: grid;
  flex: 1;
  gap: 4px;
  min-width: 0;
}

.connection-machine-copy strong {
  overflow: hidden;
  font-size: 13px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.connection-machine-detail {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  color: var(--ink-mid);
  font-size: 11px;
}

.connection-check {
  flex: none;
  width: 16px;
  height: 16px;
  color: var(--accent);
}

.connection-empty {
  margin: 0;
  color: var(--ink-mid);
}

@media (max-width: 1100px) {
  .connection-label {
    display: none;
  }
}
</style>
