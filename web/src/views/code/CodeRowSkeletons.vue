<template>
  <div v-for="width in lineWidths" :key="width" class="code-row-placeholder" :class="kind" aria-hidden="true">
    <UiSkeleton v-if="kind === 'commits'" width="46px" />
    <template v-else>
      <UiSkeleton width="10px" height="9px" />
      <UiSkeleton v-if="kind === 'changes'" shape="block" width="14px" height="14px" />
    </template>
    <UiSkeleton :width="width" />
  </div>
</template>

<script setup lang="ts">
import { UiSkeleton } from '../../ui';

defineProps<{
  kind: 'files' | 'changes' | 'commits';
}>();

const lineWidths = ['42%', '59%', '34%', '51%', '46%', '38%'];
</script>

<style scoped>
.code-row-placeholder {
  display: flex;
  align-items: center;
  gap: 7px;
  padding-inline: 8px;
  min-height: 28px;
}
.code-row-placeholder.commits {
  gap: 8px;
  min-height: 24px;
}
</style>
