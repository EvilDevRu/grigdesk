<template>
  <label class="mobile-field">
    <span v-if="label">{{ label }}</span>
    <textarea
      v-if="multiline"
      v-model="value"
      class="ui-textarea"
      :rows="rows || 3"
      :placeholder="placeholder"
      :disabled="disabled"
      :maxlength="maxLength"
    />
    <input
      v-else
      v-model="value"
      class="ui-input"
      :type="type || 'text'"
      :placeholder="placeholder"
      :disabled="disabled"
      :maxlength="maxLength"
    />
  </label>
</template>

<script setup lang="ts">
const value = defineModel<string>({
  default: '',
  set(value) {
    return String(value ?? '');
  },
});

defineProps<{
  label?: string;
  multiline?: boolean;
  rows?: number;
  placeholder?: string;
  disabled?: boolean;
  maxLength?: number;
  type?: string;
}>();
</script>
