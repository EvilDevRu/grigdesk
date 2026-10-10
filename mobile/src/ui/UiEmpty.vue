<template>
  <div class="mobile-empty">
    <UiIcon v-if="icon" :name="icon" />
    <p class="mobile-empty-title">{{ text }}</p>
    <slot />
  </div>
</template>

<script setup lang="ts">
import type { IconName } from './icons.ts';
import UiIcon from './UiIcon.vue';

defineProps<{
  text: string;
  icon?: IconName;
}>();
</script>
