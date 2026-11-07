<template>
  <header class="pane-head">
    <RouterLink v-if="back" :to="back" class="pane-back ui-icon-button" :aria-label="backLabel">
      <UiIcon name="back" />
    </RouterLink>
    <UiBrandMark v-if="brand" class="brand-mark pane-brand" />
    <div class="pane-title">
      <h1 :aria-label="title">{{ title }}</h1>
      <p v-if="sub" class="pane-sub" :aria-label="sub">{{ sub }}</p>
    </div>
    <div v-if="$slots.actions" class="pane-actions"><slot name="actions" /></div>
    <UiLinkStatus v-if="status" class="pane-status" />
    <div v-if="$slots.bottom" class="pane-head-bottom"><slot name="bottom" /></div>
  </header>
</template>

<script setup lang="ts">
import { RouterLink } from 'vue-router';

import UiBrandMark from './UiBrandMark.vue';
import UiIcon from './UiIcon.vue';
import UiLinkStatus from './UiLinkStatus.vue';

defineProps<{
  title: string;
  sub?: string;
  back?: string;
  backLabel?: string;
  brand?: boolean;
  status?: boolean;
}>();
</script>
