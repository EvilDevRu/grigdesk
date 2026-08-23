<template>
  <div
    class="ui-form-actions"
    :class="[`ui-form-actions--${align}`, { 'ui-form-actions--stack': stack }]"
  >
    <slot />
  </div>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    align?: 'start' | 'end' | 'between';
    stack?: boolean;
  }>(),
  { align: 'end', stack: false },
);
defineSlots<{ default(): unknown }>();
</script>
