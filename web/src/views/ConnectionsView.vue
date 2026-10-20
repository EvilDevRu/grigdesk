<template>
  <main class="connections" aria-labelledby="connections-title">
    <UiButton class="connections-back" variant="text"
              @click="shell.showConnections = false">
      <template #leading>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
             aria-hidden="true"><path d="M19 12H5 m5-5-5 5 5 5" /></svg>
      </template>
      Вернуться к работе
    </UiButton>
    <header class="connections-heading">
      <div>
        <h1 id="connections-title">Машины</h1>
        <p>Выберите компьютер, с которым хотите работать.</p>
      </div>
      <UiButton variant="solid" tone="accent" :disabled="busy" @click="adding = true">
        <template #leading>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
               aria-hidden="true"><path d="M12 5v14 M5 12h14" /></svg>
        </template>
        Добавить машину
      </UiButton>
    </header>
    <UiInlineMessage v-if="error" tone="danger">{{ error }}</UiInlineMessage>
    <div class="connections-state" role="status">
      <ConnectionStatus :status="shell.status" :disconnected="disconnected"
                        :text="disconnected ? 'Отключено' : undefined" />
      <span v-if="shell.profile">{{ shell.profile.name }}</span>
      <span v-if="detailText">{{ detailText }}</span>
    </div>
    <section v-if="shell.status === 'incompatible'" class="connection-versions">
      <p>{{ versionHint }}</p>
      <p>Приложение: {{ shell.appApi.major }}.{{ shell.appApi.minor }}</p>
      <p v-if="shell.serverApi">Сервер: {{ shell.serverApi.major }}.{{ shell.serverApi.minor }}</p>
      <UiActionLink v-if="RELEASES_URL" :href="RELEASES_URL" target="_blank">Скачать с GitHub</UiActionLink>
    </section>
    <div v-if="!shell.profiles.length" class="connections-empty">
      <strong>Здесь будут ваши компьютеры</strong>
      <p>Добавьте машину строкой привязки или QR-кодом.</p>
    </div>
    <div class="machines-list">
      <article v-for="profile in shell.profiles" :key="profile.id" class="machine-row"
               :data-current="profile.id === shell.profile?.id">
        <div class="machine-summary">
          <span class="machine-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path v-if="profile.kind === 'local'" d="M3 4h18v12H3z M8 20h8 M12 16v4" />
              <path v-else d="M5 3h14v18H5z M5 12h14 M8 7h2 M8 16h2" />
            </svg>
          </span>
          <div class="machine-copy">
            <div class="machine-title">
              <strong>{{ profile.name }}</strong>
              <span v-if="profile.id === shell.profile?.id" class="machine-current">Текущая</span>
            </div>
            <span class="machine-address">
              {{ profile.kind === 'local' ? 'Локальная машина' : profile.address }}
            </span>
            <ConnectionStatus :status="profile.id === shell.profile?.id ? shell.status : profile.status"
                              :disconnected="profile.id === shell.profile?.id && disconnected"
                              :text="profile.id === shell.profile?.id && disconnected ? 'Отключено' : undefined" />
          </div>
        </div>
        <div class="machine-actions">
          <UiButton v-if="profile.id !== shell.profile?.id" :disabled="busy"
                    @click="run(() => shell.selectProfile(profile.id))">Выбрать</UiButton>
          <UiButton v-else-if="disconnected || shell.status !== 'online'" tone="accent"
                    :disabled="busy" @click="connect(profile.id)">Подключиться</UiButton>
          <UiButton v-else :disabled="busy" @click="run(() => shell.disconnect())">Отключиться</UiButton>
          <UiButton v-if="profile.kind === 'remote'" :disabled="busy" variant="text"
                    @click="changeAddress(profile)">Изменить адрес</UiButton>
          <UiButton tone="danger" variant="text" :disabled="busy" @click="remove(profile)">Удалить</UiButton>
        </div>
      </article>
    </div>
    <div v-if="shell.localAvailable && !shell.profiles.some(profile => profile.kind === 'local')"
         class="connections-local">
      <span>GrigDesk запущен на этом устройстве</span>
      <UiButton :disabled="busy" @click="run(() => shell.addLocal())">Этот компьютер</UiButton>
    </div>
    <AddMachineDialog v-model:open="adding" />
  </main>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

