<template>
  <UiField label="Имя" hint="Подсказка" :error="error" required>
    <UiInput v-model.trim="value" />
  </UiField>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { UiField, UiInput } from '../../../../../web/src/ui';

defineProps<{ error?: string }>();
const value = ref('');
</script>
