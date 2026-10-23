<template>
  <section data-ui-touch class="devices-panel" aria-labelledby="devices-heading">
    <header class="devices-heading">
      <h3 id="devices-heading">{{ t('settings.devices') }}</h3>
      <UiButton :disabled="loading" @click="adding = true">{{ t('settings.addDevice') }}</UiButton>
    </header>
    <p>{{ t('settings.phoneAddComputerHint') }}</p>
    <UiInlineMessage v-if="error" tone="danger">{{ error }}</UiInlineMessage>
    <UiInlineMessage v-if="status && status.listener.state !== 'online'" tone="warning">
      {{ status.listener.error || t('settings.networkAccessIsDisabledSetGRIGDESKCLIENT') }}
    </UiInlineMessage>
    <p v-else-if="status">{{ t('settings.connectionAddresses') }} {{ status.listener.addresses.join(', ') }}</p>
    <p v-if="loading" role="status">{{ t('settings.loadingDevices') }}</p>
    <div v-else-if="status && !status.devices.length" class="devices-empty">
      <SettingsIcon name="connections" />
      <strong>{{ t('settings.noDevicesAddedYet') }}</strong>
      <p>{{ t('settings.addADeviceAndUseTheCode') }}</p>
    </div>
    <article v-for="device in status?.devices ?? []" :key="device.id" class="device-row">
      <div>
        <strong>{{ device.name }}{{ device.id === status?.currentDeviceId ? t('settings.thisDevice') : "" }}</strong>
        <p>{{ device.scope === 'client' ? t('settings.application') : t('settings.legacyApplication') }}</p>
        <p>{{ t('settings.lastLogin') }} {{ new Date(device.lastSeenAt).toLocaleString(intlLocale(uiLocale)) }}</p>
      </div>
      <UiButton v-if="!device.revokedAt" variant="text" @click="edit(device)">
        {{ t('settings.phoneRename') }}
      </UiButton>
      <span v-if="device.revokedAt">{{ t('settings.revoked') }}</span>
      <UiButton v-else tone="danger" variant="text" @click="revoke(device)">{{ t('settings.revoke') }}</UiButton>
    </article>
    <PairDeviceDialog v-model:open="adding" :draft="draft" />
    <UiDialog :open="!!editing" :title="t('settings.phoneRename')" @update:open="editing = null">
      <UiField :label="t('settings.deviceName')"><UiInput v-model="newName" /></UiField>
      <template #footer>
        <UiButton :disabled="!newName.trim() || mutating" @click="rename">{{ t('settings.phoneSave') }}</UiButton>
        <UiButton variant="text" @click="editing = null">{{ t('settings.cancel') }}</UiButton>
      </template>
    </UiDialog>
    <UiDialog :open="!!revoking" :title="t('settings.revoke')" @update:open="revoking = null">
      <p>{{ revoking?.id === status?.currentDeviceId ? t('settings.revokeCurrentDevice', {
        deviceName: revoking?.name ?? '' }) : t('settings.revokeDevice', { deviceName: revoking?.name ?? '' }) }}</p>
      <template #footer>
        <UiButton tone="danger" :disabled="mutating" @click="confirmRevoke">{{ t('settings.revoke') }}</UiButton>
        <UiButton variant="text" @click="revoking = null">{{ t('settings.cancel') }}</UiButton>
      </template>
    </UiDialog>
  </section>
</template>

<script setup lang="ts">
import { intlLocale } from '../../../../shared/i18n/formats.ts';
import { uiLocale } from '../../ui.ts';
import { t } from '../../ui.ts';

import { onBeforeUnmount, onMounted, ref } from 'vue';

import { errorMessage } from '../../../../shared/lib/errors.ts';
import { UiButton, UiInlineMessage, UiDialog, UiField, UiInput,
  confirmDialog, messageRef } from '../../ui.ts';
