<template>
  <div class="ui-skeleton-layout" :data-layout="layout" aria-hidden="true">
    <UiSkeleton v-if="header" class="ui-skeleton-layout__header" width="40%" height="16px" />
    <div v-for="index in rows" :key="index" class="ui-skeleton-layout__row" data-loading-region="row">
      <UiSkeleton v-if="layout === 'list'" shape="circle" />
      <div class="ui-skeleton-layout__copy">
        <UiSkeleton :width="layout === 'form' ? '28%' : '72%'" />
        <UiSkeleton v-if="layout === 'form'" shape="block" height="var(--control-height, 32px)" />
        <UiSkeleton v-else :width="index % 2 ? '90%' : '54%'" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import UiSkeleton from './UiSkeleton.vue';

withDefaults(defineProps<{
  layout?: 'list' | 'form' | 'text';
  header?: boolean;
  rows?: number;
}>(), {
  layout: 'list',
  header: true,
  rows: 4,
});
</script>
