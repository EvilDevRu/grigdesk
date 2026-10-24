<template>
  <article v-if="shell.profile" class="machine-connection" :data-recovery="recovery">
    <div v-if="!recovery" class="machine-current">
      <span>{{ t('core.machineCurrentMachine') }}</span>
      <MachineGlyph name="check" />
    </div>
    <div class="machine-summary">
      <span class="machine-icon"><MachineGlyph name="machine" /></span>
      <div class="machine-copy">
        <strong>{{ machineProfileName(shell.profile, uiLocale) }}</strong>
        <ConnectionStatus :status="shell.status" :disconnected="disconnected"
                          :text="disconnected ? t('core.disconnected') : online
                            ? t('core.machineConnected') : undefined" />
      </div>
      <UiIconButton :label="t('core.machineMachineSettings', {
                      name: machineProfileName(shell.profile, uiLocale),
                    })" :disabled="busy" @click="$emit('menu')">
        <MachineGlyph name="more" />
      </UiIconButton>
    </div>

    <template v-if="recovery">
      <section class="machine-recovery" :data-terminal="terminal" role="status">
        <div class="machine-recovery-title">
          <MachineGlyph :name="shell.status === 'connecting' ? 'refresh' : 'offline'" />
          <h2>{{ recoveryTitle }}</h2>
        </div>
        <p>{{ recoveryHint }}</p>
        <p v-if="detailText && detailText !== recoveryHint && !genericOffline"
           class="machine-reason">{{ detailText }}</p>
        <div v-if="retrySeconds > 0 && !disconnected" class="machine-retry">
          <MachineGlyph name="refresh" />
          {{ t('core.machineRetryCountdown', { seconds: retrySeconds }) }}
        </div>
      </section>
    </template>
    <p v-else-if="online" class="machine-safe">
      <MachineGlyph name="lock" />
      {{ shell.profile.kind === 'local' ? t('core.localMachine') : t('core.machineSecure') }}
    </p>

    <div class="machine-primary-actions">
      <UiButton v-if="online" block wrap variant="solid" tone="accent" :disabled="busy"
                @click="$emit('open')">
        {{ t('core.machineOpenWork') }}
        <template #trailing><MachineGlyph name="arrow" /></template>
      </UiButton>
      <UiButton v-else-if="needsPairing" block wrap variant="solid" tone="accent" :disabled="busy"
                @click="$emit('add')">
        {{ t('core.machinePairAgain') }}
      </UiButton>
      <UiButton v-else-if="shell.status === 'locked' && shell.capabilities.includes('unlock')"
                block wrap variant="solid" tone="accent" :disabled="busy" @click="$emit('unlock')">
        {{ t('core.machineUnlock') }}
      </UiButton>
      <UiButton v-else-if="!terminal" block wrap variant="solid" tone="accent"
                :disabled="busy || shell.status === 'connecting'" :loading="busy"
                @click="$emit('connect')">
        <template #leading><MachineGlyph name="refresh" /></template>
        {{ shell.status === 'connecting' ? connectionStatusText(shell.status, uiLocale) : disconnected
          ? t('core.connect') : t('core.machineRetryNow') }}
      </UiButton>
      <UiButton v-if="recovery" block wrap :disabled="busy" @click="$emit('list')">
        {{ t('core.machineChooseAnother') }}
      </UiButton>
    </div>

    <template v-if="recovery">
      <p v-if="!terminal && !disconnected" class="machine-safe machine-saved">
        <MachineGlyph name="lock" />{{ t('core.machinePairingSaved') }}
      </p>
      <UiDisclosureButton v-model:open="detailsOpen" :controls="detailsId" block wrap
                          data-context="machine-connection-details">
        {{ t('core.machineConnectionSettings') }}
      </UiDisclosureButton>
      <div v-if="detailsOpen" :id="detailsId" class="machine-details">
        <span>{{ t('core.machineAddress') }}</span>
        <span class="machine-address">{{ shell.profile.kind === 'local' ? t('core.localMachine')
          : shell.profile.address || t('core.relayAddress') }}</span>
        <UiButton v-if="shell.profile.kind === 'remote'" variant="text" :disabled="busy"
                  @click="$emit('address')">{{ t('core.changeAddress') }}</UiButton>
      </div>
    </template>
  </article>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue';
import { UiButton, UiDisclosureButton, UiIconButton, t, uiLocale } from '../../ui.ts';
import { connectionDetailText, connectionStatusText, machineProfileName }
  from '../../../../shared/client/clientShell.ts';
