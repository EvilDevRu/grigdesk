<template>
  <span class="browser-site-icon" aria-hidden="true">
    <img v-if="favicon && !failed" :src="favicon" alt="" draggable="false" @error="failed = true" />
    <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
        stroke-linecap="round" stroke-linejoin="round" data-browser-tab-globe>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a16 16 0 0 1 0 18a16 16 0 0 1 0-18" />
    </svg>
  </span>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';

const props = defineProps<{ favicon: string | null }>();
const failed = ref(false);

watch(() => props.favicon, () => {
  failed.value = false;
});
</script>

<style scoped>
.browser-site-icon {
  display: inline-flex;
}

.browser-site-icon > img,
.browser-site-icon > svg {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
</style>
