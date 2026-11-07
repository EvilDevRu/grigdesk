<template>
  <div data-testid="packaged-server-version">
    <p>{{ t('settings.serverVersion') }} <b>{{ version }}</b></p>
    <p>{{ t('settings.applicationInterface') }} {{ clientVersion }}</p>
    <p>{{ message }}</p>
  </div>
</template>

<script setup lang="ts">
import { t } from '../../ui.ts';

defineProps<{
  version: string;
  clientVersion: string;
  message: string;
}>();
</script>
