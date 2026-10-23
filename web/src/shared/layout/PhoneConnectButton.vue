<template>
  <UiButton
    :disabled="!auth.authenticated || !auth.ready || (shell.present && shell.status !== 'online')"
    @click="phone.start()"
  >
    {{ t('settings.connectPhone') }}
  </UiButton>
</template>

<script setup lang="ts">
import { UiButton, t } from '../../ui.ts';
import { useAuthStore } from '../../stores/auth.ts';
import { useShellStore } from '../../stores/shell.ts';
import { usePhoneAccessStore } from '../../stores/phoneAccess.ts';

const auth = useAuthStore();
const shell = useShellStore();
const phone = usePhoneAccessStore();
</script>
