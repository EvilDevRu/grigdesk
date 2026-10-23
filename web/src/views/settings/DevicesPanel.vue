<template>
  <section class="devices-panel" aria-labelledby="devices-heading">
    <header class="devices-heading">
      <h3 id="devices-heading">{{ t('settings.devices') }}</h3>
      <UiButton data-context="workspace-form-wrap" :disabled="loading" @click="adding = true">{{ t('settings.addDevice') }}</UiButton>
    </header>
    <UiInlineMessage v-if="error" tone="danger">{{ error }}</UiInlineMessage>
    <UiInlineMessage v-if="status && status.listener.state !== 'online'" tone="warning">
      {{ status.listener.error || t('settings.networkAccessIsDisabledSetGRIGDESKCLIENT') }}
    </UiInlineMessage>
    <p v-else-if="status">{{ t('settings.connectionAddresses') }} {{ status.listener.addresses.join(', ') }}</p>
    <p v-if="loading" role="status">{{ t('settings.loadingDevices') }}</p>
    <SettingsEmpty
      v-else-if="status && !status.devices.length"
      class="devices-empty"
      :heading="t('settings.noDevicesAddedYet')"
      :text="t('settings.addADeviceAndUseTheCode')"
    />
    <article v-for="device in status?.devices ?? []" :key="device.id" class="device-row">
      <div>
        <strong>{{ device.name }}{{ device.id === status?.currentDeviceId ? t('settings.thisDevice') : "" }}</strong>
        <p>{{ device.scope === 'client' ? t('settings.application') : t('settings.legacyApplication') }}</p>
        <p>{{ t('settings.lastLogin') }} {{ new Date(device.lastSeenAt).toLocaleString(intlLocale(uiLocale)) }}</p>
      </div>
      <span v-if="device.revokedAt">{{ t('settings.revoked') }}</span>
      <UiButton data-context="workspace-form-wrap" v-else tone="danger" variant="text" @click="revoke(device)">{{ t('settings.revoke') }}</UiButton>
    </article>
    <PairDeviceDialog v-model:open="adding" :draft="draft" />
  </section>
</template>

<script setup lang="ts">
import { intlLocale } from '../../../../shared/i18n/formats.ts';
import { uiLocale } from '../../ui.ts';
import { t } from '../../ui.ts';

import { onBeforeUnmount, onMounted, ref } from 'vue';

import { errorMessage } from '../../../../shared/lib/errors.ts';
import { UiButton, UiInlineMessage, confirmDialog, messageRef } from '../../ui.ts';
import { api } from '../../shared/apiClient.ts';
import PairDeviceDialog from './PairDeviceDialog.vue';
import SettingsEmpty from './SettingsEmpty.vue';

interface DeviceRow {
  id: string;
  name: string;
  scope: string;
  lastSeenAt: number;
  revokedAt: number | null;
}

interface DevicesStatus {
  currentDeviceId?: string | null;
  listener: {
    state: string;
    addresses: string[];
    error?: string | null;
  };
  devices: DeviceRow[];
}

defineProps<{ draft?: { name: string; address: string } }>();

const status = ref<DevicesStatus | null>(null);
const loading = ref(false);
const error = ref('');
const adding = ref(false);
const controller = new AbortController();

/**
 * Публичный список не содержит пинов или ключей, ответ после unmount не используется.
 * Состояние сети загружается независимо от старого мобильного раздела настроек.
 */
async function load(): Promise<void> {
  loading.value = true;

  try {
    const value = await api.get('/api/devices', { signal: controller.signal }) as DevicesStatus;

    if (!value?.listener || !Array.isArray(value.devices)) {
      throw new Error(t('settings.couldNotLoadDevices'));
    }

    if (!controller.signal.aborted) {
      status.value = value;
      error.value = '';
    }
  } catch (cause) {
    if (!controller.signal.aborted) {
      error.value = errorMessage(cause, t('settings.couldNotLoadDevices'));
    }
  } finally {
    loading.value = false;
  }
}

/**
 * Отзыв сертификата немедленно обрывает его соединения и требует решения человека.
 * Обновляем список после durable ответа, а отмена не отправляет мутацию.
 */
async function revoke(device: DeviceRow): Promise<void> {
  const params = { deviceName: device.name };
  const text = device.id === status.value?.currentDeviceId
    ? messageRef('settings.revokeCurrentDevice', params)
    : messageRef('settings.revokeDevice', params);

  if (!await confirmDialog(text, { danger: true })) {
    return;
  }

  try {
    await api.post(`/api/devices/${encodeURIComponent(device.id)}/revoke`);
    await load();
  } catch (cause) {
    error.value = errorMessage(cause, t('settings.couldNotRevokeTheDevice'));
  }
}

onMounted(load);
onBeforeUnmount(() => controller.abort());
</script>

<style scoped>
.devices-panel {
  display: grid;
  gap: 12px;
  width: 100%;
  min-width: 0;
  container: settings-devices / inline-size;
}
.devices-heading, .device-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
.devices-heading {
  flex-wrap: wrap;
}
.devices-heading h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.devices-panel p {
  margin: 0;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.device-row {
  padding-top: 12px;
  border-top: 1px solid var(--line);
}
.device-row > div {
  display: grid;
  gap: 6px;
  min-width: 0;
}
@container settings-devices (max-width: 480px) {
  .device-row {
    flex-wrap: wrap;
  }
}
</style>
