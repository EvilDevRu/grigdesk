<template>
  <section class="devices-panel" aria-labelledby="devices-heading">
    <header class="devices-heading">
      <div class="devices-heading__title">
        <h3 id="devices-heading">{{ t('settings.devices') }}</h3>
        <span v-if="status" class="devices-count">
          {{ t('settings.accessActiveDevices', { count: activeCount }) }}
        </span>
      </div>
      <UiButton wrap :disabled="loading" aria-haspopup="dialog" @click="adding = true">
        {{ phone ? t('settings.accessConnectComputer') : t('settings.addDevice') }}
      </UiButton>
    </header>
    <p>{{ phone ? t('settings.accessConnectComputerHint') : t('settings.phoneAddComputerHint') }}</p>
    <UiInlineMessage v-if="error" tone="danger">{{ error }}</UiInlineMessage>
    <UiInlineMessage v-if="!phone && status && status.listener.state !== 'online'" tone="warning">
      {{ status.listener.error || t('settings.networkAccessIsDisabledSetGRIGDESKCLIENT') }}
    </UiInlineMessage>
    <p v-else-if="!phone && status">
      {{ t('settings.connectionAddresses') }} {{ status.listener.addresses.join(', ') }}
    </p>
    <UiLoadingState v-if="loading" :label="t('settings.loadingDevices')" :failed="Boolean(error)" >
      <UiSkeletonLayout layout="list" :header="false" />
    </UiLoadingState>
    <SettingsEmpty
      v-else-if="status && !status.devices.length"
      class="devices-empty"
      :heading="t('settings.noDevicesAddedYet')"
      :text="t('settings.addADeviceAndUseTheCode')"
    />
    <article v-for="device in sortedDevices" :key="device.id" class="device-row">
      <div class="device-details">
        <div class="device-name">
          <strong>
            {{ device.name }}{{ device.id === status?.currentDeviceId ? t('settings.thisDevice') : '' }}
          </strong>
          <span v-if="device.revokedAt" class="device-revoked">{{ t('settings.revoked') }}</span>
        </div>
        <div class="device-meta">
          <p>{{ device.scope === 'client' ? t('settings.application') : t('settings.legacyApplication') }}</p>
          <p>
            {{ t('settings.lastLogin') }}
            {{ new Date(device.lastSeenAt).toLocaleString(intlLocale(uiLocale)) }}
          </p>
        </div>
      </div>
      <div v-if="!device.revokedAt" class="device-actions">
        <UiButton variant="text" @click="edit(device)">
          {{ t('settings.phoneRename') }}
        </UiButton>
        <UiButton tone="danger" variant="text" @click="revoke(device)">
          {{ t('settings.revoke') }}
        </UiButton>
      </div>
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

import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import { errorMessage } from '../../../../shared/lib/errors.ts';
import {
  UiButton,
  UiInlineMessage,
  UiDialog,
  UiField,
  UiInput,
  confirmDialog,
  messageRef,
  UiLoadingState,
  UiSkeletonLayout,
  t,
  uiLocale,
} from '../../ui.ts';
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

const activeCount = computed(() => status.value?.devices.filter((device) => !device.revokedAt).length ?? 0);
const sortedDevices = computed(() => [...(status.value?.devices ?? [])].sort((left, right) =>
  Number(Boolean(left.revokedAt)) - Number(Boolean(right.revokedAt))));

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
  gap: 12px;
  width: 100%;
  min-width: 0;
  container: settings-devices / inline-size;
}
.devices-heading,
.device-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
.devices-heading {
  flex-wrap: wrap;
}
.devices-heading__title {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px 12px;
}
.devices-count,
.device-revoked {
  color: var(--ink-dim);
  font-size: 12px;
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
  padding: 12px 0;
  border-top: 1px solid var(--line);
}
.device-details {
  display: grid;
  gap: 6px;
  min-width: 0;
}
.device-name,
.device-meta,
.device-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 12px;
  min-width: 0;
}
.device-name strong {
  font-size: 13px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.device-actions {
  flex: none;
  gap: 4px;
}
@container settings-devices (max-width: 480px) {
  .device-row {
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
  }
  .device-actions {
    max-width: 100%;
  }
}
</style>
