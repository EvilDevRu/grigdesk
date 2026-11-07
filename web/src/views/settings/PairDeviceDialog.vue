<template>
  <UiDialog :open="open" :title="t('settings.addDevice')" :busy="busy" @update:open="$emit('update:open', $event)">
    <template v-if="!pairing">
      <UiField v-if="!draft" :label="t('settings.deviceName')">
        <UiInput v-model="name" :placeholder="t('settings.forExampleTablet')" :disabled="busy" />
      </UiField>
      <UiField v-if="!draft" :label="t('settings.machineAddressOptional')">
        <UiInput v-model="address" :placeholder="t('settings.forExampleDeskExample')" :disabled="busy" />
      </UiField>
      <p>{{ t('settings.forASharedConnectionAddressEnterA') }}</p>
    </template>
    <template v-else>
      <img :src="qrUrl" :alt="t('settings.pairingQRCode')" class="pairing-qr" />
      <UiField :label="t('settings.pairingString')">
        <UiTextarea :model-value="pairing.text" readonly />
      </UiField>
      <p role="status">{{ seconds > 0 ? t('settings.sLeftSingleUse', { seconds: seconds }) : t('settings.codeExpired') }}</p>
    </template>
    <UiInlineMessage v-if="error" tone="danger">{{ error }}</UiInlineMessage>
    <template #footer>
      <UiButton v-if="!pairing || seconds === 0" :disabled="busy || !name.trim()" @click="issue">
        {{ pairing ? t('settings.newCode') : t('settings.getCode') }}
      </UiButton>
      <UiButton variant="text" @click="$emit('update:open', false)">{{ t('settings.close') }}</UiButton>
    </template>
  </UiDialog>
</template>

<script setup lang="ts">
import { t } from '../../ui.ts';

import { computed, onBeforeUnmount, ref, watch } from 'vue';

import { errorMessage } from '../../../../shared/lib/errors.ts';
import { UiButton, UiDialog, UiField, UiInput, UiTextarea, UiInlineMessage } from '../../ui.ts';
import { api } from '../../shared/apiClient.ts';

interface PairingResult {
  text: string;
  svg: string;
  expiresAt: number;
  expiresInMs?: number;
}

const props = defineProps<{ open: boolean; draft?: { name: string; address: string } }>();
const localName = ref('');
const localAddress = ref('');
const name = computed({
  get: () => props.draft?.name ?? localName.value,
  set: (value: string) => {
    if (props.draft) {
      props.draft.name = value;
    } else {
      localName.value = value;
    }
  },
});
const address = computed({
  get: () => props.draft?.address ?? localAddress.value,
  set: (value: string) => localAddress.value = value,
});
const error = ref('');
const busy = ref(false);
const pairing = ref<PairingResult | null>(null);
const now = ref(performance.now());
const expiry = ref(0);
const seconds = computed(() => Math.max(0, Math.ceil((expiry.value - now.value) / 1000)));
const qrUrl = computed(() => `data:image/svg+xml,${encodeURIComponent(pairing.value?.svg ?? '')}`);
let generation = 0;
let timer: ReturnType<typeof setInterval> | null = null;

watch(() => props.open, (open) => {
  generation += 1;
  busy.value = false;

  if (timer) {
    clearInterval(timer);
    timer = null;
  }

  pairing.value = null;
  error.value = '';

  if (open) {
    timer = setInterval(() => now.value = performance.now(), 1000);
  } else {
    localName.value = '';
    localAddress.value = '';
  }
});
onBeforeUnmount(() => {
  generation += 1;

  if (timer) {
    clearInterval(timer);
  }
});

/**
 * Код создаётся только после явного запроса; строка и SVG не отправляются в журнал.
 * При закрытии диалога поздний ответ не возвращает секрет на экран.
 */
async function issue(): Promise<void> {
  const epoch = generation;

  busy.value = true;
  error.value = '';

  try {
    const body = { name: name.value, ...(address.value.trim() ? { address: address.value.trim() } : {}) };
    const result = await api.post('/api/devices/pairing', body) as PairingResult;

    if (props.open && generation === epoch) {
      pairing.value = result;
      now.value = performance.now();
      expiry.value = now.value + Math.max(0, result.expiresInMs ?? 600000);
    }
  } catch (cause) {
    if (!props.open || generation !== epoch) {
      return;
    }

    const code = (cause as { data?: { error?: string } } | null)?.data?.error;

    error.value = code === 'client_listener_off'
      ? t('settings.networkAccessIsDisabledSetGRIGDESKCLIENT')
      : errorMessage(cause, t('settings.couldNotGetAPairingCode'));
  } finally {
    if (generation === epoch) {
      busy.value = false;
    }
  }
}
</script>

<style scoped>
.pairing-qr {
  display: block;
  width: min(100%, 320px);
  margin: 12px auto;
}
</style>
