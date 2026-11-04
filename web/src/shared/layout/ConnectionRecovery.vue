<template>
  <section v-if="visible" class="connection-recovery" :class="{ 'connection-recovery--full': full }"
           data-connection-recovery data-ui-touch>
    <div class="recovery-card">
      <span class="recovery-symbol" aria-hidden="true"><MachineGlyph name="offline" /></span>
      <div class="recovery-copy">
        <strong role="status">{{ title }}</strong>
        <p>{{ t('core.connectionRecoveryHint') }}</p>
        <span v-if="seconds > 0">{{ t('core.machineRetryCountdown', { seconds }) }}</span>
        <span v-else>{{ t('core.connectionTrying') }}</span>
      </div>
      <UiButton wrap :disabled="busy" :loading="busy" @click="connect">
        {{ t('core.connectionConnectNow') }}
      </UiButton>
      <UiInlineMessage v-if="error" class="recovery-error" tone="danger">{{ error }}</UiInlineMessage>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';

import { UiButton, UiInlineMessage, t } from '../../ui.ts';
import { useAuthStore } from '../../stores/auth.ts';
import { useShellStore } from '../../stores/shell.ts';
import { reconnectSse, sseRecovering, sseRetryAt } from '../../composables/useSse.ts';
import { failureText } from '../apiClient.ts';
import MachineGlyph from './MachineGlyph.vue';

withDefaults(defineProps<{ full?: boolean }>(), { full: false });

const shell = useShellStore();
const auth = useAuthStore();
const now = ref(Date.now());
const submitting = ref(false);
const error = ref('');
const disconnected = computed(() => typeof shell.detail === 'object'
  && shell.detail?.code === 'disconnected');
const transportLost = computed(() => shell.present && shell.profile && !disconnected.value
  && ['offline', 'connecting'].includes(shell.status));
const updatesLost = computed(() => shell.status === 'online' && auth.authenticated && sseRecovering.value);
const authLost = computed(() => shell.status === 'online' && auth.recovering);
const visible = computed(() => shell.unavailable || transportLost.value || authLost.value
  || updatesLost.value);
const retryAt = computed(() => {
  if (shell.unavailable) {
    return shell.retryAt;
  }
  if (transportLost.value) {
    return typeof shell.detail === 'object' ? shell.detail?.retryAt ?? 0 : 0;
  }

  return auth.retryAt || sseRetryAt.value;
});
const seconds = computed(() => Math.max(0, Math.ceil((retryAt.value - now.value) / 1000)));
const busy = computed(() => submitting.value || shell.status === 'connecting'
  || (shell.unavailable || updatesLost.value || authLost.value) && retryAt.value === 0);
const title = computed(() => updatesLost.value && !shell.unavailable
  ? t('core.connectionUpdatesPaused') : t('core.connectionRestoring'));
let clock: ReturnType<typeof setInterval> | undefined;

watch(visible, (shown) => {
  clearInterval(clock);
  now.value = Date.now();

  if (shown) {
    clock = setInterval(() => {
      now.value = Date.now();
    }, 1000);
  }
}, { immediate: true });

/**
 * Действие обращается к владельцу отказавшего уровня, пропуская только его ожидание.
 * POST сообщений не повторяется, дополнительный поток событий не создаётся.
 */
async function connect(): Promise<void> {
  if (busy.value) {
    return;
  }

  submitting.value = true;
  error.value = '';

  try {
    if (shell.unavailable) {
      shell.retryNow();
    } else if (transportLost.value) {
      await shell.connect();
    } else if (auth.retryAt > 0) {
      await auth.load('manual-retry');
    } else {
      reconnectSse();
    }
  } catch (cause) {
    error.value = failureText(cause, t('core.connectionRecoveryFailed'));
  } finally {
    submitting.value = false;
  }
}

onBeforeUnmount(() => clearInterval(clock));
</script>

<style scoped>
.connection-recovery {
  position: fixed;
  z-index: 30;
  top: calc(var(--app-topbar-h) + 10px);
  left: 50%;
  width: min(560px, calc(100% - 24px));
  transform: translateX(-50%);
}

.recovery-card {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 14px;
  border: 1px solid color-mix(in srgb, var(--warn) 38%, var(--line));
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: 0 8px 32px #0003;
}

.recovery-symbol {
  display: grid;
  place-items: center;
  flex: none;
  width: 40px;
  height: 40px;
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--warn) 10%, var(--surface));
  color: var(--warn);
}

.recovery-copy {
  flex: 1;
  min-width: 140px;
  overflow-wrap: anywhere;
}

.recovery-copy strong {
  font-size: 13px;
}

.recovery-copy p, .recovery-copy > span {
  margin: 5px 0 0;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.5;
}

.recovery-copy > span {
  display: block;
  color: var(--warn);
}

.recovery-error {
  width: 100%;
}

.connection-recovery--full {
  position: static;
  display: grid;
  place-items: center;
  width: 100%;
  min-height: 100dvh;
  padding: max(24px, env(safe-area-inset-top)) 20px;
  transform: none;
}

.connection-recovery--full .recovery-card {
  display: grid;
  justify-items: center;
  gap: 20px;
  width: min(100%, 380px);
  padding: 28px;
  text-align: center;
}

@media (max-width: 600px) {
  .connection-recovery {
    top: calc(var(--app-topbar-h) + var(--app-phone-status-h) + env(safe-area-inset-top) + 8px);
  }
}
</style>