import { useShellStore } from '../../stores/shell.ts';
import ConnectionStatus from './ConnectionStatus.vue';
import MachineGlyph from './MachineGlyph.vue';

defineProps<{ recovery: boolean; busy: boolean }>();
defineEmits<{
  menu: [];
  open: [];
  connect: [];
  add: [];
  unlock: [];
  list: [];
  address: [];
}>();

const shell = useShellStore();
const detailsOpen = ref(false);
const detailsId = `machine-details-${useId()}`;
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | undefined;

const online = computed(() => shell.status === 'online');
const disconnected = computed(() => typeof shell.detail !== 'string'
  && shell.detail?.code === 'disconnected');
const needsPairing = computed(() => ['unpaired', 'revoked', 'identityMismatch'].includes(shell.status));
const terminal = computed(() => needsPairing.value || ['incompatible', 'locked'].includes(shell.status));
const detailText = computed(() => disconnected.value
  ? '' : connectionDetailText(shell.detail, uiLocale.value));
const genericOffline = computed(() => typeof shell.detail === 'object' && shell.detail?.code === 'offline');
const retrySeconds = computed(() => {
  const retryAt = typeof shell.detail === 'object' ? shell.detail?.retryAt : undefined;

  return retryAt ? Math.max(0, Math.ceil((retryAt - now.value) / 1000)) : 0;
});
const recoveryTitle = computed(() => {
  if (disconnected.value) {
    return t('core.machineDisconnectedTitle');
  }

  return shell.status === 'offline' ? t('core.machineUnavailable')
    : connectionStatusText(shell.status, uiLocale.value);
});
const recoveryHint = computed(() => {
  if (disconnected.value) {
    return t('core.machineDisconnectedHint');
  }
  if (shell.status === 'connecting') {
    return t('core.machineConnectingHint');
  }
  if (terminal.value) {
    return detailText.value || t('core.machineAccessHint');
  }

  return t('core.machineOfflineHint');
});

onMounted(() => {
  clock = setInterval(() => {
    now.value = Date.now();
  }, 1000);
});

onBeforeUnmount(() => clearInterval(clock));
</script>

<style scoped>
.machine-connection {
  padding: 18px;
  border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--line));
  border-radius: 16px;
  background: color-mix(in srgb, var(--accent) 7%, var(--ground));
}

.machine-connection[data-recovery='true'] {
  padding: 0;
  border: 0;
  background: transparent;
}

.machine-current {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
  color: var(--accent);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 1px;
  text-transform: uppercase;
}

.machine-current svg {
  width: 16px;
  height: 16px;
}

.machine-summary {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.machine-icon {
  display: grid;
  place-items: center;
  flex: none;
  width: 44px;
  height: 44px;
  border-radius: 12px;
  background: var(--surface-2);
  color: var(--ink-mid);
}

.machine-icon svg {
  width: 25px;
  height: 25px;
}

.machine-copy {
  display: grid;
  flex: 1;
  gap: 5px;
  min-width: 0;
}

.machine-copy strong {
  font-size: 16px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.machine-safe {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 20px 0 14px;
  color: var(--ink-mid);
  font-size: 12px;
}

.machine-safe svg {
  width: 15px;
  height: 15px;
}

.machine-primary-actions {
  display: grid;
  gap: 10px;
}

.machine-summary + .machine-primary-actions {
  margin-top: 20px;
}

.machine-connection[data-recovery='true'] .machine-summary {
  padding: 6px 0 22px;
  border-bottom: 1px solid var(--line);
}

.machine-recovery {
  margin: 24px 0 20px;
  padding: 18px;
  border: 1px solid color-mix(in srgb, var(--warn) 38%, var(--line));
  border-radius: 14px;
  background: color-mix(in srgb, var(--warn) 8%, var(--ground));
  color: var(--warn);
}

.machine-recovery-title {
  display: flex;
  align-items: center;
  gap: 10px;
}

.machine-recovery-title h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.machine-recovery p {
  margin: 12px 0 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--ink-mid);
  overflow-wrap: anywhere;
}

.machine-retry {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
  font-size: 12px;
  line-height: 1.6;
}

.machine-retry svg {
  width: 16px;
  height: 16px;
}

.machine-saved {
  justify-content: center;
  margin: 16px 0 24px;
}

.machine-details {
  display: grid;
  gap: 9px;
  padding: 12px 0;
  color: var(--ink-mid);
  font-size: 12px;
}

.machine-address {
  color: var(--ink);
  overflow-wrap: anywhere;
}
</style>
