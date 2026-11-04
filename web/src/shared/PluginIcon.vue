<template>
  <img v-if="src && failed !== src" :src="src" alt="" aria-hidden="true" class="plugin-icon"
       @error="failed = src" />
  <svg v-else class="plugin-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path :d="NAV_ICONS.plugin" />
  </svg>
</template>

<script setup lang="ts">
import { ref } from 'vue';

import { NAV_ICONS } from './navIcons.ts';

withDefaults(defineProps<{ src?: string | null }>(), { src: null });

const failed = ref<string | null | undefined>(null);
</script>

<style scoped>
/* Базовый размер находится в общем слое компонентов.
   Контексты реек и меню могут переопределять его без !important. */
@layer components {
  .plugin-icon {
    width: 24px;
    height: 24px;
    flex: 0 0 auto;
    object-fit: contain;
  }
}
</style>
