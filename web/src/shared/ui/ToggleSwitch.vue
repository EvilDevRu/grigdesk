<template>
  <UiSwitch
    v-model="model"
    :disabled="disabled"
  >{{ label }}</UiSwitch>
</template>

<script setup lang="ts">
import { UiSwitch } from '../../ui';

withDefaults(defineProps<{
  label?: string;
  disabled?: boolean;
}>(), { label: '', disabled: false });
const model = defineModel<boolean>({ required: true });
</script>
