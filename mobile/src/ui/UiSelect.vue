<template>
  <label class="mobile-field">
    <span v-if="label">{{ label }}</span>
    <select v-model="value" class="ui-input" :aria-label="label" :disabled="disabled">
      <option v-for="option in options" :key="option.value" :value="option.value" :disabled="option.disabled">
        {{ option.label }}
      </option>
    </select>
  </label>
</template>

<script setup lang="ts">
const value = defineModel<string>({ default: '' });

defineProps<{
  label: string;
  disabled?: boolean;
  options: Array<{
    value: string;
    label: string;
    disabled?: boolean;
  }>;
}>();
</script>
