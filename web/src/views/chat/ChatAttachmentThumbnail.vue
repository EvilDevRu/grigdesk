<template>
  <a class="attachment-thumbnail" :href="src || undefined" target="_blank" rel="noopener"
     :aria-label="name || t('core.chatIzobrazhenie')" :aria-description="statusLabel"
     v-tooltip="name">
    <UiSkeleton v-if="imageLoaded === null" class="attachment-skeleton" shape="block" height="100%" />
    <span v-if="statusLabel" class="attachment-status" aria-hidden="true">{{ statusLabel }}</span>
    <img v-if="src" :src="src" :alt="name" :class="{ 'is-ready': imageLoaded }"
         @load="imageLoaded = true" @error="imageLoaded = false" />
  </a>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { t, UiSkeleton, vTooltip } from '../../ui';

const props = defineProps<{
  src: string;
  name?: string;
}>();

const imageLoaded = ref<boolean | null>(props.src ? null : false);

const statusLabel = computed(() => {
  if (imageLoaded.value) {
    return undefined;
  }

  return imageLoaded.value === null
    ? t('core.chatAttachmentImageLoading')
    : t('core.chatIzobrazhenieNedostupno');
});
</script>

<style scoped>
.attachment-thumbnail {
  position: relative;
  display: block;
  align-self: flex-start;
  width: min(220px, 62vw);
  max-width: 100%;
  min-width: 0;
  aspect-ratio: 11 / 8;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 10px;
  cursor: zoom-in;
}
.attachment-thumbnail img,
.attachment-skeleton,
.attachment-status {
  position: absolute;
  inset: 0;
}
.attachment-skeleton {
  border-radius: 0;
}
.attachment-thumbnail img {
  width: 100%;
  height: 100%;
  object-fit: scale-down;
  visibility: hidden;
}
.attachment-thumbnail .is-ready {
  visibility: visible;
}
.attachment-status {
  display: grid;
  place-items: center;
  padding: 4px;
  color: var(--ink-mid);
  font-size: 12px;
  overflow-wrap: anywhere;
  text-align: center;
}
</style>