import {
  RELEASES_URL, connectionDetailText,
} from '../../../shared/client/clientShell.ts';
import type { MachineProfile } from '../../../shared/client/clientShell.ts';
import { UiButton, UiInlineMessage, UiActionLink, confirmDialog, promptDialog } from '../ui.ts';
import { useShellStore } from '../stores/shell.ts';
import { failureText } from '../shared/apiClient.ts';
import AddMachineDialog from '../shared/layout/AddMachineDialog.vue';
import ConnectionStatus from '../shared/layout/ConnectionStatus.vue';

const shell = useShellStore();
const adding = ref(false);
const busy = ref(false);
const disconnected = computed(() => typeof shell.detail !== 'string'
  && shell.detail?.code === 'disconnected');
const detailText = computed(() => disconnected.value ? '' : connectionDetailText(shell.detail));
const versionHint = computed(() => {
  const upgradeServer = typeof shell.detail !== 'string'
    && shell.detail?.code === 'server_upgrade_required';
  const version = upgradeServer ? shell.appApi : shell.serverApi || shell.appApi;

  return `Нужна версия ${upgradeServer ? 'сервера' : 'приложения'} не ниже `
    + `${version.major}.${version.minor}.`;
});
const error = ref('');

/**
 * Экран подключения остаётся доступным при любом отказе удалённой машины.
 * Ошибка действия показывается рядом со списком, не закрывая его и не перезагружая документ.
 */
async function run(work: () => Promise<unknown>): Promise<void> {
  busy.value = true;
  error.value = '';

  try {
    await work();
  } catch (failure) {
    error.value = failureText(failure, 'Не удалось изменить подключение.');
  } finally {
    busy.value = false;
  }
}

async function connect(id: string): Promise<void> {
  await run(async () => {
    await shell.selectProfile(id);
    await shell.connect();
  });
}

async function remove(profile: MachineProfile): Promise<void> {
  if (await confirmDialog(`Удалить машину «${profile.name}»?`)) {
    await run(() => shell.removeProfile(profile.id));
  }
}

/**
 * Адрес меняется только у уже привязанной машины, её пин хранится в оболочке.
 * Оболочка проверит hello новым адресом до сохранения, а отмена не отправляет запрос.
 */
async function changeAddress(profile: MachineProfile): Promise<void> {
  const address = await promptDialog({ title: 'Изменить адрес', value: profile.address });

  if (address !== null) {
    await run(() => shell.editProfile(profile.id, { address }));
  }
}
</script>

<style scoped>
.connections {
  display: grid;
  align-content: start;
  gap: 24px;
  width: 100%;
  max-width: 960px;
  margin: 48px auto;
  padding: 0 24px;
}

.connections-heading, .machine-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.connections-back {
  justify-self: start;
}

.connections-heading {
  justify-content: space-between;
  gap: 16px;
}

.connections-heading h1 {
  margin: 0;
  font-size: 26px;
  font-weight: 600;
}

.connections-heading p {
  margin: 4px 0 0;
  color: var(--ink-mid);
  font-size: 13px;
}

.connections-state {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--ink-mid);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.machines-list {
  display: grid;
  gap: 12px;
}

.machine-row {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 16px;
  align-items: center;
  padding: 20px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
}

.machine-row[data-current='true'] {
  border-color: color-mix(in srgb, var(--accent) 35%, var(--line));
}

.machine-summary {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
}

.machine-icon {
  display: grid;
  flex: none;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: 10px;
  background: var(--surface-2);
  color: var(--ink-mid);
}

.machine-icon svg {
  width: 24px;
  height: 24px;
}

.machine-copy {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.machine-title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  overflow-wrap: anywhere;
}

.machine-title strong {
  font-weight: 500;
}

.machine-current {
  color: var(--accent);
  font-size: 11px;
}

.machine-address {
  color: var(--ink-mid);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.connections-local {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: var(--ink-mid);
  font-size: 13px;
}

.connections-empty {
  padding: 40px 20px;
  border: 1px dashed var(--line-2);
  border-radius: var(--radius);
  text-align: center;
}

.connections-empty p {
  margin: 8px 0 0;
  color: var(--ink-mid);
  font-size: 13px;
}

@media (max-width: 600px) {
  .connections {
    gap: 20px;
    margin: 24px auto;
    padding: 0 16px;
  }

  .machine-row {
    padding: 16px;
  }

  .machine-actions {
    width: 100%;
    padding-top: 12px;
    border-top: 1px solid var(--line);
  }
}
</style>
