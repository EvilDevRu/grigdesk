<template>
  <span class="mobile-chip" :data-tone="tone"><slot /></span>
</template>

<script setup lang="ts">
defineProps<{ tone?: 'good' | 'warn' | 'bad' | 'accent' | 'idle' }>();
</script>
