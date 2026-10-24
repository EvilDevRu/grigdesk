<template>
  <UiIconButton
    variant="link"
    role="rail"
    data-context="topbar-action"
    :label="t('settings.connectPhone')"
    v-tooltip="t('settings.connectPhone')"
    aria-haspopup="dialog"
    :disabled="!auth.authenticated || !auth.ready || (shell.present && shell.status !== 'online')"
    @click="phone.start()"
  >
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M2 8V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6
               M2 12a10 10 0 0 1 10 10 M2 16a6 6 0 0 1 6 6 M2 20a2 2 0 0 1 2 2" />
    </svg>
  </UiIconButton>
</template>

<script setup lang="ts">
import { UiIconButton, t, vTooltip } from '../../ui.ts';
import { useAuthStore } from '../../stores/auth.ts';
import { useShellStore } from '../../stores/shell.ts';
import { usePhoneAccessStore } from '../../stores/phoneAccess.ts';

const auth = useAuthStore();
const shell = useShellStore();
const phone = usePhoneAccessStore();
</script>
