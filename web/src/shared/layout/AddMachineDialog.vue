<template>
  <UiDialog :open="open" :title="t('core.addMachine')" size="compact" :busy="busy"
            :dismissible="!submitting" data-role="add-machine" @update:open="$emit('update:open', $event)">
    <template #title>
      <span class="pair-machine-title">
        <span>{{ t('core.addMachine') }}</span>
        <UiIconButton :label="t('settings.close')" :disabled="submitting"
                      @click="$emit('update:open', false)"><MachineGlyph name="close" /></UiIconButton>
      </span>
    </template>
    <div class="pair-machine">
      <p class="pair-machine-intro">{{ t('core.machineAddIntro') }}</p>
      <section v-if="canScan && !pairing" class="pair-machine-scan">
        <div class="pair-machine-illustration"><MachineGlyph name="qr" /></div>
        <h2>{{ t('core.machineScanTitle') }}</h2>
        <p>{{ t('core.machineScanHint') }}</p>
        <UiButton block wrap variant="solid" tone="accent" :loading="scanning" :disabled="busy" @click="scan">
          <template #leading><MachineGlyph name="scan" /></template>
          {{ t('core.scanQRCode') }}
        </UiButton>
      </section>
      <UiInlineMessage v-if="pairing && !manual" tone="success">
        {{ t('core.machineCodeReady') }}
      </UiInlineMessage>
      <div class="pair-machine-instructions">
        <MachineGlyph name="machine" />
        <div>
          <strong>{{ t('core.machineWhereCode') }}</strong>
          <p>{{ t('core.machineCodeLocation') }}</p>
        </div>
      </div>
      <template v-if="canScan && !manual">
        <div class="pair-machine-separator"><span>{{ t('core.machineOr') }}</span></div>
        <UiButton block wrap :disabled="busy" @click="manual = true">
          <template #leading><MachineGlyph name="paste" /></template>
          {{ t('core.machinePastePairing') }}
        </UiButton>
        <p class="pair-machine-paste-hint">{{ t('core.machinePasteHint') }}</p>
      </template>
      <UiField v-if="manual" :label="t('settings.pairingString')" :hint="t('core.pairingLifetime')">
        <UiTextarea v-model="pairing" :placeholder="pairingPlaceholder" :disabled="busy"
                    :rows="3" spellcheck="false" autocomplete="off" />
      </UiField>
      <UiInlineMessage v-if="error" tone="danger">{{ error }}</UiInlineMessage>
    </div>
    <template #footer>
      <div class="pair-machine-footer">
        <UiButton v-if="manual || pairing" block wrap variant="solid" tone="accent" :loading="submitting"
                  :disabled="busy || !pairing.trim()" @click="add">{{ t('core.add') }}</UiButton>
        <p><MachineGlyph name="lock" />{{ t('core.machinePairOnce') }}</p>
      </div>
    </template>
  </UiDialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { UiDialog, UiButton, UiIconButton, UiField, UiTextarea, UiInlineMessage, t } from '../../ui.ts';
import { useShellStore } from '../../stores/shell.ts';
import { failureText } from '../apiClient.ts';
import MachineGlyph from './MachineGlyph.vue';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ 'update:open': [value: boolean] }>();
const shell = useShellStore();
const pairing = ref('');
const error = ref('');
const submitting = ref(false);
const scanning = ref(false);
const manual = ref(false);
let generation = 0;

const busy = computed(() => submitting.value || scanning.value);
const canScan = computed(() => shell.capabilities.includes('scan'));
const pairingPlaceholder = computed(() => canScan.value
  ? t('core.pairingStringPlaceholder') : t('core.desktopPairingPlaceholder'));

watch(() => props.open, () => {
  generation += 1;
  pairing.value = '';
  error.value = '';
  submitting.value = false;
  scanning.value = false;
  manual.value = !canScan.value;
}, { immediate: true });

/**
 * Секретная строка передаётся только оболочке и очищается после любой попытки.
 * Ответ прежнего открытия не закрывает новую форму и не меняет её состояние.
 */
async function add(): Promise<void> {
  if (busy.value || !pairing.value.trim()) {
    return;
  }

  const epoch = generation;

  submitting.value = true;
  error.value = '';

  try {
    await shell.addMachine(pairing.value.trim());

    if (props.open && generation === epoch) {
      emit('update:open', false);
    }
  } catch (failure) {
    if (props.open && generation === epoch) {
      error.value = failureText(failure, t('core.couldNotAddTheMachine'));
    }
  } finally {
    if (generation === epoch) {
      pairing.value = '';
      submitting.value = false;
    }
  }
}

/**
 * Сканер принадлежит Android; повторное нажатие не запускает вторую Activity.
 * Поздний результат после закрытия или нового открытия не сохраняет секрет в новой форме.
 */
async function scan(): Promise<void> {
  if (busy.value) {
    return;
  }

  const epoch = generation;

  scanning.value = true;
  error.value = '';

  try {
    const result = await shell.scan();

    if (props.open && generation === epoch) {
      pairing.value = result.pairing;
    }
  } catch (failure) {
    if (props.open && generation === epoch) {
      error.value = failureText(failure, t('core.couldNotReadTheQRCode'));
    }
  } finally {
    if (generation === epoch) {
      scanning.value = false;
    }
  }
}
</script>

<style scoped>
.pair-machine-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.pair-machine-title > span {
  min-width: 0;
  overflow-wrap: anywhere;
}

.pair-machine {
  display: grid;
  gap: 20px;
}

.pair-machine-intro {
  margin: 0;
  color: var(--ink-mid);
  font-size: 13px;
  line-height: 1.7;
}

.pair-machine-scan {
  padding: 24px 18px 18px;
  border: 1px solid var(--line);
  border-radius: 16px;
  background: var(--sidebar);
  text-align: center;
}

.pair-machine-illustration {
  position: relative;
  display: grid;
  place-items: center;
  width: 112px;
  height: 108px;
  margin: 0 auto 20px;
  border: 2px solid color-mix(in srgb, var(--accent) 80%, var(--line));
  border-radius: 16px;
  color: var(--ink-mid);
}

.pair-machine-illustration::after {
  content: '';
  position: absolute;
  right: 8px;
  left: 8px;
  top: 50%;
  height: 1px;
  background: var(--accent);
  box-shadow: 0 0 12px var(--accent);
}

.pair-machine-illustration svg {
  width: 64px;
  height: 64px;
}

.pair-machine-scan h2 {
  margin: 0 0 8px;
  font-size: 16px;
  font-weight: 600;
  line-height: 1.6;
}

.pair-machine-scan p {
  margin: 0 0 20px;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.8;
}

.pair-machine-instructions {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.pair-machine-instructions > svg {
  margin-top: 3px;
  color: var(--ink-mid);
}

.pair-machine-instructions strong {
  font-size: 13px;
  font-weight: 500;
}

.pair-machine-instructions p {
  margin: 6px 0 0;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.8;
}

.pair-machine-separator {
  display: flex;
  align-items: center;
  gap: 14px;
  color: var(--ink-low);
  font-size: 12px;
}

.pair-machine-separator::before, .pair-machine-separator::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--line);
}

.pair-machine-paste-hint {
  margin: -12px 0 0;
  color: var(--ink-mid);
  font-size: 11px;
  line-height: 1.7;
  text-align: center;
}

.pair-machine-footer {
  display: grid;
  gap: 16px;
  width: 100%;
}

.pair-machine-footer p {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  margin: 0;
  color: var(--ink-mid);
  font-size: 11px;
  line-height: 1.7;
}

.pair-machine-footer svg {
  width: 14px;
  height: 14px;
}
</style>
