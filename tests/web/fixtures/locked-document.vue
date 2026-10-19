<template>
  <UiDialog open layer="document" title="Документ" @update:open="closed" />
  <LockOverlay />
</template>

<script setup>
import { UiDialog } from '../../../web/src/ui.ts';
import LockOverlay from '../../../web/src/shared/layout/LockOverlay.vue';

const closed = () => globalThis.__reviewClosed += 1;
</script>