import { api } from '../../shared/apiClient.ts';
import PairDeviceDialog from './PairDeviceDialog.vue';
import SettingsIcon from './SettingsIcon.vue';

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

const props = defineProps<{ draft?: { name: string; address: string }; phone?: boolean }>();

const status = ref<DevicesStatus | null>(null);
const loading = ref(false);
const error = ref('');
const adding = ref(false);
const controller = new AbortController();
const editing = ref<DeviceRow | null>(null);
const revoking = ref<DeviceRow | null>(null);
const newName = ref('');
const mutating = ref(false);

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
    if (!controller.signal.aborted) {
      loading.value = false;
    }
  }
}

/**
 * Отзыв сертификата немедленно обрывает его соединения и требует решения человека.
 * Обновляем список после durable ответа, а отмена не отправляет мутацию.
 */
async function revoke(device: DeviceRow): Promise<void> {
  if (props.phone) {
    revoking.value = device;

    return;
  }

  const params = { deviceName: device.name };
  const text = device.id === status.value?.currentDeviceId
    ? messageRef('settings.revokeCurrentDevice', params)
    : messageRef('settings.revokeDevice', params);

  if (!await confirmDialog(text, { danger: true }) || controller.signal.aborted) {
    return;
  }

  try {
    await api.post(`/api/devices/${encodeURIComponent(device.id)}/revoke`);

    if (!controller.signal.aborted) {
      await load();
    }
  } catch (cause) {
    if (!controller.signal.aborted) {
      error.value = errorMessage(cause, t('settings.couldNotRevokeTheDevice'));
    }
  }
}

function edit(device: DeviceRow): void {
  editing.value = device;
  newName.value = device.name;
}

/**
 * Мутация остаётся у владельца списка до ответа и отбрасывается после unmount.
 * При смене сервера старое finally не открывает диалог и не перезагружает новый список.
 */
async function rename(): Promise<void> {
  const device = editing.value;

  if (!device || mutating.value) {
    return;
  }

  mutating.value = true;

  try {
    await api.patch(`/api/devices/${encodeURIComponent(device.id)}`, { name: newName.value });

    if (!controller.signal.aborted) {
      editing.value = null;
      await load();
    }
  } catch {
    if (!controller.signal.aborted) {
      error.value = t('settings.phoneRenameFailed');
    }
  } finally {
    if (!controller.signal.aborted) {
      mutating.value = false;
    }
  }
}

/**
 * Подтверждение отзыва относится к показанному устройству выбранного сервера.
 * Уничтоженный список не применяет поздний ответ и не запускает повторную мутацию.
 */
async function confirmRevoke(): Promise<void> {
  const device = revoking.value;

  if (!device || mutating.value) {
    return;
  }

  mutating.value = true;

  try {
    await api.post(`/api/devices/${encodeURIComponent(device.id)}/revoke`);

    if (!controller.signal.aborted) {
      revoking.value = null;
      await load();
    }
  } catch {
    if (!controller.signal.aborted) {
      error.value = t('settings.couldNotRevokeTheDevice');
    }
  } finally {
    if (!controller.signal.aborted) {
      mutating.value = false;
    }
  }
}

onMounted(load);
onBeforeUnmount(() => controller.abort());
</script>

<style scoped>
.devices-panel {
  display: grid;
  gap: 16px;
  width: 100%;
  min-width: 0;
}
.devices-heading, .device-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
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
  padding-top: 16px;
  border-top: 1px solid var(--line);
}
.device-row > div {
  display: grid;
  gap: 6px;
  min-width: 0;
}
.devices-empty {
  display: grid;
  justify-items: center;
  gap: 10px;
  padding: 28px 16px;
  border: 1px dashed var(--line-2);
  border-radius: var(--control-radius);
  text-align: center;
}
.devices-empty svg {
  color: var(--accent);
}
.devices-empty strong {
  font-size: 13px;
}
@media (max-width: 600px) {
  .device-row {
    flex-wrap: wrap;
  }
}
</style>
