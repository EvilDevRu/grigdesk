<template>
  <section class="server-access" data-ui-touch>
    <div class="server-access__intro">
      <div>
        <h3>{{ t('settings.accessConnectDevices') }}</h3>
        <p>{{ t('settings.accessConnectPhoneHint') }}</p>
      </div>
      <PhoneConnectButton labeled />
    </div>
    <SettingsSection :heading="t('settings.accessConnectionMethods')">
      <div v-if="loading" class="server-access__loading" role="status">
        <UiSpinner decorative />
        {{ t('settings.loadingConnections') }}
      </div>
      <UiInlineMessage v-else-if="error" tone="danger">
        {{ error }}
        <UiButton variant="text" @click="load">{{ t('settings.retryLoading') }}</UiButton>
      </UiInlineMessage>
      <template v-else-if="access">
        <SettingsFacts :items="connectionFacts" />
        <UiInlineMessage v-if="access.direct.error" tone="warning">
          {{ access.direct.error }}
        </UiInlineMessage>
      </template>
      <UiDisclosureButton v-model:open="relayOpen" :controls="relayControls">
        {{ t('settings.phoneConfigureRelay') }}
      </UiDisclosureButton>
      <div v-if="relayOpen" :id="relayControls" class="server-access__relays">
        <MobileAccess :key="owner" hide-devices />
        <p>{{ t('settings.automaticLoginUsingThisComputerSLocal') }}</p>
      </div>
    </SettingsSection>
    <RemoteAccessPanel :key="owner" />
    <DevicesPanel :key="`${owner}:${devicesGeneration}`" phone />
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue';

import { UiButton, UiDisclosureButton, UiInlineMessage, UiSpinner, t } from '../../ui.ts';
import { api } from '../../shared/apiClient.ts';
import { useShellStore } from '../../stores/shell.ts';
import { useAuthStore } from '../../stores/auth.ts';
import { useSettingsStore } from '../../stores/settings.ts';
import { phoneRelayReady, usePhoneAccessStore, type PhoneAccessStatus } from '../../stores/phoneAccess.ts';
import PhoneConnectButton from '../../shared/layout/PhoneConnectButton.vue';
import DevicesPanel from './DevicesPanel.vue';
import MobileAccess from './MobileAccess.vue';
import RemoteAccessPanel from './RemoteAccessPanel.vue';
import SettingsFacts from './SettingsFacts.vue';
import SettingsSection from './SettingsSection.vue';

const shell = useShellStore();
const auth = useAuthStore();
const settings = useSettingsStore();
const phone = usePhoneAccessStore();
const owner = computed(() => `${shell.profile?.id ?? 'origin'}:${auth.clientScope}`);
const access = ref<PhoneAccessStatus | null>(null);
const error = ref('');
const loading = ref(false);
const devicesGeneration = ref(0);
const relayOpen = ref(settings.entityId === 'relay');
const relayControls = `access-relays-${useId()}`;
let generation = 0;

const directState = computed(() => {
  if (!access.value) {
    return '';
  }

  if (access.value.direct.state === 'online') {
    return t('settings.phoneDirectEnabled');
  }

  return access.value.direct.state === 'disabled'
    ? t('settings.disabled2') : t('settings.connectionError');
});

const connectionFacts = computed(() => {
  const status = access.value;

  if (!status) {
    return [];
  }

  const facts = [{ label: t('settings.phoneDirect'), value: directState.value }];

  if (status.direct.state === 'online' && status.direct.addresses.length) {
    const addresses = status.direct.addresses.map((address) => typeof address === 'string'
      ? address : `${address.host}:${address.port}`);

    facts.push({ label: t('settings.connectionAddresses'), value: addresses.join(', ') });
  }

  const ready = status.relays.filter(phoneRelayReady).length;
  const relayState = status.relays.length
    ? t('settings.accessRelaysReady', { ready, total: status.relays.length })
    : t('settings.accessRelayNotConfigured');

  facts.push({ label: t('settings.phoneRelay'), value: relayState });

  return facts;
});

/**
 * Страница читает способы связи без выпуска QR и не переносит снимок между серверами.
 * Список устройств перемонтируется по той же личности, включая открытые операции.
 */
async function load(): Promise<void> {
  const epoch = ++generation;

  access.value = null;
  error.value = '';
  loading.value = true;

  try {
    const result = await api.get('/api/devices/access') as PhoneAccessStatus;

    if (generation === epoch) {
      access.value = result;
    }
  } catch {
    if (generation === epoch) {
      error.value = t('settings.phoneStatusUnavailable');
    }
  } finally {
    if (generation === epoch) {
      loading.value = false;
    }
  }
}

watch(owner, load, { immediate: true });
watch(() => phone.open, (open, wasOpen) => {
  if (wasOpen && !open) {
    devicesGeneration.value += 1;
    void load();
  }
});
// Синхронный watch видит и сброс entity в selectPage: повторный переход к relay раскрывает список.
watch(() => settings.entityId, (entity) => relayOpen.value = entity === 'relay', { flush: 'sync' });
onBeforeUnmount(() => generation += 1);
</script>

<style scoped>
.server-access {
  display: grid;
  gap: 24px;
  min-width: 0;
  overflow-wrap: anywhere;
  container: server-access / inline-size;
}
.server-access p,
.server-access h3 {
  margin: 0;
}
.server-access h3 {
  font-size: 14px;
  font-weight: 600;
  line-height: 1.5;
}
.server-access p {
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.6;
}
.server-access__intro {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 20px;
}
.server-access__intro > div {
  display: grid;
  gap: 6px;
  min-width: 0;
  max-width: 52ch;
}
.server-access__intro > :deep(.ui-button) {
  flex: none;
  max-width: 100%;
}
.server-access__loading {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--ink-mid);
  font-size: 12px;
}
.server-access__relays {
  display: grid;
  gap: 12px;
  min-width: 0;
}
@container server-access (max-width: 480px) {
  .server-access__intro {
    align-items: flex-start;
    flex-direction: column;
    gap: 12px;
  }
}
</style>
