<template>
  <RouterLink
    :to="to"
    class="mobile-list-row"
    :class="{ 'is-current': current }"
    :aria-label="label"
    :aria-current="current ? 'page' : undefined"
  >
    <span v-if="$slots.lead" class="mobile-row-lead"><slot name="lead" /></span>
    <span class="mobile-row-content"><slot /></span>
    <span v-if="$slots.aside" class="mobile-row-aside"><slot name="aside" /></span>
  </RouterLink>
</template>

<script setup lang="ts">
import { RouterLink } from 'vue-router';

defineProps<{
  to: string;
  label?: string;
  current?: boolean;
}>();
</script>
