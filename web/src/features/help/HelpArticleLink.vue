<template>
  <UiButton size="compact" :variant="variant" wrap @click="help.open('troubleshooting')">
    {{ t('core.helpTroubleshooting') }}
  </UiButton>
</template>

<script setup lang="ts">
import { UiButton, t } from '../../ui.ts';
import type { UiActionVariant } from '../../ui.ts';
import { useHelpStore } from '../../stores/help.ts';

defineProps<{
  variant?: UiActionVariant;
}>();

const help = useHelpStore();
</script>
