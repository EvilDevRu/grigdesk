<template>
  <section class="server-access" data-ui-touch>
    <h3>{{ t('settings.serverAccess') }}</h3>
    <PhoneConnectButton />
    <p>{{ t('settings.phoneDirect') }}</p>
    <p>{{ access?.direct.error || directState }}</p>
    <p>{{ t('settings.phoneRelay') }}</p>
    <p>{{ t('settings.phoneReachability') }}</p>
    <DevicesPanel :key="`${owner}:${devicesGeneration}`" phone />
    <UiDisclosureButton v-model:open="relayOpen" :controls="relayControls">
      {{ t('settings.phoneConfigureRelay') }}
    </UiDisclosureButton>
    <div v-if="relayOpen" :id="relayControls">
      <MobileAccess :key="owner" hide-devices />
      <p>{{ t('settings.automaticLoginUsingThisComputerSLocal') }}</p>
    </div>
    <UiInlineMessage v-if="error" tone="danger">{{ error }}</UiInlineMessage>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue';

import { UiDisclosureButton, UiInlineMessage, t } from '../../ui.ts';
import { api } from '../../shared/apiClient.ts';
import { useShellStore } from '../../stores/shell.ts';
import { useAuthStore } from '../../stores/auth.ts';
import { useSettingsStore } from '../../stores/settings.ts';
import { usePhoneAccessStore, type PhoneAccessStatus } from '../../stores/phoneAccess.ts';
import PhoneConnectButton from '../../shared/layout/PhoneConnectButton.vue';
import DevicesPanel from './DevicesPanel.vue';
import MobileAccess from './MobileAccess.vue';

const shell = useShellStore();
const auth = useAuthStore();
const settings = useSettingsStore();
const phone = usePhoneAccessStore();
const owner = computed(() => `${shell.profile?.id ?? 'origin'}:${auth.clientScope}`);
const access = ref<PhoneAccessStatus | null>(null);
const error = ref('');
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

/**
 * Страница читает способы связи без выпуска QR и не переносит снимок между серверами.
 * Список устройств перемонтируется по той же личности, включая открытые операции.
 */
async function load(): Promise<void> {
  const epoch = ++generation;

  access.value = null;
  error.value = '';

  try {
    const result = await api.get('/api/devices/access') as PhoneAccessStatus;

    if (generation === epoch) {
      access.value = result;
    }
  } catch {
    if (generation === epoch) {
      error.value = t('settings.phoneStatusUnavailable');
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
  gap: 16px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.server-access p, .server-access h3 {
  margin: 0;
}
</style>
