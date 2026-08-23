<template>
  <div
    class="ui-control-group"
    :class="{ 'ui-control-group--block': block }"
    role="group"
    :aria-label="label"
  >
    <slot />
  </div>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ label?: string; block?: boolean }>(), {
  label: undefined,
  block: false,
});
defineSlots<{ default(): unknown }>();
</script>
