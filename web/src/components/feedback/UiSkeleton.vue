<template>
  <span class="ui-skeleton" :data-shape="shape" data-ui-skeleton aria-hidden="true"
        :style="{ width, height }" />
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  shape?: 'line' | 'block' | 'circle';
  width?: string;
  height?: string;
}>(), {
  shape: 'line',
  width: undefined,
  height: undefined,
});
</script>
