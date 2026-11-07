<template>
  <UiButton size="compact" @click="help.open('troubleshooting')">
    {{ t('core.helpTroubleshooting') }}
  </UiButton>
</template>

<script setup lang="ts">
import { UiButton, t } from '../../ui.ts';
import { useHelpStore } from '../../stores/help.ts';

const help = useHelpStore();
</script>
