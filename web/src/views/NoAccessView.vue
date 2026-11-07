<template>
  <ConnectionRecovery v-if="shell.unavailable" full />
  <main v-else class="no-access" data-ui-touch>
    <section class="no-access-card">
      <span class="no-access-symbol" aria-hidden="true"><MachineGlyph name="offline" /></span>
      <span class="no-access-brand">GrigDesk</span>
      <h1>{{ t('core.noAccess') }}</h1>
      <p>{{ t('core.grigdeskOpensInTheApplication') }}</p>
      <p>{{ t('core.closeAndRestartTheApplicationItWill') }}</p>
      <UiButton block wrap variant="solid" tone="accent" :disabled="busy" :loading="busy" @click="check">
        {{ t('core.connectionConnectNow') }}
      </UiButton>
    </section>
  </main>
</template>

<script setup lang="ts">
import { ref } from 'vue';

import { t, UiButton } from '../ui.ts';
import { useShellStore } from '../stores/shell.ts';
import { useAuthStore } from '../stores/auth.ts';
import MachineGlyph from '../shared/layout/MachineGlyph.vue';
import ConnectionRecovery from '../shared/layout/ConnectionRecovery.vue';

const shell = useShellStore();
const auth = useAuthStore();
const busy = ref(false);

/**
 * Человек может повторно обнаружить оболочку без закрытия приложения и потери страницы.
 * Проверка входа читает только состояние; локальные ключи и сертификаты остаются у оболочки.
 */
async function check(): Promise<void> {
  if (busy.value) {
    return;
  }

  busy.value = true;

  try {
    shell.stop();
    await shell.start();

    if (!shell.present) {
      await auth.load('manual-retry');
    }
  } finally {
    busy.value = false;
  }
}

defineOptions({ name: 'NoAccessView' });
</script>

<style scoped>
.no-access {
  display: grid;
  min-height: 100dvh;
  place-items: center;
  padding: max(24px, env(safe-area-inset-top)) 20px max(24px, env(safe-area-inset-bottom));
}

.no-access-card {
  display: grid;
  justify-items: center;
  gap: 18px;
  width: min(100%, 360px);
  padding: 28px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  text-align: center;
}

.no-access-symbol {
  display: grid;
  place-items: center;
  width: 56px;
  height: 56px;
  border-radius: var(--radius);
  color: var(--warn);
  background: color-mix(in srgb, var(--warn) 10%, var(--surface));
}

.no-access-brand {
  color: var(--ink-low);
  font-size: 12px;
  letter-spacing: 0.08em;
}

.no-access-card h1 {
  margin: 0;
  font-size: 24px;
  font-weight: 600;
}

.no-access-card p {
  margin: 0;
  color: var(--ink-mid);
  font-size: 13px;
  line-height: 1.7;
}
</style>
