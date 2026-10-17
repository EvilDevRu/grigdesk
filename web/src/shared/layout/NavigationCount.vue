<template>
  <span v-if="badge && badge.n > 0" class="navigation-count" :class="badge.kind"
        role="status" :aria-label="badge.title">
    <span class="navigation-count-text" aria-hidden="true">{{ badge.n > 999 ? '999+' : badge.n }}</span>
  </span>
</template>

<script setup lang="ts">
defineProps<{
  badge?: {
    n: number;
    kind: string;
    title: string;
  } | null;
}>();
</script>

<style scoped>
/* Обе рейки используют одну строку под иконкой: без полей 999+ входит в 30 px.
   Полное число остаётся в доступном имени и подсказке родительской кнопки. */
.navigation-count {
  display: grid;
  place-items: center;
  max-width: var(--app-nav-row-h);
  height: 11px;
  color: var(--accent);
  font-size: 9px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  white-space: nowrap;
}
.navigation-count-text {
  display: block;
  text-box-trim: trim-both;
  text-box-edge: cap alphabetic;
}
.navigation-count.wait { color: var(--warn); }
.navigation-count.stall { color: var(--bad); }
</style>
