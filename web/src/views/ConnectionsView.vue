<template>
  <main class="connections" data-ui-touch aria-labelledby="connections-title">
    <header class="connections-heading">
      <h1 id="connections-title">Машины</h1>
      <UiButton @click="adding = true">Добавить машину</UiButton>
      <UiButton v-if="shell.localAvailable" @click="run(() => shell.addLocal())">Этот компьютер</UiButton>
      <UiButton v-if="shell.everOnline" variant="text" @click="shell.showConnections = false">
        Вернуться к работе
      </UiButton>
    </header>
    <UiInlineMessage v-if="error" tone="danger">{{ error }}</UiInlineMessage>
    <p role="status">{{ CONNECTION_TEXT[shell.status] }} {{ connectionDetailText(shell.detail) }}</p>
    <section v-if="shell.status === 'incompatible'" class="connection-versions">
      <p>{{ versionHint }}</p>
      <p>Приложение: {{ shell.appApi.major }}.{{ shell.appApi.minor }}</p>
      <p v-if="shell.serverApi">Сервер: {{ shell.serverApi.major }}.{{ shell.serverApi.minor }}</p>
      <UiActionLink v-if="RELEASES_URL" :href="RELEASES_URL" target="_blank">Скачать с GitHub</UiActionLink>
    </section>
    <p v-if="!shell.profiles.length">Добавьте машину строкой привязки или QR-кодом.</p>
    <article v-for="profile in shell.profiles" :key="profile.id" class="machine-row">
      <div class="machine-summary">
        <strong>{{ profile.name }}</strong>
        <span>{{ profile.address }}</span>
        <span>{{ CONNECTION_TEXT[profile.status] }}</span>
      </div>
      <div class="machine-actions">
        <UiButton :disabled="busy" @click="run(() => shell.selectProfile(profile.id))">Выбрать</UiButton>
        <UiButton :disabled="busy" @click="connect(profile.id)">Подключиться</UiButton>
        <UiButton v-if="shell.profile?.id === profile.id" @click="run(() => shell.disconnect())">
          Отключиться
        </UiButton>
        <UiButton v-if="profile.kind === 'remote'" @click="changeAddress(profile)">Изменить адрес</UiButton>
        <UiButton tone="danger" variant="text" @click="remove(profile)">Удалить</UiButton>
      </div>
    </article>
    <AddMachineDialog v-model:open="adding" />
  </main>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

import {
  CONNECTION_TEXT, RELEASES_URL, connectionDetailText,
} from '../../../shared/client/clientShell.ts';
import type { MachineProfile } from '../../../shared/client/clientShell.ts';
import { UiButton, UiInlineMessage, UiActionLink, confirmDialog, promptDialog } from '../ui.ts';
import { useShellStore } from '../stores/shell.ts';
import { failureText } from '../shared/apiClient.ts';
import AddMachineDialog from '../shared/layout/AddMachineDialog.vue';

const shell = useShellStore();
const adding = ref(false);
const busy = ref(false);
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
  max-width: 980px;
  margin: 48px auto;
  padding: 24px;
}
.connections-heading, .machine-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}
.machine-row {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 16px;
  padding: 20px 0;
  border-bottom: 1px solid var(--line);
}
.machine-summary {
  display: grid;
  gap: 6px;
  overflow-wrap: anywhere;
}
</style>
