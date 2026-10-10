<template>
  <button
    class="ui-button"
    type="button"
    :data-tone="kind"
    :data-variant="variant"
    :disabled="busy || disabled"
    :aria-busy="busy"
    @click="$emit('click', $event)"
  >
    <slot />
  </button>
</template>

<script setup lang="ts">
defineProps<{
  kind?: 'default' | 'primary' | 'danger';
  variant?: 'solid' | 'ghost';
  busy?: boolean;
  disabled?: boolean;
}>();
defineEmits<{ click: [event: MouseEvent] }>();
</script>
